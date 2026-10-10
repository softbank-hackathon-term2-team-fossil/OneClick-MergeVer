import { NextRequest, NextResponse } from "next/server";
import { accountRegion, listInstances } from "@/lib/aws-deploy";
import { apiError } from "@/lib/api";
import { publicCloudError } from "@/lib/cloud-config";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const account = await accountRegion(request.nextUrl.searchParams.get("region") || undefined);
    const instances = (await listInstances(account.region)).map((instance) => ({
      id: instance.InstanceId,
      name: instance.Tags?.find((tag) => tag.Key === "Name")?.Value || instance.InstanceId,
      state: instance.State.Name,
      publicAddress: instance.PublicDnsName || instance.PublicIpAddress || null,
    }));
    return NextResponse.json({ ...account, instances });
  } catch (error) {
    return apiError(new Error(publicCloudError(error)), 400);
  }
}
