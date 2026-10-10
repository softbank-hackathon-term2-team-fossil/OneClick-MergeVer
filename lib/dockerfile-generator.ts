import "server-only";

import type { RepositoryAnalysis } from "@/lib/types";
import { validateDockerfile } from "@/lib/dockerfile-validation";
import { generateText } from "@/lib/llm";

export async function generateDockerfile(
  analysis: RepositoryAnalysis,
): Promise<string> {
  const text = await generateText({
    instructions: [
      "You generate one production-minded Dockerfile for a single web application.",
      "Return only Dockerfile text, without Markdown fences or explanation.",
      "Use a currently supported official slim runtime image and deterministic dependency installation when possible.",
      "For Debian-based Python or Node images, prefer bookworm or newer and never use bullseye.",
      "For Python, use valid official tags such as python:3.11-slim-bookworm; never write python:<version>-bookworm-slim.",
      "Do not install compilers, build-essential, curl, or other OS packages unless the supplied dependencies clearly require them.",
      "Use a non-root user when practical, expose the inferred app port, and bind the server to 0.0.0.0.",
      "Do not embed secrets, credentials, source file contents, health checks that require unavailable tools, or provider-specific services.",
      "Do not invent files, build commands, or framework configuration unsupported by the supplied evidence.",
    ].join(" "),
    input: JSON.stringify({
      framework: analysis.framework,
      packageManager: analysis.packageManager,
      files: analysis.files.map((file) => ({
        path: file.path,
        content: file.content,
        truncated: file.truncated,
      })),
    }),
    maxOutputTokens: 3_000,
  });
  return validateDockerfile(text);
}
