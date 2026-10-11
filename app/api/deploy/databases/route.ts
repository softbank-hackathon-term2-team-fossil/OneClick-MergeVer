import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { DATABASE_KINDS } from "@/lib/database/detect";
import { connectionVariableNames, managedDatabases } from "@/lib/database/stack";
import { listDatabases, revealDatabasePassword } from "@/lib/database/store";
import { getAppEnv } from "@/lib/env-store";
import { getInstallationClient, parseRepository } from "@/lib/github";
import { requireInstallationId } from "@/lib/session";

export const dynamic = "force-dynamic";

async function verifyRepositoryAccess(installationId: number, repository: string) {
  const { owner, repo } = parseRepository(repository);
  const client = await getInstallationClient(installationId);
  await client.rest.repos.get({ owner, repo });
}

// The databases SBSB runs for this repository's on-premises app, as detected at analysis.
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const repository = request.nextUrl.searchParams.get("repository") ?? "";
    await verifyRepositoryAccess(installationId, repository);
    const databases = await listDatabases(installationId, repository);
    const userKeys = Object.keys(await getAppEnv(installationId, repository));
    const managed = managedDatabases(databases.map((database) => database.kind), userKeys);
    return NextResponse.json({
      databases: databases.map((database) => ({ ...database, managed: managed.includes(database.kind) })),
      connectionVariables: connectionVariableNames(managed),
    });
  } catch (error) {
    return apiError(error, 400);
  }
}

const revealSchema = z.object({
  repository: z.string().min(3).max(200),
  kind: z.enum(DATABASE_KINDS),
});

// Shows a generated password once on request, e.g. to connect through an SSH tunnel.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const input = revealSchema.parse(await request.json());
    await verifyRepositoryAccess(installationId, input.repository);
    const password = await revealDatabasePassword(installationId, input.repository, input.kind);
    return NextResponse.json({ password }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, 400);
  }
}
