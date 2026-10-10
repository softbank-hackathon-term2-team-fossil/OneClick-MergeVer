import { NextRequest } from "next/server";
import { z } from "zod";
import { azureAccount, listAzureVms, verifyAzureUrl } from "@/lib/azure-deploy";
import { azureDeploymentScope, publicCloudError } from "@/lib/cloud-config";

export const runtime = "nodejs";

const inputSchema = z.object({
  region: z.string().min(3).max(30),
  instanceId: z.string().min(1).max(64),
});

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const input = { ...inputSchema.parse(await request.json()), ...azureDeploymentScope() };
    await azureAccount(input.subscriptionId);
    const vm = (await listAzureVms(input)).find((item) => item.name === input.instanceId);
    if (!vm || !/running/i.test(vm.powerState || "")) throw new Error("실행 중인 Azure VM을 선택하세요.");
    const address = vm.publicIps?.split(",")[0].trim();
    if (!address) throw new Error("Azure VM에 공인 IP가 없습니다.");
    const url = `http://${address}/`;
    const status = await verifyAzureUrl(url);
    return Response.json({ url, instanceId: vm.name, status });
  } catch (error) {
    return Response.json({ error: publicCloudError(error) }, { status: 400 });
  }
}
