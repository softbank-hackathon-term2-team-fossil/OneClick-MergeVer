import "server-only";

import type { Octokit } from "octokit";
import { parseRepository } from "@/lib/github";
import type { AnalyzedFile } from "@/lib/types";

// Files that say how an app is configured at run time: its port, its database, the environment
// variables it expects. The build analysis reads manifests; these are read in addition.
const CONFIG_FILE = /(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|application(-[a-z]+)?\.(properties|ya?ml)|\.env\.example|\.env\.sample|schema\.prisma|settings\.py|config\.(js|ts|py)|Procfile)$/i;
const BLOCKED = /(^|\/)(node_modules|vendor|dist|build|target|\.git)(\/|$)/i;
const MAX_FILES = 8;
const MAX_CHARACTERS = 6_000;

export async function collectConfigFiles(client: Octokit, repository: string, branch: string): Promise<AnalyzedFile[]> {
  const { owner, repo } = parseRepository(repository);
  const tree = await client.rest.git.getTree({ owner, repo, tree_sha: branch, recursive: "true" });
  const paths = tree.data.tree
    .filter((item) => item.type === "blob" && item.path && CONFIG_FILE.test(item.path) && !BLOCKED.test(item.path) && item.path.split("/").length <= 6)
    .map((item) => item.path as string)
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, MAX_FILES);
  const files = await Promise.all(paths.map(async (path) => {
    const response = await client.rest.repos.getContent({ owner, repo, path, ref: branch });
    if (Array.isArray(response.data) || !("content" in response.data)) return null;
    const raw = Buffer.from(response.data.content, "base64").toString("utf8");
    return { path, content: raw.slice(0, MAX_CHARACTERS), truncated: raw.length > MAX_CHARACTERS };
  }));
  return files.filter((file): file is AnalyzedFile => file !== null);
}
