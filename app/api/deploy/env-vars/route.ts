import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { getInstallationClient, parseRepository } from "@/lib/github";
import { deleteEnvVar, listEnvVarKeys, setEnvVar } from "@/lib/project-env";
import { requireInstallationId } from "@/lib/session";

export const dynamic = "force-dynamic";

async function verifyRepositoryAccess(installationId: number, repository: string) {
  const { owner, repo } = parseRepository(repository);
  const client = await getInstallationClient(installationId);
  await client.rest.repos.get({ owner, repo });
}

// Names only: values are write-only from the browser's point of view.
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const repository = request.nextUrl.searchParams.get("repository") ?? "";
    await verifyRepositoryAccess(installationId, repository);
    return NextResponse.json({ variables: await listEnvVarKeys(installationId, repository) });
  } catch (error) {
    return apiError(error, 400);
  }
}

const putSchema = z.object({
  repository: z.string().min(3).max(200),
  key: z.string(),
  value: z.string(),
});

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const { repository, ...variable } = putSchema.parse(await request.json());
    await verifyRepositoryAccess(installationId, repository);
    await setEnvVar(installationId, repository, variable);
    return NextResponse.json({ variables: await listEnvVarKeys(installationId, repository) });
  } catch (error) {
    return apiError(error, 400);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const repository = request.nextUrl.searchParams.get("repository") ?? "";
    const key = request.nextUrl.searchParams.get("key") ?? "";
    await verifyRepositoryAccess(installationId, repository);
    await deleteEnvVar(installationId, repository, key);
    return NextResponse.json({ variables: await listEnvVarKeys(installationId, repository) });
  } catch (error) {
    return apiError(error, 400);
  }
}
