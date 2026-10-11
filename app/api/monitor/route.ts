import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { listDeployments } from "@/lib/deployment-history";
import { getInstallationClient, parseRepository } from "@/lib/github";
import { monitorRegistry } from "@/lib/monitor-actions";
import { requireInstallationId } from "@/lib/session";

export const runtime = "nodejs";

async function authorize(request: NextRequest, repository: string): Promise<number> {
  const installationId = requireInstallationId(request);
  const { owner, repo } = parseRepository(repository);
  const client = await getInstallationClient(installationId);
  await client.rest.repos.get({ owner, repo });
  return installationId;
}

const keyFor = (repository: string, target: string) => `${repository}#${target}`;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const repository = request.nextUrl.searchParams.get("repository") ?? "";
    await authorize(request, repository);
    return NextResponse.json({ monitors: monitorRegistry().list(repository) });
  } catch (error) {
    return apiError(error, 400);
  }
}

const schema = z.object({
  repository: z.string().min(3).max(200),
  target: z.enum(["ONPREM", "CLOUD_RUN"]),
  action: z.enum(["start", "stop", "check"]),
  intervalSec: z.coerce.number().int().min(5).max(600).default(30),
  threshold: z.coerce.number().int().min(1).max(20).default(3),
  autoRollback: z.boolean().default(true),
});

// Starts, stops or runs one check of the health monitor for the currently serving deployment of a target.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const input = schema.parse(await request.json());
    const installationId = await authorize(request, input.repository);
    const registry = monitorRegistry();
    const key = keyFor(input.repository, input.target);

    if (input.action === "stop") {
      const snapshot = registry.stop(key);
      return NextResponse.json({ monitor: snapshot });
    }
    if (input.action === "check") {
      const snapshot = await registry.checkNow(key);
      if (!snapshot) throw new Error("실행 중인 모니터가 없습니다. 먼저 시작하세요.");
      return NextResponse.json({ monitor: snapshot });
    }

    const records = await listDeployments(installationId, input.repository, 30);
    const serving = records.find((record) => record.target === input.target && record.status === "SUCCESS" && record.current && record.url);
    if (!serving?.url) throw new Error("이 대상에 현재 서비스 중인 배포가 없습니다.");
    const snapshot = registry.start({
      key,
      repository: input.repository,
      target: input.target,
      url: serving.url,
      intervalSec: input.intervalSec,
      threshold: input.threshold,
      autoRollback: input.autoRollback,
      installationId,
    });
    return NextResponse.json({ monitor: snapshot });
  } catch (error) {
    return apiError(error, 400);
  }
}
