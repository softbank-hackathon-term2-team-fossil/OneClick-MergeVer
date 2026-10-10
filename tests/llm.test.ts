import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const openAi = vi.hoisted(() => ({
  create: vi.fn(async () => ({ output_text: "FROM python:3.12-slim\nCMD [\"python\", \"main.py\"]" })),
}));

vi.mock("server-only", () => ({}));
vi.mock("openai", () => ({
  default: class {
    responses = { create: openAi.create };
  },
}));

import {
  DEFAULT_GEMINI_MODEL,
  extractChatText,
  GEMINI_ENDPOINT,
  generateWithGemini,
  readGeminiSettings,
} from "../lib/llm-gemini";
import { generateText, geminiEnvironment, resolveProvider } from "../lib/llm";

const request = { instructions: "Write a Dockerfile.", input: '{"files":[]}', maxOutputTokens: 3000 };

function chatFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

const okBody = { choices: [{ finish_reason: "stop", message: { content: "FROM x\nCMD []" } }] };

afterEach(() => {
  vi.unstubAllEnvs();
  openAi.create.mockClear();
});

describe("resolveProvider", () => {
  it("defaults to openai and accepts gemini", () => {
    vi.stubEnv("LLM_PROVIDER", "");
    expect(resolveProvider()).toBe("openai");
    vi.stubEnv("LLM_PROVIDER", " Gemini ");
    expect(resolveProvider()).toBe("gemini");
  });

  it("rejects unknown providers", () => {
    vi.stubEnv("LLM_PROVIDER", "claude");
    expect(() => resolveProvider()).toThrow(/openai or gemini/);
  });
});

describe("readGeminiSettings", () => {
  it("defaults to the proven flash-lite model and strips a models/ prefix", () => {
    expect(readGeminiSettings({ GEMINI_API_KEY: "k" })).toEqual({ apiKey: "k", model: DEFAULT_GEMINI_MODEL });
    expect(readGeminiSettings({ GEMINI_API_KEY: "k", GEMINI_MODEL: "models/abc-1.2" }).model).toBe("abc-1.2");
  });

  it("requires a key and rejects unsafe model ids", () => {
    expect(() => readGeminiSettings({})).toThrow(/GEMINI_API_KEY/);
    expect(() => readGeminiSettings({ GEMINI_API_KEY: "k", GEMINI_MODEL: "x/../y?key=1" })).toThrow(/unsupported/);
  });
});

describe("extractChatText", () => {
  it("returns the first choice text", () => {
    expect(extractChatText(okBody)).toBe("FROM x\nCMD []");
  });

  it("explains empty results like safety-filtered responses", () => {
    expect(() => extractChatText({ choices: [] })).toThrow(/no choices/);
    expect(() => extractChatText({ choices: [{ finish_reason: "content_filter", message: { content: "" } }] })).toThrow(
      /content_filter/,
    );
    expect(() => extractChatText({ choices: [{ message: {} }] })).toThrow(/no text/);
  });
});

describe("generateWithGemini", () => {
  it("posts an OpenAI-style chat request with a Bearer key and system plus user messages", async () => {
    const fetchImpl = chatFetch(okBody);
    const text = await generateWithGemini(request, { apiKey: "test-key-123", model: "gemini-3.5-flash-lite" }, fetchImpl);
    expect(text).toBe("FROM x\nCMD []");

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GEMINI_ENDPOINT);
    expect(url).not.toContain("test-key-123");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key-123");
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe("gemini-3.5-flash-lite");
    expect(sent.messages).toEqual([
      { role: "system", content: "Write a Dockerfile." },
      { role: "user", content: '{"files":[]}' },
    ]);
    expect(sent.max_tokens).toBe(3000);
  });

  it("surfaces API errors without leaking the key", async () => {
    const fetchImpl = chatFetch({ error: { message: "model not found" } }, 404);
    const failure = await generateWithGemini(request, { apiKey: "secret-key-xyz", model: "m" }, fetchImpl).catch(
      (error: Error) => error.message,
    );
    expect(failure).toContain("404");
    expect(failure).toContain("model not found");
    expect(failure).not.toContain("secret-key-xyz");
  });
});

describe("GEMINI_API_KEY_FILE", () => {
  it("reads a key from a file when GEMINI_API_KEY is empty, and prefers the plain env value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbsb-key-"));
    const file = join(dir, "gemini.key");
    writeFileSync(file, "dummy-file-key-456\n");
    try {
      vi.stubEnv("LLM_PROVIDER", "gemini");
      vi.stubEnv("GEMINI_API_KEY", "");
      vi.stubEnv("GEMINI_API_KEY_FILE", file);
      const fetchImpl = chatFetch(okBody);
      await generateText(request, fetchImpl);
      const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer dummy-file-key-456");

      vi.stubEnv("GEMINI_API_KEY", "env-wins");
      const second = chatFetch(okBody);
      await generateText(request, second);
      const secondInit = (second as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      expect((secondInit.headers as Record<string, string>).authorization).toBe("Bearer env-wins");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails clearly when the file is missing without echoing its contents", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY_FILE", join(tmpdir(), "definitely-missing-sbsb.key"));
    expect(() => geminiEnvironment()).toThrow(/could not be read/);
  });
});

describe("generateText routing", () => {
  it("uses Gemini when LLM_PROVIDER=gemini", async () => {
    vi.stubEnv("LLM_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_API_KEY", "k");
    vi.stubEnv("GEMINI_MODEL", "");
    const fetchImpl = chatFetch(okBody);
    await expect(generateText(request, fetchImpl)).resolves.toBe("FROM x\nCMD []");
    expect(openAi.create).not.toHaveBeenCalled();
    const sent = JSON.parse(String(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.model).toBe(DEFAULT_GEMINI_MODEL);
  });

  it("keeps the existing OpenAI Responses call and defaults", async () => {
    vi.stubEnv("LLM_PROVIDER", "");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "");

    await expect(generateText(request)).resolves.toContain("FROM python");
    expect(openAi.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5-mini",
        store: false,
        reasoning: { effort: "low" },
        instructions: "Write a Dockerfile.",
        max_output_tokens: 3000,
      }),
    );
  });

  it("requires the OpenAI key when openai is selected", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(generateText(request)).rejects.toThrow(/OPENAI_API_KEY/);
  });
});
