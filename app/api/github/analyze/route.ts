import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
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
    const client = await getInstallationClient(requireInstallationId(request));
    const analysis = await analyzeRepository(client, input.repository, input.branch);
    return NextResponse.json({ analysis });
  } catch (error) {
    return apiError(error, 400);
  }
}
