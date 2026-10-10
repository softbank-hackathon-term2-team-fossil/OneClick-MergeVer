import { NextResponse } from "next/server";

export function apiError(error: unknown, status = 500): NextResponse {
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  return NextResponse.json({ error: message }, { status });
}
