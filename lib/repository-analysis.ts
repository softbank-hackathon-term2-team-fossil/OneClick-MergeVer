import "server-only";

import type { Octokit } from "octokit";
import type { AnalyzedFile, RepositoryAnalysis } from "@/lib/types";
import { parseRepository } from "@/lib/github";

const MAX_FILES = 18;
const MAX_FILE_CHARACTERS = 14_000;

const BUILD_FILES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "requirements.txt",
  "pyproject.toml",
  "poetry.lock",
  "Pipfile",
  "uv.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  // Names the database (datasource provider) for on-premises database setup. No secrets: URLs come from env().
  "schema.prisma",
]);

const ENTRYPOINTS = new Set([
  "main.py",
  "app.py",
  "manage.py",
  "server.py",
  "index.js",
  "index.ts",
  "server.js",
  "server.ts",
]);

const BLOCKED_PATH = /(^|\/)(\.env|\.git|\.github|node_modules|vendor|dist|build)(\/|$)|(^|\/)(id_rsa|id_ed25519|secrets?\.|credentials?\.)|\.(pem|key|p12|pfx)$/i;

export function isAllowedPath(path: string): boolean {
  if (BLOCKED_PATH.test(path)) return false;
  const parts = path.split("/");
  const basename = parts.at(-1) ?? "";
  const depth = parts.length - 1;
  return BUILD_FILES.has(basename) || (depth <= 2 && ENTRYPOINTS.has(basename));
}

async function readFile(
  client: Octokit,
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<AnalyzedFile | null> {
  const response = await client.rest.repos.getContent({
    owner,
    repo,
    path,
    ref: branch,
  });

  if (Array.isArray(response.data) || !("content" in response.data)) return null;
  const raw = Buffer.from(response.data.content, "base64").toString("utf8");
  return {
    path,
    content: raw.slice(0, MAX_FILE_CHARACTERS),
    truncated: raw.length > MAX_FILE_CHARACTERS,
  };
}

export function detectFramework(files: AnalyzedFile[]): string {
  const all = files.map((file) => file.content).join("\n");
  const names = new Set(files.map((file) => file.path.split("/").at(-1)));

  if (/fastapi/i.test(all)) return "FastAPI";
  if (/django/i.test(all) || names.has("manage.py")) return "Django";
  if (/spring-boot|org\.springframework/i.test(all)) return "Spring Boot";
  if (/"next"\s*:/i.test(all)) return "Next.js";
  if (/"(express|fastify|koa)"\s*:/i.test(all)) return "Node.js";
  if (names.has("go.mod")) return "Go";
  if (names.has("Cargo.toml")) return "Rust";
  if (names.has("requirements.txt") || names.has("pyproject.toml")) return "Python";
  if (names.has("package.json")) return "Node.js";
  if (names.has("pom.xml") || names.has("build.gradle")) return "JVM";
  return "Unknown";
}

export function detectPackageManager(files: AnalyzedFile[]): string {
  const names = new Set(files.map((file) => file.path.split("/").at(-1)));
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("package-lock.json")) return "npm";
  if (names.has("uv.lock")) return "uv";
  if (names.has("poetry.lock")) return "Poetry";
  if (names.has("requirements.txt")) return "pip";
  if (names.has("pom.xml")) return "Maven";
  if (names.has("build.gradle") || names.has("build.gradle.kts")) return "Gradle";
  if (names.has("go.mod")) return "Go modules";
  if (names.has("Cargo.toml")) return "Cargo";
  return "Unknown";
}

export async function analyzeRepository(
  client: Octokit,
  fullName: string,
  branch: string,
): Promise<RepositoryAnalysis> {
  const { owner, repo } = parseRepository(fullName);
  const branchData = await client.rest.repos.getBranch({ owner, repo, branch });
  const commit = await client.rest.git.getCommit({
    owner,
    repo,
    commit_sha: branchData.data.commit.sha,
  });
  const tree = await client.rest.git.getTree({
    owner,
    repo,
    tree_sha: commit.data.tree.sha,
    recursive: "true",
  });

  const candidates = tree.data.tree
    .filter((item) => item.type === "blob" && item.path && isAllowedPath(item.path))
    .map((item) => item.path as string)
    .sort((a, b) => {
      const aBuild = BUILD_FILES.has(a.split("/").at(-1) ?? "") ? 0 : 1;
      const bBuild = BUILD_FILES.has(b.split("/").at(-1) ?? "") ? 0 : 1;
      return aBuild - bBuild || a.localeCompare(b);
    })
    .slice(0, MAX_FILES);

  const readResults = await Promise.all(
    candidates.map((path) => readFile(client, owner, repo, branch, path)),
  );
  const files = readResults.filter((file): file is AnalyzedFile => file !== null);
  const warnings: string[] = [];

  if (tree.data.truncated) warnings.push("GitHub returned a truncated repository tree.");
  if (files.length === 0) {
    warnings.push("No supported build manifest or application entry point was found.");
  }
  if (files.some((file) => file.truncated)) {
    warnings.push("Large files were truncated before AI analysis.");
  }

  return {
    repository: fullName,
    branch,
    framework: detectFramework(files),
    packageManager: detectPackageManager(files),
    files,
    ignoredFileCount: Math.max(0, tree.data.tree.length - candidates.length),
    warnings,
  };
}
