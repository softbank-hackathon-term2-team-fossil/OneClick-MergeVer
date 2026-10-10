import "server-only";

import type { RepositoryAnalysis } from "@/lib/types";
import { missingBaseImages } from "@/lib/dockerfile-images";
import { validateDockerfile } from "@/lib/dockerfile-validation";
import { generateText } from "@/lib/llm";

const INSTRUCTIONS = [
  "You generate one production-minded Dockerfile for a single web application.",
  "Return only Dockerfile text, without Markdown fences or explanation.",
  "Use a currently supported official slim runtime image and deterministic dependency installation when possible.",
  "For Debian-based Python or Node images, prefer bookworm or newer and never use bullseye.",
  "For every other language use a plain official tag that is known to exist, such as eclipse-temurin:17-jre, gradle:8-jdk17, maven:3-eclipse-temurin-17 or golang:1.24. Never append -slim or a Debian codename to those images.",
  "Do not install compilers, build-essential, curl, or other OS packages unless the supplied dependencies clearly require them.",
  "Use a non-root user when practical, expose the inferred app port, and bind the server to 0.0.0.0.",
  "Do not embed secrets, credentials, source file contents, health checks that require unavailable tools, or provider-specific services.",
  "Do not invent files, build commands, or framework configuration unsupported by the supplied evidence.",
].join(" ");

export async function generateDockerfile(
  analysis: RepositoryAnalysis,
): Promise<string> {
  const input = JSON.stringify({
    framework: analysis.framework,
    packageManager: analysis.packageManager,
    files: analysis.files.map((file) => ({
      path: file.path,
      content: file.content,
      truncated: file.truncated,
    })),
  });
  const dockerfile = validateDockerfile(await generateText({ instructions: INSTRUCTIONS, input, maxOutputTokens: 3_000 }));
  const missing = await missingBaseImages(dockerfile);
  if (!missing.length) return dockerfile;

  // One correction round: the model is told exactly which tags Docker Hub does not have.
  const retried = validateDockerfile(await generateText({
    instructions: `${INSTRUCTIONS} Your previous answer used base images that do not exist on Docker Hub: ${missing.join(", ")}. Write the Dockerfile again with tags that exist, keeping everything else the same.`,
    input: JSON.stringify({ previousDockerfile: dockerfile, request: JSON.parse(input) }),
    maxOutputTokens: 3_000,
  }));
  const stillMissing = await missingBaseImages(retried);
  if (stillMissing.length) {
    throw new Error(`AI가 Docker Hub에 없는 베이스 이미지를 사용했습니다: ${stillMissing.join(", ")}. 다시 생성해 주세요.`);
  }
  return retried;
}
