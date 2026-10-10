import { z } from "zod";
import { validateDockerfile } from "../dockerfile-validation";

export type FailureKind = "build" | "deploy";

export type FailureInput = {
  kind: FailureKind;
  log: string;
  dockerfile?: string | null;
  context?: Record<string, string | number | undefined>;
};

export type FailureAnalysis = {
  summary: string;
  cause: string;
  suggestion: string;
  dockerfile: string | null;
  note: string | null;
};

type Generate = (request: { instructions: string; input: string; maxOutputTokens: number }) => Promise<string>;

const MAX_LOG_CHARS = 6_000;

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private key removed]"],
  [/AIza[0-9A-Za-z_-]{20,}/g, "[api key removed]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[api key removed]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[github token removed]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[github token removed]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[slack token removed]"],
  [/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[removed]"],
  [/((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)[^\s'"]{6,}/gi, "$1[removed]"],
];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

export function prepareLog(raw: string, limit = MAX_LOG_CHARS): string {
  const cleaned = redact(
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/gm, "")
      .replace(/\r/g, ""),
  ).trim();
  return cleaned.length > limit ? `…(earlier output omitted)\n${cleaned.slice(-limit)}` : cleaned;
}

export function buildAnalysisPrompt(input: FailureInput): { instructions: string; input: string } {
  const what = input.kind === "build" ? "a container image build run by GitHub Actions" : "a deployment of a container image";
  const instructions = [
    `You are a release engineer helping someone who may not know Docker. Analyze why ${what} failed.`,
    "Answer in Korean, in plain language.",
    'Return only one JSON object with exactly these string fields: "summary" (one sentence), "cause" (the most likely root cause, citing the decisive log line), "suggestion" (concrete next steps).',
    'Add a fifth field "dockerfile" only when changing the Dockerfile would fix the problem; it must contain the complete corrected Dockerfile text and nothing else. Otherwise set it to null.',
    "Before answering, compare the values in the context (container port, health path) with the port the log says the application listens on and with the EXPOSE line of the Dockerfile; if they disagree, name the mismatch explicitly with both numbers and make it the cause (for example: 'you entered port 9999 but the app listens on 8000').",
    "A health check that fails with connection reset or refused while the log shows the application started usually means a wrong container port or health path, not a network problem.",
    "Do not invent files or commands that the evidence does not support. Never include secrets. If the log is not enough to be sure, say what extra information is needed.",
  ].join(" ");

  return {
    instructions,
    input: JSON.stringify({
      kind: input.kind,
      context: input.context ?? {},
      dockerfile: input.dockerfile ? input.dockerfile.slice(0, 12_000) : null,
      log: prepareLog(input.log),
    }),
  };
}

const responseSchema = z.object({
  summary: z.string().min(1).max(600),
  cause: z.string().min(1).max(2000),
  suggestion: z.string().min(1).max(2000),
  dockerfile: z.string().max(12_000).nullable().optional(),
});

function braceSlice(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

function extractJson(text: string): unknown {
  // Prefer the outermost braces of the whole answer: a "dockerfile" value may itself contain code fences.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [braceSlice(text), fenced ? braceSlice(fenced[1]) : null].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  throw new Error("The AI answer did not contain a JSON object.");
}

export function parseAnalysis(text: string): FailureAnalysis {
  let parsed: z.infer<typeof responseSchema>;
  try {
    parsed = responseSchema.parse(extractJson(text));
  } catch (error) {
    throw new Error(`The AI answer could not be understood: ${error instanceof Error ? error.message.slice(0, 160) : "invalid format"}`);
  }

  let dockerfile: string | null = null;
  let note: string | null = null;
  if (parsed.dockerfile && parsed.dockerfile.trim()) {
    try {
      dockerfile = validateDockerfile(parsed.dockerfile);
    } catch (error) {
      note = `제안된 Dockerfile은 검증을 통과하지 못해 제외했습니다: ${error instanceof Error ? error.message : "invalid"}`;
    }
  }
  return { summary: parsed.summary, cause: parsed.cause, suggestion: parsed.suggestion, dockerfile, note };
}

export async function analyzeFailure(input: FailureInput, generate: Generate): Promise<FailureAnalysis> {
  if (!input.log.trim()) throw new Error("There is no log to analyze.");
  const prompt = buildAnalysisPrompt(input);
  const text = await generate({ ...prompt, maxOutputTokens: 3_000 });
  return parseAnalysis(text);
}
