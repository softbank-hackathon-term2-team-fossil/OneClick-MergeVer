import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api";
import { dockerHubTag } from "@/lib/dockerhub";
import { getInstallationClient, parseRepository } from "@/lib/github";
import { requireInstallationId } from "@/lib/session";
import type { WorkflowRunSummary } from "@/lib/types";
import { WORKFLOW_NAME } from "@/lib/workflow-template";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const repository = request.nextUrl.searchParams.get("repository") ?? "";
    const { owner, repo } = parseRepository(repository);
    const client = await getInstallationClient(installationId);
    const response = await client.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      per_page: 20,
    });
    const run = response.data.workflow_runs.find((item) => item.name === WORKFLOW_NAME);
    const result: WorkflowRunSummary | null = run
      ? {
          id: run.id,
          status: run.status,
          conclusion: run.conclusion,
          headSha: run.head_sha,
          branch: run.head_branch,
          htmlUrl: run.html_url,
          createdAt: run.created_at,
          image: dockerHubTag(repository, run.head_sha),
        }
      : null;
    return NextResponse.json({ run: result });
  } catch (error) {
    return apiError(error, 400);
  }
}
