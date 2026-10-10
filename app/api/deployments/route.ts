import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api";
import { listDeployments } from "@/lib/deployment-history";
import { getInstallationClient, parseRepository } from "@/lib/github";
import { requireInstallationId } from "@/lib/session";

export const runtime = "nodejs";

// Deployment history of one repository, newest first.
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const repository = request.nextUrl.searchParams.get("repository") ?? "";
    const { owner, repo } = parseRepository(repository);
    // The installation must still be able to see the repository it asks about.
    await (await getInstallationClient(installationId)).rest.repos.get({ owner, repo });
    return NextResponse.json({ deployments: await listDeployments(installationId, repository) });
  } catch (error) {
    return apiError(error, 400);
  }
}
