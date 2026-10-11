import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { getInstallationClient } from "@/lib/github";
import { mergeSetupPullRequest } from "@/lib/pull-request";
import { requireInstallationId } from "@/lib/session";

const schema = z.object({
  repository: z.string().min(3).max(200),
  pullNumber: z.number().int().positive(),
});

// Merges an open SBSB setup pull request after the guard in lib/pull-request-guard.ts accepted it.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const input = schema.parse(await request.json());
    const client = await getInstallationClient(requireInstallationId(request));
    const result = await mergeSetupPullRequest(client, input.repository, input.pullNumber);
    return NextResponse.json({ merged: true, sha: result.sha });
  } catch (error) {
    return apiError(error, 400);
  }
}
