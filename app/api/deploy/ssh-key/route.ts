import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api";
import { getOrCreateRepositorySshKey } from "@/lib/deployment-store";
import { getInstallationClient, parseRepository } from "@/lib/github";
import { requireInstallationId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const repository = request.nextUrl.searchParams.get("repository") ?? "";
    if (!repository) {
      throw new Error("저장소 정보가 필요합니다.");
    }
    const { owner, repo } = parseRepository(repository);
    const client = await getInstallationClient(installationId);
    await client.rest.repos.get({ owner, repo });

    const keyInfo = await getOrCreateRepositorySshKey(installationId, repository);
    return NextResponse.json({
      publicKey: keyInfo.publicKey,
      setupCommand: keyInfo.setupCommand,
    });
  } catch (error) {
    return apiError(error, 400);
  }
}
