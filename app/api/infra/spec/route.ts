import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { dockerfilePort } from "@/lib/dockerfile-port";
import { getInstallationClient } from "@/lib/github";
import { inferSpec, ruleBasedDraft } from "@/lib/infra/ai";
import { collectConfigFiles } from "@/lib/infra/evidence";
import { generateText } from "@/lib/llm";
import { analyzeRepository } from "@/lib/repository-analysis";
import { requireInstallationId } from "@/lib/session";

export const maxDuration = 120;

const schema = z.object({ repository: z.string().min(3).max(200), branch: z.string().min(1).max(250) });

// Reads the repository and drafts the deployment spec. The draft is shown in a form; nothing
// is created until a person reviews it and approves a plan.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const input = schema.parse(await request.json());
    const client = await getInstallationClient(requireInstallationId(request));
    const [analysis, config] = await Promise.all([
      analyzeRepository(client, input.repository, input.branch),
      collectConfigFiles(client, input.repository, input.branch),
    ]);
    const known = new Set(config.map((file) => file.path));
    const files = [...config, ...analysis.files.filter((file) => !known.has(file.path))];
    const dockerfile = config.find((file) => /(^|\/)Dockerfile$/.test(file.path));
    const port = dockerfile ? dockerfilePort(dockerfile.content) : null;
    try {
      return NextResponse.json({ draft: await inferSpec(input.repository, files, port, generateText), files: files.map((file) => file.path) });
    } catch (error) {
      const draft = ruleBasedDraft(input.repository, files, port);
      draft.warnings.unshift(`AI 분석을 쓸 수 없어 규칙으로만 채웠습니다 (${error instanceof Error ? error.message.slice(0, 120) : "오류"}).`);
      return NextResponse.json({ draft, files: files.map((file) => file.path) });
    }
  } catch (error) {
    return apiError(error, 400);
  }
}
