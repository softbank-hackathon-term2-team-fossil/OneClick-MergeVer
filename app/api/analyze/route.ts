import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { analyzeFailure } from "@/lib/analysis/failure";
import { getInstallationClient, parseRepository } from "@/lib/github";
import { generateText } from "@/lib/llm";
import { requireInstallationId } from "@/lib/session";
import { WORKFLOW_NAME } from "@/lib/workflow-template";

const schema = z.object({
  repository: z.string().min(3).max(200),
  kind: z.enum(["build", "deploy"]),
  runId: z.number().int().positive().optional(),
  tag: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  error: z.string().max(8_000).optional(),
  context: z
    .object({
      target: z.string().max(40).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      healthPath: z.string().max(200).optional(),
    })
    .optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const input = schema.parse(await request.json());
    const { owner, repo } = parseRepository(input.repository);
    const client = await getInstallationClient(requireInstallationId(request));

    let ref = input.tag;
    let log = "";
    const context: Record<string, string | number | undefined> = { ...input.context };

    if (input.kind === "build") {
      if (!input.runId) throw new Error("A build run is required.");
      const runs = await client.rest.actions.listWorkflowRunsForRepo({ owner, repo, per_page: 30 });
      const run = runs.data.workflow_runs.find((item) => item.id === input.runId && item.name === WORKFLOW_NAME);
      if (!run) throw new Error("That build was not found in this repository.");
      if (run.conclusion !== "failure") throw new Error("Only failed SBSB builds can be analyzed.");
      ref = run.head_sha;

      const jobs = await client.rest.actions.listJobsForWorkflowRun({ owner, repo, run_id: run.id });
      const failedJob = jobs.data.jobs.find((job) => job.conclusion === "failure") ?? jobs.data.jobs[0];
      const failedSteps = (failedJob?.steps ?? [])
        .filter((step) => step.conclusion === "failure")
        .map((step) => step.name);
      context.failedJob = failedJob?.name;
      context.failedSteps = failedSteps.join(", ");

      const download = failedJob
        ? await client.rest.actions
            .downloadJobLogsForWorkflowRun({ owner, repo, job_id: failedJob.id })
            .catch(() => null)
        : null;
      const data = download?.data as unknown;
      log =
        typeof data === "string"
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString("utf8")
            : `The job log could not be downloaded. Failed steps: ${failedSteps.join(", ") || "unknown"}.`;
    } else {
      if (!input.error?.trim()) throw new Error("The deploy error text is required.");
      log = input.error;
    }

    let dockerfile: string | null = null;
    if (ref) {
      const file = await client.rest.repos.getContent({ owner, repo, path: "Dockerfile", ref }).catch(() => null);
      const data = file?.data;
      if (data && !Array.isArray(data) && data.type === "file" && "content" in data) {
        dockerfile = Buffer.from(data.content, "base64").toString("utf8");
      }
    }

    const analysis = await analyzeFailure({ kind: input.kind, log, dockerfile, context }, generateText);
    return NextResponse.json({ analysis });
  } catch (error) {
    return apiError(error, 400);
  }
}
