import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { parseEnvText, validateAppEnv } from "@/lib/app-env";
import { getAppEnv, setAppEnv } from "@/lib/env-store";
import { getInstallationClient, parseRepository } from "@/lib/github";
import { requireInstallationId } from "@/lib/session";

export const runtime = "nodejs";

async function authorize(request: NextRequest, repository: string): Promise<number> {
  const installationId = requireInstallationId(request);
  const { owner, repo } = parseRepository(repository);
  const client = await getInstallationClient(installationId);
  await client.rest.repos.get({ owner, repo });
  return installationId;
}

// Names only: values are write-only, so a stolen browser session cannot read secrets back.
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const repository = request.nextUrl.searchParams.get("repository") ?? "";
    const installationId = await authorize(request, repository);
    return NextResponse.json({ names: Object.keys(await getAppEnv(installationId, repository)).sort() });
  } catch (error) {
    return apiError(error, 400);
  }
}

const putSchema = z.object({
  repository: z.string().min(3).max(200),
  // "KEY=value" lines to add or replace.
  text: z.string().max(40_000).optional(),
  // Names to delete.
  remove: z.array(z.string().max(64)).max(40).optional(),
});

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const input = putSchema.parse(await request.json());
    const installationId = await authorize(request, input.repository);
    const next = { ...(await getAppEnv(installationId, input.repository)), ...(input.text ? parseEnvText(input.text) : {}) };
    for (const name of input.remove ?? []) delete next[name];
    await setAppEnv(installationId, input.repository, validateAppEnv(next));
    return NextResponse.json({ names: Object.keys(next).sort() });
  } catch (error) {
    return apiError(error, 400);
  }
}
