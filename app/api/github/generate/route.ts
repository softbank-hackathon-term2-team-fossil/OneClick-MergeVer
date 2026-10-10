import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { generateDockerfile } from "@/lib/dockerfile-generator";
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
    if (analysis.files.length === 0) {
      throw new Error("No safe build files were found for Dockerfile generation.");
    }
    const dockerfile = await generateDockerfile(analysis);
    return NextResponse.json({
      setup: {
        dockerfile,
        framework: analysis.framework,
        filesSharedWithAi: analysis.files.map((file) => file.path),
      },
    });
  } catch (error) {
    return apiError(error, 400);
  }
}
