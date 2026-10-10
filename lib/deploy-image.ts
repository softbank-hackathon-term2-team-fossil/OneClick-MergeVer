import "server-only";

import { rm } from "node:fs/promises";
import type { NextRequest } from "next/server";
import { dockerfilePort } from "@/lib/dockerfile-port";
import { publishLocalImage } from "@/lib/dockerhub";
import { getInstallationClient } from "@/lib/github";
import { listImageVersions } from "@/lib/image-versions";
import { run } from "@/lib/process";
import { requireInstallationId } from "@/lib/session";
import { prepareZip } from "@/lib/zip-build";

export type DeployEvent = { phase: string; message: string; image?: string; url?: string; instanceId?: string; dockerfile?: string };

export type ImageSource =
  | { source: "github"; repository: string; branch: string; imageTag: string; containerPort: number }
  | { source: "zip"; containerPort?: number };

// Turns either source into one Docker Hub image that any target can pull.
// GitHub: the image was already published by the repository's Actions build, so nothing moves.
// ZIP: the image is built on this server and published to the same registry.
export async function resolveDeployImage(
  request: NextRequest,
  input: ImageSource,
  archive: File | null,
  emit: (event: DeployEvent) => void,
): Promise<{ image: string; containerPort: number; cleanup: () => Promise<void> }> {
  if (input.source === "github") {
    emit({ phase: "source", message: "성공한 GitHub Actions 빌드를 확인하는 중" });
    const client = await getInstallationClient(requireInstallationId(request));
    const versions = await listImageVersions(client, input.repository, input.branch);
    const selected = versions.find((version) => version.tag === input.imageTag.toLowerCase());
    if (!selected) throw new Error("선택한 이미지 버전을 Docker Hub에서 찾을 수 없습니다. 버전 목록을 새로고침하세요.");
    emit({ phase: "image", message: `Docker Hub 이미지 확인: ${selected.image}`, image: selected.image });
    return { image: selected.image, containerPort: input.containerPort, cleanup: async () => undefined };
  }

  emit({ phase: "docker", message: "Docker 빌드 환경을 확인하는 중" });
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10_000 });
  } catch {
    throw new Error("ZIP 이미지 빌드를 위해 Docker Desktop을 실행한 뒤 다시 시도하세요.");
  }
  emit({ phase: "source", message: "ZIP을 검사하고 Dockerfile을 생성하는 중" });
  const prepared = await prepareZip(archive!);
  const cleanup = () => rm(prepared.folder, { recursive: true, force: true });
  try {
    const containerPort = dockerfilePort(prepared.dockerfile) || input.containerPort;
    if (!containerPort) throw new Error("AI Dockerfile에 EXPOSE 포트가 없습니다. 컨테이너 내부 포트를 입력한 뒤 다시 시도하세요.");
    emit({ phase: "dockerfile", message: `${prepared.analysis.framework} 앱의 Dockerfile 생성 완료 · 내부 포트 ${containerPort}`, dockerfile: prepared.dockerfile });
    emit({ phase: "build", message: "ZIP 소스로 Docker 이미지를 빌드하는 중" });
    const localImage = `sbsb-local:${prepared.tag}`;
    await run("docker", ["build", "--platform", "linux/amd64", "-t", localImage, prepared.root], { timeoutMs: 900_000 });
    emit({ phase: "registry", message: "Docker Hub에 이미지를 업로드하는 중" });
    const image = await publishLocalImage(localImage, prepared.tag);
    emit({ phase: "image", message: `Docker Hub 이미지 업로드 완료: ${image}`, image });
    return { image, containerPort, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
