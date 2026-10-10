import { NextRequest } from "next/server";
import { z } from "zod";
import { accountRegion, listInstances } from "@/lib/aws-deploy";
import { publicCloudError } from "@/lib/cloud-config";

export const runtime = "nodejs";

const inputSchema = z.object({
  region: z.string().min(5).max(30),
  instanceId: z.string().regex(/^i-[0-9a-f]{8,17}$/),
});

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const input = inputSchema.parse(await request.json());
    const { region } = await accountRegion(input.region);
    const instance = (await listInstances(region)).find((item) => item.InstanceId === input.instanceId);
    if (!instance || instance.State.Name !== "running") throw new Error("실행 중인 EC2를 선택하세요.");
    const address = instance.PublicDnsName || instance.PublicIpAddress;
    if (!address) throw new Error("EC2에 공개 주소가 없습니다.");
    const url = `http://${address}/`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store", redirect: "manual" });
    if (response.status >= 500) throw new Error(`앱이 HTTP ${response.status} 오류를 반환했습니다.`);
    return Response.json({ url, instanceId: instance.InstanceId, status: response.status });
  } catch (error) {
    return Response.json({ error: publicCloudError(error) }, { status: 400 });
  }
}
