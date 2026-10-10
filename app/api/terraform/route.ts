import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api";
import { requireInstallationId } from "@/lib/session";
import { runTerraform } from "@/lib/terraform";

export const runtime = "nodejs";
export const maxDuration = 1_800;

const schema = z.object({
  provider: z.enum(["gcp", "oci"]),
  action: z.enum(["plan", "apply", "destroy"]),
  image: z.string().max(300).default(""),
  port: z.coerce.number().int().min(1).max(65_535).default(8000),
});

// Creates or removes a VM and a managed PostgreSQL database with the Terraform modules in infra/terraform.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    requireInstallationId(request);
    const input = schema.parse(await request.json());
    const result = await runTerraform(input.provider, input.action, { image: input.image, port: input.port });
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error, 400);
  }
}
