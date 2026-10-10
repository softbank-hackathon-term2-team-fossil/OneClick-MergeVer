import "server-only";

import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { generateWithGemini, readGeminiSettings } from "./llm-gemini";

export type LlmProvider = "openai" | "gemini";

export type LlmRequest = {
  instructions: string;
  input: string;
  maxOutputTokens: number;
};

type FetchLike = typeof fetch;

export function resolveProvider(): LlmProvider {
  const value = process.env.LLM_PROVIDER?.trim().toLowerCase() || "openai";
  if (value === "openai" || value === "gemini") return value;
  throw new Error("LLM_PROVIDER must be either openai or gemini.");
}

async function generateWithOpenAi(request: LlmRequest): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  const client = new OpenAI({ apiKey });
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL?.trim() || "gpt-5-mini",
    store: false,
    reasoning: { effort: "low" },
    instructions: request.instructions,
    input: request.input,
    max_output_tokens: request.maxOutputTokens,
  });
  if (!response.output_text) throw new Error("OpenAI returned an empty response.");
  return response.output_text;
}

export function geminiEnvironment(): Record<string, string | undefined> {
  const env = { ...process.env };
  const keyFile = env.GEMINI_API_KEY_FILE?.trim();
  if (!env.GEMINI_API_KEY?.trim() && keyFile) {
    try {
      env.GEMINI_API_KEY = readFileSync(keyFile, "utf8").trim();
    } catch {
      throw new Error("GEMINI_API_KEY_FILE could not be read.");
    }
  }
  return env;
}

export function generateText(request: LlmRequest, fetchImpl: FetchLike = fetch): Promise<string> {
  return resolveProvider() === "gemini"
    ? generateWithGemini(request, readGeminiSettings(geminiEnvironment()), fetchImpl)
    : generateWithOpenAi(request);
}
