import "server-only";

import type { Octokit } from "octokit";
import { dockerHubTag, existingDockerHubReferences } from "@/lib/dockerhub";
import { parseRepository } from "@/lib/github";
import type { ImageVersion } from "@/lib/types";
import { WORKFLOW_NAME } from "@/lib/workflow-template";

const shaTag = /^[a-f0-9]{40}$/i;
const MAX_VERSIONS = 15;

// Deployable versions: commits whose SBSB build succeeded on this branch and whose image
// is still in Docker Hub. A successful run alone is not enough because images can be deleted.
export async function listImageVersions(client: Octokit, repository: string, branch: string): Promise<ImageVersion[]> {
  const { owner, repo } = parseRepository(repository);
  if (!branch) throw new Error("브랜치를 선택하세요.");
  const { data: runs } = await client.rest.actions.listWorkflowRunsForRepo({ owner, repo, branch, per_page: 100 });
  const seen = new Set<string>();
  const successfulRuns = runs.workflow_runs.filter((run) => {
    const sha = run.head_sha.toLowerCase();
    if (run.name !== WORKFLOW_NAME || run.conclusion !== "success" || run.head_branch !== branch) return false;
    if (!shaTag.test(sha) || seen.has(sha)) return false;
    seen.add(sha);
    return true;
  }).slice(0, MAX_VERSIONS);
  if (!successfulRuns.length) return [];

  const published = await existingDockerHubReferences(repository, successfulRuns.map((run) => run.head_sha.toLowerCase()));
  return successfulRuns
    .filter((run) => published.has(run.head_sha.toLowerCase()))
    .map((run) => ({
      tag: run.head_sha.toLowerCase(),
      image: dockerHubTag(repository, run.head_sha.toLowerCase()),
      publishedAt: run.updated_at || run.created_at,
      runUrl: run.html_url,
    }));
}
