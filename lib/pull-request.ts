import "server-only";

import type { Octokit } from "octokit";
import { parseRepository } from "@/lib/github";
import { assertMergeableSetupPullRequest } from "@/lib/pull-request-guard";
import { WORKFLOW_PATH } from "@/lib/workflow-template";

type SetupPullRequestInput = {
  client: Octokit;
  repository: string;
  baseBranch: string;
  dockerfile: string;
  workflow: string;
  autoMerge?: boolean;
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
  autoMerge = true,
}: SetupPullRequestInput): Promise<{
  number: number;
  htmlUrl: string;
  branch: string;
  merged: boolean;
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

  let merged = false;
  if (autoMerge) {
    try {
      // The pull request was just created by this app, but the same guard protects every merge path.
      await loadSetupPullRequest(client, repository, pull.data.number);
      const mergeResponse = await client.rest.pulls.merge({
        owner,
        repo,
        pull_number: pull.data.number,
        merge_method: "squash",
        commit_title: `Set up SBSB container builds (#${pull.data.number})`,
        commit_message: "Auto-merged by SBSB for instant deployment pipeline readiness.",
      });
      merged = Boolean(mergeResponse.data.merged);

      if (merged) {
        // Clean up temporary setup branch
        await client.rest.git.deleteRef({
          owner,
          repo,
          ref: `heads/${branch}`,
        }).catch(() => {});
      }
    } catch {
      // In case of branch protection or required checks, leave PR open for manual merge
      merged = false;
    }
  }

  return { number: pull.data.number, htmlUrl: pull.data.html_url, branch, merged };
}

// Loads a setup pull request and verifies it with the merge guard before anything is merged.
export async function loadSetupPullRequest(client: Octokit, repository: string, pullNumber: number) {
  const { owner, repo } = parseRepository(repository);
  const pull = await client.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  const files = await client.paginate(client.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  assertMergeableSetupPullRequest({
    state: pull.data.state,
    merged: pull.data.merged,
    headRef: pull.data.head.ref,
    headRepo: pull.data.head.repo?.full_name ?? null,
    baseRepo: pull.data.base.repo.full_name,
    authorType: pull.data.user?.type ?? null,
    files: files.map((file) => file.filename),
  });

  return { owner, repo, pull, files };
}

export async function mergeSetupPullRequest(
  client: Octokit,
  repository: string,
  pullNumber: number,
): Promise<{ sha: string }> {
  const { owner, repo, pull } = await loadSetupPullRequest(client, repository, pullNumber);

  let sha: string;
  try {
    const result = await client.rest.pulls.merge({
      owner,
      repo,
      pull_number: pullNumber,
      merge_method: "squash",
      commit_title: `Set up SBSB container builds (#${pullNumber})`,
    });
    sha = result.data.sha;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 405 || status === 409) {
      throw new Error("GitHub가 이 머지를 허용하지 않았습니다(브랜치 보호 규칙 또는 충돌). GitHub에서 직접 머지하세요.");
    }
    throw error;
  }

  await client.rest.git.deleteRef({ owner, repo, ref: `heads/${pull.data.head.ref}` }).catch(() => undefined);
  return { sha };
}
