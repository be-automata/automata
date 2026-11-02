import { NextRequest, NextResponse } from "next/server";

import { forKnowledge } from "@terragon/shared/model/knowledge-access";

import { getTenantContextOrNull, isPlatformAdmin } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { isOrgAdmin } from "@/lib/org-role";
import { getPostHogServer } from "@/lib/posthog-server";

/**
 * POST /api/knowledge-settings/retry
 *
 * Org admin or platform admin. `{ intentId }` puts a failed reconcile intent of
 * the session org back to pending (attempts and backoff reset, logged). A
 * foreign, unknown or non-failed id returns the same 404.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = await getTenantContextOrNull();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ctx.organizationId) {
    return NextResponse.json(
      { error: "No active organization" },
      { status: 400 },
    );
  }
  const organizationId = ctx.organizationId;

  const [orgAdmin, platformAdmin] = await Promise.all([
    isOrgAdmin({ db, organizationId, userId: ctx.userId }),
    isPlatformAdmin(),
  ]);
  if (!orgAdmin && !platformAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const intentId = (raw as Record<string, unknown>).intentId;
  if (typeof intentId !== "string" || intentId === "") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { result } = await forKnowledge({
    db,
    organizationId,
  }).admin.retryIntent({
    intentId,
    actorUserId: ctx.userId,
    now: new Date(),
  });
  if (result === "not_found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  getPostHogServer().capture({
    distinctId: ctx.userId,
    event: "knowledge_intent_retried",
    properties: { organizationId },
  });

  return NextResponse.json({ result: "retried" });
}
