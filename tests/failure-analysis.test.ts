import { describe, expect, it, vi } from "vitest";
import { analyzeFailure, buildAnalysisPrompt, parseAnalysis, prepareLog, redact } from "../lib/analysis/failure";

// Dummy credentials are assembled at runtime so no real-looking secret literal is committed.
const fakeGoogleKey = ["AI", "zaSyA1234567890abcdefghijklmnopqrstuv"].join("");
const fakeOpenAiKey = ["s", "k-abcdefghijklmnopqrstuvwxyz"].join("");
const fakeGithubToken = ["gh", "p_abcdefghijklmnopqrstuvwxyz1234567890"].join("");
const fakeFineGrained = ["github", "_pat_11AAAAAAA0abcdefghijklmnop_qrstuvwxyz"].join("");

const good = {
  summary: "requirements.txt에 없는 패키지를 설치하다 실패했습니다.",
  cause: "ERROR: No matching distribution found for nonexistent-package-xyz",
  suggestion: "requirements.txt에서 해당 패키지를 제거하거나 올바른 이름으로 바꾸세요.",
  dockerfile: null,
};

describe("redact", () => {
  it("removes common secret formats", () => {
    const text = [
      `key ${fakeGoogleKey}`,
      `openai ${fakeOpenAiKey}`,
      `gh ${fakeGithubToken}`,
      `pat ${fakeFineGrained}`,
      "Authorization: Bearer abc.def.ghi",
      "PASSWORD=hunter2hunter2",
      ["-----BEGIN RSA PRIVATE", " KEY-----"].join("") + "\nMIIB\n" + ["-----END RSA PRIVATE", " KEY-----"].join(""),
    ].join("\n");
    const cleaned = redact(text);
    expect(cleaned).not.toMatch(/AIza|sk-abc|ghp_|github_pat_|abc\.def\.ghi|hunter2|MIIB/);
    expect(cleaned).toContain("[removed]");
  });

  it("keeps ordinary log lines intact", () => {
    expect(redact("Step 4/8 : RUN pip install -r requirements.txt")).toBe("Step 4/8 : RUN pip install -r requirements.txt");
  });
});

describe("prepareLog", () => {
  it("strips ANSI codes and timestamps and keeps the end of long logs", () => {
    const raw = `2026-10-08T10:00:00.1234567Z \u001b[31mERROR\u001b[0m something\n${"x".repeat(20)}`;
    expect(prepareLog(raw)).toBe(`ERROR something\n${"x".repeat(20)}`);
    const long = `${"a".repeat(9000)}THE END`;
    const trimmed = prepareLog(long, 100);
    expect(trimmed.endsWith("THE END")).toBe(true);
    expect(trimmed.length).toBeLessThan(160);
    expect(trimmed).toContain("earlier output omitted");
  });
});

describe("buildAnalysisPrompt", () => {
  it("sends a redacted, trimmed log together with the Dockerfile and context", () => {
    const prompt = buildAnalysisPrompt({
      kind: "build",
      log: `pip failed ${fakeGoogleKey}`,
      dockerfile: "FROM python:3.11-slim\nCMD []",
      context: { failedJob: "build-and-push" },
    });
    expect(prompt.instructions).toContain("Korean");
    expect(prompt.instructions).toContain("JSON");
    expect(prompt.instructions).toContain("mismatch");
    expect(prompt.instructions).toContain("EXPOSE");
    const payload = JSON.parse(prompt.input);
    expect(payload.kind).toBe("build");
    expect(payload.dockerfile).toContain("FROM python");
    expect(payload.context).toEqual({ failedJob: "build-and-push" });
    expect(payload.log).not.toContain("AIza");
  });
});

describe("parseAnalysis", () => {
  it("accepts plain and fenced JSON", () => {
    expect(parseAnalysis(JSON.stringify(good))).toMatchObject({ summary: good.summary, dockerfile: null, note: null });
    expect(parseAnalysis(`\`\`\`json\n${JSON.stringify(good)}\n\`\`\``).cause).toBe(good.cause);
    expect(parseAnalysis(`Here you go: ${JSON.stringify(good)} Hope it helps`).suggestion).toBe(good.suggestion);
  });

  it("keeps a valid Dockerfile suggestion and normalizes it", () => {
    const result = parseAnalysis(
      JSON.stringify({ ...good, dockerfile: "```dockerfile\nFROM python:3.11-slim\nCMD [\"python\", \"main.py\"]\n```" }),
    );
    expect(result.dockerfile).toMatch(/^FROM python:3\.11-slim/);
    expect(result.dockerfile).not.toContain("```");
  });

  it("drops a Dockerfile that fails validation and says why", () => {
    const result = parseAnalysis(
      JSON.stringify({ ...good, dockerfile: "FROM alpine:3.21\nENV TOKEN=AKIAABCDEFGHIJKLMNOP\nCMD [\"sh\"]" }),
    );
    expect(result.dockerfile).toBeNull();
    expect(result.note).toContain("검증을 통과하지 못해");
  });

  it("keeps the raw answer when it is not the expected JSON instead of failing", () => {
    const plain = parseAnalysis("I cannot help with that");
    expect(plain.cause).toBe("I cannot help with that");
    expect(plain.dockerfile).toBeNull();
    expect(plain.note).toContain("JSON이 아니어서 원문을 표시");

    const partial = parseAnalysis(JSON.stringify({ summary: "only a summary" }));
    expect(partial.summary).toContain("구조화된 분석 형식으로 응답하지 않았습니다");
    expect(partial.cause).toContain("only a summary");
  });

  it("limits the preserved raw answer to its last 2000 characters", () => {
    const result = parseAnalysis(`${"a".repeat(5_000)}END`);
    expect(result.cause).toHaveLength(2_000);
    expect(result.cause.endsWith("END")).toBe(true);
  });

  it("still throws when the answer is empty", () => {
    expect(() => parseAnalysis("   ")).toThrow(/could not be understood/);
  });
});

describe("analyzeFailure", () => {
  it("calls the model once and returns the parsed result", async () => {
    const generate = vi.fn(async (_request: { instructions: string; input: string; maxOutputTokens: number }) =>
      JSON.stringify(good),
    );
    const result = await analyzeFailure({ kind: "deploy", log: "health check failed" }, generate);
    expect(result.summary).toBe(good.summary);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toMatchObject({ maxOutputTokens: 3000 });
  });

  it("refuses to call the model without a log", async () => {
    const generate = vi.fn(async (_request: { instructions: string; input: string; maxOutputTokens: number }) => "");
    await expect(analyzeFailure({ kind: "build", log: "   " }, generate)).rejects.toThrow(/no log/);
    expect(generate).not.toHaveBeenCalled();
  });
});
