import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const INSTALL_STATE_COOKIE = "sbsb_install_state";
export const INSTALLATION_COOKIE = "sbsb_installation";

const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

function getSecret(): string {
  const secret = process.env.SBSB_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("SBSB_SESSION_SECRET must contain at least 32 characters.");
  }
  return secret;
}

function signature(value: string): string {
  return createHmac("sha256", getSecret()).update(value).digest("base64url");
}

function sign(value: string): string {
  return `${value}.${signature(value)}`;
}

function verify(signedValue: string | undefined): string | null {
  if (!signedValue) return null;
  const separator = signedValue.lastIndexOf(".");
  if (separator < 1) return null;
  const value = signedValue.slice(0, separator);
  const received = signedValue.slice(separator + 1);
  const expected = signature(value);
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  if (
    receivedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(receivedBytes, expectedBytes)
  ) {
    return null;
  }
  return value;
}

export function createInstallState(): string {
  return sign(randomBytes(24).toString("base64url"));
}

export function validateInstallState(
  queryState: string | null,
  cookieState: string | undefined,
): boolean {
  if (!queryState || !cookieState || queryState !== cookieState) return false;
  return verify(queryState) !== null;
}

export function createInstallationSession(installationId: number): string {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error("GitHub returned an invalid installation ID.");
  }
  return sign(String(installationId));
}

export function requireInstallationId(request: NextRequest): number {
  const value = verify(request.cookies.get(INSTALLATION_COOKIE)?.value);
  const installationId = Number(value);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error("Connect the SBSB GitHub App before using this endpoint.");
  }
  return installationId;
}

export const installStateCookieOptions = {
  ...sessionCookieOptions,
  maxAge: 10 * 60,
};

export const installationCookieOptions = {
  ...sessionCookieOptions,
  maxAge: 7 * 24 * 60 * 60,
};

export const clearInstallationCookieOptions = {
  ...sessionCookieOptions,
  maxAge: 0,
  expires: new Date(0),
};
