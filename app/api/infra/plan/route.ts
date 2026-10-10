import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { publicCloudError } from "@/lib/cloud-config";
import { getInstallationClient } from "@/lib/github";
import { listImageVersions } from "@/lib/image-versions";
import { createPlan, getStatus, InfraError, lastPlannedInput } from "@/lib/infra/provision";
import { CLOUDS, infraSpecSchema } from "@/lib/infra/spec";
import { requireInstallationId } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 900;

const deploy = z.object({
  action: z.literal("deploy"),
  repository: z.string().min(3).max(200),
  branch: z.string().min(1).max(250),
  cloud: z.enum(CLOUDS),
  imageTag: z.string().regex(/^[a-f0-9]{40}$/i),
  spec: infraSpecSchema,
  secretEnv: z.record(z.string(), z.string().max(4_000)).default({}),
});
const destroy = z.object({ action: z.literal("destroy"), repository: z.string().min(3).max(200), cloud: z.enum(CLOUDS) });

// Produces a verified plan and nothing else. No cloud resource changes until /api/infra/apply
// is called with this plan's id.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const installationId = requireInstallationId(request);
    const input = z.discriminatedUnion("action", [deploy, destroy]).parse(await request.json());
    const scope = { installationId, repository: input.repository, cloud: input.cloud };

    if (input.action === "destroy") {
      const { deployed, hasResources } = await getStatus(scope);
      // A deployment that failed half-way has no "deployed" record but still has resources to remove.
      const last = deployed ? { spec: deployed.spec, image: deployed.image } : await lastPlannedInput(scope);
      if (!hasResources || !last) throw new InfraError("이 클라우드에 Terraform으로 만든 자원이 없습니다.");
      const plan = await createPlan(scope, { spec: last.spec, image: last.image, imageTag: deployed?.imageTag ?? "", secretEnv: {}, destroy: true });
      return NextResponse.json({ plan });
    }

    const client = await getInstallationClient(installationId);
    const versions = await listImageVersions(client, input.repository, input.branch);
    const selected = versions.find((version) => version.tag === input.imageTag.toLowerCase());
    if (!selected) throw new InfraError("선택한 이미지 버전을 Docker Hub에서 찾을 수 없습니다. 버전 목록을 새로고침하세요.");
    const plan = await createPlan(scope, { spec: input.spec, image: selected.image, imageTag: selected.tag, secretEnv: input.secretEnv });
    return NextResponse.json({ plan });
  } catch (error) {
    if (error instanceof InfraError) {
      return NextResponse.json({ error: publicCloudError(error), detail: error.detail ?? null }, { status: error.status });
    }
    return apiError(error, 400);
  }
}
