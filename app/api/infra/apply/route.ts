import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { DeploymentError } from "@/lib/deployment-history";
import { InfraError, startApply } from "@/lib/infra/provision";
import { CLOUDS } from "@/lib/infra/spec";
import { requireInstallationId } from "@/lib/session";

export const runtime = "nodejs";

const schema = z.object({ repository: z.string().min(3).max(200), cloud: z.enum(CLOUDS), planId: z.string().uuid() });

// Starts applying an approved plan and returns immediately. Creating a database takes several
// minutes, so progress is read from /api/infra/status instead of holding this request open.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const input = schema.parse(await request.json());
    const job = await startApply({ installationId, repository: input.repository, cloud: input.cloud }, input.planId);
    return NextResponse.json({ job });
  } catch (error) {
    if (error instanceof InfraError || error instanceof DeploymentError) return NextResponse.json({ error: error.message }, { status: error.status });
    return apiError(error, 400);
  }
}
