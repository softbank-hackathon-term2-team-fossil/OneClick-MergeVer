import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { reviewChanges, trimPatch, type ChangedFile } from "@/lib/analysis/pr-review";
import { getInstallationClient } from "@/lib/github";
import { generateText } from "@/lib/llm";
import { loadSetupPullRequest } from "@/lib/pull-request";
import { requireInstallationId } from "@/lib/session";
import type { PullRequestReviewResult } from "@/lib/types";

const schema = z.object({
  repository: z.string().min(3).max(200),
  pullNumber: z.number().int().positive(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const input = schema.parse(await request.json());
    const client = await getInstallationClient(requireInstallationId(request));
    // Same guard as the merge: only open SBSB setup pull requests that touch nothing else.
    const { files } = await loadSetupPullRequest(client, input.repository, input.pullNumber);

    const changed: ChangedFile[] = files.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: trimPatch(file.patch),
    }));

    let review: PullRequestReviewResult["review"] = null;
    let reviewError: string | null = null;
    try {
      review = await reviewChanges(changed, generateText);
    } catch (error) {
      reviewError = error instanceof Error ? error.message : "The AI review failed.";
    }

    const result: PullRequestReviewResult = {
      files: changed,
      facts: {
        fileCount: changed.length,
        additions: changed.reduce((sum, file) => sum + file.additions, 0),
        deletions: changed.reduce((sum, file) => sum + file.deletions, 0),
        allowedFilesOnly: true,
      },
      review,
      reviewError,
    };
    return NextResponse.json({ result });
  } catch (error) {
    return apiError(error, 400);
  }
}
