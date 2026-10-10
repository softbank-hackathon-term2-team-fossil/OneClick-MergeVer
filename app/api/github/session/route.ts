import { NextRequest, NextResponse } from "next/server";
import { getInstallationClient } from "@/lib/github";
import {
  clearInstallationCookieOptions,
  INSTALLATION_COOKIE,
  requireInstallationId,
} from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (request.nextUrl.searchParams.get("reset") === "1") {
    const response = NextResponse.json({ connected: false });
    response.cookies.set(INSTALLATION_COOKIE, "", clearInstallationCookieOptions);
    return response;
  }

  try {
    const installationId = requireInstallationId(request);
    const client = await getInstallationClient(installationId);
    await client.rest.apps.getInstallation({ installation_id: installationId });
    return NextResponse.json({ connected: true });
  } catch {
    const response = NextResponse.json({ connected: false });
    response.cookies.set(INSTALLATION_COOKIE, "", clearInstallationCookieOptions);
    return response;
  }
}

export function DELETE(): NextResponse {
  const response = NextResponse.json({ connected: false });
  response.cookies.set(INSTALLATION_COOKIE, "", clearInstallationCookieOptions);
  return response;
}
