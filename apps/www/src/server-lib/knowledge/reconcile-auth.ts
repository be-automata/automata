import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { RECONCILE_TOKEN_HEADER } from "@terragon/knowledge/reconcile-wire";
import { env } from "@terragon/env/apps-www";

// Shared auth of the three worker-facing knowledge reconcile routes. The
// secret is dedicated (KNOWLEDGE_RECONCILE_SECRET), an empty secret refuses
// everything, and the compare runs on sha256 digests so the lengths are equal
// and the comparison is constant-time. The presented value is never logged.

const digest = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

export function reconcileTokenMatches(
  secret: string,
  presented: string | null,
): boolean {
  if (secret === "" || presented === null || presented === "") return false;
  return timingSafeEqual(digest(secret), digest(presented));
}

/** One body for a missing, a wrong and a disabled secret. */
export function reconcileUnauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/** Null when authorized, otherwise the 401 to return before reading the body. */
export function requireReconcileAuth(request: Request): NextResponse | null {
  const presented = request.headers.get(RECONCILE_TOKEN_HEADER);
  return reconcileTokenMatches(env.KNOWLEDGE_RECONCILE_SECRET, presented)
    ? null
    : reconcileUnauthorized();
}
