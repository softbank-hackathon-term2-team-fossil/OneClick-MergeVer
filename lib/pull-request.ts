import "server-only";

import type { Octokit } from "octokit";
import { parseRepository } from "@/lib/github";
import { WORKFLOW_PATH } from "@/lib/workflow-template";

type SetupPullRequestInput = {
  client: Octokit;
  repository: string;
  baseBranch: string;
  dockerfile: string;
  workflow: string;
};

async function getExistingFileSha(
  client: Octokit,
  owner: string,
  repo: string,
  path: string,
  branch: string,
): Promise<string | undefined> {
  try {
    const response = await client.rest.repos.getContent({ owner, repo, path, ref: branch });
    if (!Array.isArray(response.data) && "sha" in response.data) return response.data.sha;
    return undefined;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return undefined;
    throw error;
  }
}

async function upsertFile(
  client: Octokit,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  message: string,
  content: string,
): Promise<void> {
  const sha = await getExistingFileSha(client, owner, repo, path, branch);
  await client.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    branch,
    message,
    content: Buffer.from(content).toString("base64"),
    ...(sha ? { sha } : {}),
  });
}

export async function createSetupPullRequest({
  client,
  repository,
  baseBranch,
  dockerfile,
  workflow,
}: SetupPullRequestInput): Promise<{
  number: number;
  htmlUrl: string;
  branch: string;
}> {
  const { owner, repo } = parseRepository(repository);
  const base = await client.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  });
  const suffix = `${Date.now().toString(36)}-${base.data.object.sha.slice(0, 7)}`;
  const branch = `sbsb/setup-${suffix}`;

  await client.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: base.data.object.sha,
  });

  await upsertFile(
    client,
    owner,
    repo,
    branch,
    "Dockerfile",
    "chore: add SBSB container configuration",
    dockerfile,
  );

  await upsertFile(
    client,
    owner,
    repo,
    branch,
    WORKFLOW_PATH,
    "ci: publish container image to Docker Hub",
    workflow,
  );

  const pull = await client.rest.pulls.create({
    owner,
    repo,
    head: branch,
    base: baseBranch,
    title: "Set up SBSB container builds",
    body: [
      "## What this pull request adds",
      "",
      "- An AI-generated `Dockerfile` based on build manifests and entry points",
      "- A reviewed build workflow that publishes commit-SHA and `latest` tags to the private SBSB Docker Hub repository",
      "",
      "Merging this pull request triggers the first image build.",
      "Docker Hub credentials are stored as encrypted GitHub Actions secrets.",
    ].join("\n"),
  });

  return { number: pull.data.number, htmlUrl: pull.data.html_url, branch };
}
