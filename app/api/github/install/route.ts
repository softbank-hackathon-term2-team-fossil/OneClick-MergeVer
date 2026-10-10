import { NextResponse } from "next/server";
import { getGitHubInstallUrl } from "@/lib/github";
import { apiError } from "@/lib/api";
import {
  createInstallState,
  INSTALL_STATE_COOKIE,
  installStateCookieOptions,
} from "@/lib/session";

export function GET(): NextResponse {
  try {
    const state = createInstallState();
    const url = new URL(getGitHubInstallUrl());
    url.searchParams.set("state", state);
    const response = NextResponse.redirect(url);
    response.cookies.set(INSTALL_STATE_COOKIE, state, installStateCookieOptions);
    return response;
  } catch (error) {
    return apiError(error, 503);
  }
}
