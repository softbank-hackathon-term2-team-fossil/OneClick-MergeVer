import { NextResponse } from "next/server";
import { cloudRunTarget } from "@/lib/deploy/cloud-run-target";

export const runtime = "nodejs";

// Cloud Run has no servers to pick. This mirrors the AWS/Azure "instances" response so the
// deployment panel can check availability the same way for every provider.
export async function GET(): Promise<NextResponse> {
  const target = cloudRunTarget();
  if (!target) {
    return NextResponse.json({ error: "Cloud Run 대상이 서버에 설정되지 않았습니다." }, { status: 400 });
  }
  return NextResponse.json({ region: target.location, instances: [] });
}
