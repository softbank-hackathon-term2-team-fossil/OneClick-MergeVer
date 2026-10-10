import "server-only";

import { readFileSync } from "node:fs";
import { App, Octokit } from "octokit";

let app: App | undefined;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not configured.`);
  }
  return value;
}

function privateKey(): string {
  const path = process.env.GITHUB_PRIVATE_KEY_PATH?.trim();
  if (path) return readFileSync(path, "utf8");
  return requiredEnv("GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n");
}

export function getGitHubApp(): App {
  if (!app) {
    app = new App({
      appId: requiredEnv("GITHUB_APP_ID"),
      privateKey: privateKey(),
      Octokit,
    });
  }
  return app;
}

export async function getInstallationClient(
  installationId: number,
): Promise<Octokit> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error("A valid GitHub App installation ID is required.");
  }
  return (await getGitHubApp().getInstallationOctokit(
    installationId,
  )) as Octokit;
}

export function parseRepository(fullName: string): {
  owner: string;
  repo: string;
} {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(fullName);
  if (!match) {
    throw new Error("Repository must use the owner/name format.");
  }
  return { owner: match[1], repo: match[2] };
}

export function getGitHubInstallUrl(): string {
  const slug = requiredEnv("GITHUB_APP_SLUG");
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}
