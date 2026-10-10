import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { getStatus } from "@/lib/infra/provision";
import { CLOUDS } from "@/lib/infra/spec";
import { terraformVersion } from "@/lib/infra/terraform";
import { requireInstallationId } from "@/lib/session";

export const dynamic = "force-dynamic";

const schema = z.object({ repository: z.string().min(3).max(200), cloud: z.enum(CLOUDS) });

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const input = schema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const [status, terraform] = await Promise.all([getStatus({ installationId, ...input }), terraformVersion()]);
    return NextResponse.json({ ...status, terraform });
  } catch (error) {
    return apiError(error, 400);
  }
}
