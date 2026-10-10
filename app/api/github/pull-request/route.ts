import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { validateDockerfile } from "@/lib/dockerfile-validation";
import { getInstallationClient } from "@/lib/github";
import { createSetupPullRequest } from "@/lib/pull-request";
import { provisionDockerHubPublisher } from "@/lib/dockerhub";
import { createWorkflow } from "@/lib/workflow-template";
import { requireInstallationId } from "@/lib/session";

const schema = z.object({
  repository: z.string().min(3).max(200),
  branch: z.string().min(1).max(250),
  dockerfile: z.string().min(20).max(12_000),
  autoMerge: z.boolean().optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const input = schema.parse(await request.json());
    const client = await getInstallationClient(requireInstallationId(request));
    const image = await provisionDockerHubPublisher(client, input.repository);
    const pullRequest = await createSetupPullRequest({
      client,
      repository: input.repository,
      baseBranch: input.branch,
      dockerfile: validateDockerfile(input.dockerfile),
      workflow: createWorkflow(input.branch, image.repositoryUri, image.tagPrefix),
      autoMerge: input.autoMerge ?? true,
    });
    return NextResponse.json({ pullRequest });
  } catch (error) {
    return apiError(error, 400);
  }
}
