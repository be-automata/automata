import { NextResponse } from "next/server";

import {
  formatServerTiming,
  GithubListingUnavailableError,
  type GithubListingTiming,
} from "@/server-lib/github-listing-cache";

/**
 * Shared response shaping for the GitHub listing routes
 * (/api/github/repos, /api/github/installations). Every response is per-user
 * and must never be stored by a browser or CDN cache.
 */
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export function listingJson(
  body: unknown,
  timing: GithubListingTiming,
): NextResponse {
  return NextResponse.json(body, {
    headers: { ...NO_STORE, "Server-Timing": formatServerTiming(timing) },
  });
}

export function listingUnauthorized(): NextResponse {
  return NextResponse.json(
    { error: "Unauthorized" },
    { status: 401, headers: NO_STORE },
  );
}

/**
 * A GitHub failure is a 502 with a message, never an empty list: the
 * dashboard treats a failed load differently from "no repos".
 */
export function listingError(error: unknown, label: string): NextResponse {
  if (error instanceof GithubListingUnavailableError) {
    console.warn(`[${label}] GitHub listing failed`, error.cause);
    return NextResponse.json(
      { error: error.message },
      { status: 502, headers: NO_STORE },
    );
  }
  console.error(`[${label}] unexpected error`, error);
  return NextResponse.json(
    { error: "An unexpected error occurred" },
    { status: 500, headers: NO_STORE },
  );
}

export function wantsRefresh(request: Request): boolean {
  return new URL(request.url).searchParams.get("refresh") === "1";
}
