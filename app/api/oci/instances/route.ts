import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api";
import { requireInstallationId } from "@/lib/session";
import { runTerraform } from "@/lib/terraform";

export const runtime = "nodejs";
export const maxDuration = 300;

type OciInstance = { id: string; name: string; state: string; shape: string; publicAddress: string | null };

// Lists the VMs of the OCI compartment so the deployment panel can offer "existing VM" like EC2.
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    requireInstallationId(request);
    const result = await runTerraform("oci-instances", "apply");
    const instances = (Array.isArray(result.outputs.instances) ? result.outputs.instances : []) as OciInstance[];
    return NextResponse.json({ instances });
  } catch (error) {
    return apiError(error, 400);
  }
}
