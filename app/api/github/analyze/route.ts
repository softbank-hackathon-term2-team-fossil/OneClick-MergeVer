import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { detectDatabases } from "@/lib/database/detect";
import { syncDetectedDatabases } from "@/lib/database/store";
import { getInstallationClient } from "@/lib/github";
import { analyzeRepository } from "@/lib/repository-analysis";
import { requireInstallationId } from "@/lib/session";

const schema = z.object({
  repository: z.string().min(3).max(200),
  branch: z.string().min(1).max(250),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const input = schema.parse(await request.json());
    const installationId = requireInstallationId(request);
    const client = await getInstallationClient(installationId);
    const analysis = await analyzeRepository(client, input.repository, input.branch);
    // Databases are decided once, at setup: on-premises deployments run what is recorded here.
    const databases = detectDatabases(analysis.files);
    await syncDetectedDatabases(installationId, input.repository, databases);
    return NextResponse.json({ analysis, databases });
  } catch (error) {
    return apiError(error, 400);
  }
}
