import { z } from "zod";
import { redact } from "./failure";

export type ChangedFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
};

export type ChangeExplanation = {
  file: string;
  title: string;
  explanation: string;
  risk: "low" | "medium" | "high";
};

export type PullRequestReview = {
  overview: string;
  changes: ChangeExplanation[];
  concerns: string[];
};

type Generate = (request: { instructions: string; input: string; maxOutputTokens: number }) => Promise<string>;

const MAX_PATCH_CHARS = 12_000;

export function trimPatch(patch: string | undefined | null): string {
  const text = patch ?? "";
  return text.length > MAX_PATCH_CHARS ? `${text.slice(0, MAX_PATCH_CHARS)}\n… (diff truncated)` : text;
}

export { classifyDiffLine, type DiffLineKind } from "./diff";

export function buildReviewPrompt(files: ChangedFile[]): { instructions: string; input: string } {
  const instructions = [
    "You explain a GitHub pull request to someone who may not know Docker or CI, so they can decide whether to merge it.",
    "Answer in Korean, in plain language.",
    'Return only one JSON object with exactly these fields: "overview" (two sentences at most), "changes" (an array with one entry per changed file), "concerns" (an array of strings).',
    'Each entry of "changes" has: "file" (the exact file name), "title" (a short label), "explanation" (what the important lines or steps do and why they are there), "risk" (one of "low", "medium", "high": could this break the app, leak a secret, or widen permissions).',
    'Put anything unusual into "concerns": secrets or credentials, downloads from remote URLs, privileged mode, broad permissions, running as root, or steps that do not match the application. Use an empty array when there is nothing to flag.',
    "Only describe what the diff shows. Do not claim that anything was executed or tested.",
  ].join(" ");

  return {
    instructions,
    input: JSON.stringify({
      files: files.map((file) => ({
        file: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        diff: redact(trimPatch(file.patch)),
      })),
    }),
  };
}

const reviewSchema = z.object({
  overview: z.string().min(1).max(800),
  changes: z
    .array(
      z.object({
        file: z.string().min(1).max(300),
        title: z.string().min(1).max(160),
        explanation: z.string().min(1).max(1500),
        risk: z.enum(["low", "medium", "high"]),
      }),
    )
    .max(20),
  concerns: z.array(z.string().min(1).max(500)).max(10),
});

function parseJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const slices = [text, fenced ? fenced[1] : ""].map((value) => {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    return start >= 0 && end > start ? value.slice(start, end + 1) : null;
  });
  for (const slice of slices) {
    if (!slice) continue;
    try {
      return JSON.parse(slice);
    } catch {
      // try the next candidate
    }
  }
  throw new Error("The AI answer did not contain a JSON object.");
}

export function parseReview(text: string): PullRequestReview {
  try {
    return reviewSchema.parse(parseJsonObject(text));
  } catch (error) {
    throw new Error(`The AI review could not be understood: ${error instanceof Error ? error.message.slice(0, 160) : "invalid format"}`);
  }
}

export async function reviewChanges(files: ChangedFile[], generate: Generate): Promise<PullRequestReview> {
  if (files.length === 0) throw new Error("There are no changes to review.");
  const prompt = buildReviewPrompt(files);
  return parseReview(await generate({ ...prompt, maxOutputTokens: 3_500 }));
}
