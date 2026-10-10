import "server-only";

import { createHash } from "node:crypto";
import type { Octokit } from "octokit";
import { parseRepository } from "@/lib/github";
import { setRepositorySecret } from "@/lib/github-secrets";
import { run } from "@/lib/process";

const USERNAME_SECRET = "SBSB_DOCKERHUB_USERNAME";
const TOKEN_SECRET = "SBSB_DOCKERHUB_TOKEN";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function safePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function imageTagPrefix(repository: string): string {
  const { owner, repo } = parseRepository(repository);
  const digest = createHash("sha256").update(repository.toLowerCase()).digest("hex").slice(0, 8);
  const readable = `${safePart(owner)}-${safePart(repo)}`.slice(0, 70).replace(/-+$/g, "");
  return `${readable}-${digest}`;
}

export type DockerHubImage = {
  registry: "docker.io";
  repositoryUri: string;
  tagPrefix: string;
};

function dockerHubRepositoryUri(): string {
  const namespace = requiredEnv("DOCKERHUB_NAMESPACE").toLowerCase();
  const imageRepository = requiredEnv("DOCKERHUB_REPOSITORY").toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(namespace)) {
    throw new Error("DOCKERHUB_NAMESPACE is invalid.");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(imageRepository)) {
    throw new Error("DOCKERHUB_REPOSITORY is invalid.");
  }
  return `${namespace}/${imageRepository}`;
}

export function dockerHubImage(repository: string): DockerHubImage {
  return {
    registry: "docker.io",
    repositoryUri: dockerHubRepositoryUri(),
    tagPrefix: imageTagPrefix(repository),
  };
}

export function dockerHubTag(repository: string, reference: string): string {
  const image = dockerHubImage(repository);
  return `${image.repositoryUri}:${image.tagPrefix}-${reference}`;
}

export async function provisionDockerHubPublisher(
  client: Octokit,
  repository: string,
): Promise<DockerHubImage> {
  const { owner, repo } = parseRepository(repository);
  const username = requiredEnv("DOCKERHUB_USERNAME");
  const token = requiredEnv("DOCKERHUB_ACCESS_TOKEN");
  const image = dockerHubImage(repository);
  await setRepositorySecret(client, owner, repo, USERNAME_SECRET, username);
  await setRepositorySecret(client, owner, repo, TOKEN_SECRET, token);
  return image;
}

export function dockerHubPullCredential(): {
  registry: "docker.io";
  username: string;
  password: string;
} {
  return {
    registry: "docker.io",
    username: requiredEnv("DOCKERHUB_USERNAME"),
    password: requiredEnv("DOCKERHUB_ACCESS_TOKEN"),
  };
}

async function registryBearerToken(repositoryUri: string): Promise<string> {
  const username = requiredEnv("DOCKERHUB_USERNAME");
  const accessToken = requiredEnv("DOCKERHUB_ACCESS_TOKEN");
  const url = new URL("https://auth.docker.io/token");
  url.searchParams.set("service", "registry.docker.io");
  url.searchParams.set("scope", `repository:${repositoryUri}:pull`);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${username}:${accessToken}`).toString("base64")}`,
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Docker Hub authentication failed (${response.status}).`);
  const body = await response.json() as { token?: string; access_token?: string };
  const token = body.token || body.access_token;
  if (!token) throw new Error("Docker Hub did not return a registry token.");
  return token;
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

async function manifestStatus(repositoryUri: string, tag: string, token: string): Promise<number> {
  const response = await fetch(
    `https://registry-1.docker.io/v2/${repositoryUri}/manifests/${encodeURIComponent(tag)}`,
    {
      method: "HEAD",
      headers: { Accept: MANIFEST_TYPES, Authorization: `Bearer ${token}` },
      cache: "no-store",
    },
  );
  return response.status;
}

export async function assertDockerHubArtifact(
  repository: string,
  reference: string,
): Promise<void> {
  const image = dockerHubImage(repository);
  const tag = `${image.tagPrefix}-${reference}`;
  const token = await registryBearerToken(image.repositoryUri);
  const status = await manifestStatus(image.repositoryUri, tag, token);
  if (status === 404) throw new Error(`Docker Hub image tag ${tag} was not found.`);
  if (status < 200 || status >= 300) throw new Error(`Docker Hub image check failed (${status}).`);
}

// Returns the references (commit SHAs) whose image still exists. The shared repository
// holds every customer's tags, so this checks the wanted tags instead of listing them all.
export async function existingDockerHubReferences(
  repository: string,
  references: string[],
): Promise<Set<string>> {
  if (!references.length) return new Set();
  const image = dockerHubImage(repository);
  const token = await registryBearerToken(image.repositoryUri);
  const statuses = await Promise.all(
    references.map((reference) => manifestStatus(image.repositoryUri, `${image.tagPrefix}-${reference}`, token)),
  );
  const failed = statuses.find((status) => status !== 404 && (status < 200 || status >= 300));
  if (failed) throw new Error(`Docker Hub image check failed (${failed}).`);
  return new Set(references.filter((_, index) => statuses[index] !== 404));
}

// Publishes an image built on this server (ZIP uploads) so every target pulls from one registry.
export async function publishLocalImage(localImage: string, tag: string): Promise<string> {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw new Error("The image tag is invalid.");
  const credential = dockerHubPullCredential();
  const image = `${dockerHubRepositoryUri()}:${tag}`;
  await run("docker", ["login", "--username", credential.username, "--password-stdin"], { input: credential.password });
  await run("docker", ["tag", localImage, image]);
  await run("docker", ["push", image], { timeoutMs: 600_000 });
  return image;
}
