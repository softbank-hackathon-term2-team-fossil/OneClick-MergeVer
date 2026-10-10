import { NextRequest } from "next/server";
import { z } from "zod";
import { azureAccount, listAzureVms } from "@/lib/azure-deploy";
import { azureDeploymentScope, publicCloudError } from "@/lib/cloud-config";

export const runtime = "nodejs";

const querySchema = z.object({
  region: z.string().min(3).max(30),
});

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const input = { ...querySchema.parse(Object.fromEntries(request.nextUrl.searchParams)), ...azureDeploymentScope() };
    await azureAccount(input.subscriptionId);
    const instances = (await listAzureVms(input)).map((vm) => ({
      id: vm.name,
      name: vm.name,
      state: vm.powerState || "알 수 없음",
      publicAddress: vm.publicIps?.split(",")[0].trim() || null,
    }));
    return Response.json({ region: input.region, instances });
  } catch (error) {
    return Response.json({ error: publicCloudError(error) }, { status: 400 });
  }
}
