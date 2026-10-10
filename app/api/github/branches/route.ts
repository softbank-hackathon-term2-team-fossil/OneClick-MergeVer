import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api";
import { getInstallationClient, parseRepository } from "@/lib/github";
import { requireInstallationId } from "@/lib/session";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const repository = request.nextUrl.searchParams.get("repository") ?? "";
    const { owner, repo } = parseRepository(repository);
    const client = await getInstallationClient(installationId);
    const branches = await client.paginate(client.rest.repos.listBranches, {
      owner,
      repo,
      protected: false,
      per_page: 100,
    });
    return NextResponse.json({ branches: branches.map((branch) => branch.name) });
  } catch (error) {
    return apiError(error, 400);
  }
}
