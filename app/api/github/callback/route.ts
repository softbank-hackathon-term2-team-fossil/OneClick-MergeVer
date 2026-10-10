import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api";
import {
  createInstallationSession,
  INSTALL_STATE_COOKIE,
  INSTALLATION_COOKIE,
  installationCookieOptions,
  validateInstallState,
} from "@/lib/session";

export function GET(request: NextRequest): NextResponse {
  try {
    const state = request.nextUrl.searchParams.get("state");
    const cookieState = request.cookies.get(INSTALL_STATE_COOKIE)?.value;
    if (!validateInstallState(state, cookieState)) {
      throw new Error("The GitHub installation state is invalid or expired.");
    }

    const installationId = Number(
      request.nextUrl.searchParams.get("installation_id"),
    );
    const session = createInstallationSession(installationId);
    const publicUrl = process.env.SBSB_PUBLIC_URL?.trim();
    const redirectBase = publicUrl ? new URL(publicUrl) : new URL(request.url);
    const response = NextResponse.redirect(
      new URL("/?connected=1", redirectBase),
    );
    response.cookies.set(
      INSTALLATION_COOKIE,
      session,
      installationCookieOptions,
    );
    response.cookies.delete(INSTALL_STATE_COOKIE);
    return response;
  } catch (error) {
    return apiError(error, 400);
  }
}
