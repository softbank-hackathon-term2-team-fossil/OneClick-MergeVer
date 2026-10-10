import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api";
import { getInstallationClient } from "@/lib/github";
import { listImageVersions } from "@/lib/image-versions";
import { requireInstallationId } from "@/lib/session";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const client = await getInstallationClient(requireInstallationId(request));
    const repository = request.nextUrl.searchParams.get("repository") || "";
    const branch = request.nextUrl.searchParams.get("branch") || "";
    const versions = await listImageVersions(client, repository, branch);
    return NextResponse.json({ versions });
  } catch (error) {
    return apiError(error, 400);
  }
}
