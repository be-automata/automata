import { NextRequest, NextResponse } from "next/server";

import {
  resetBreaker,
  type BreakerScopeKind,
} from "@terragon/shared/model/self-heal-breaker";

import { hatchetConfig } from "@/agent/hatchet/dispatch";
import {
  cancelAgentRun,
  listAgentRunsForThread,
} from "@/agent/hatchet/transport";
import { getTenantContextOrNull } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { isOrgAdmin } from "@/lib/org-role";
import { drainSelfHeal } from "@/server-lib/audit/self-heal-drain";

/**
 * POST /api/self-heal/actions (KILL-01, BRK-01)
 *
 * Operator controls for the self-heal loop, org admins only and fenced to the
 * session's active organization:
 *   { action: "drain" }                              kill switch + cancel in-flight runs
 *   { action: "reset_breaker", scopeKind, scopeKey } re-arm one breaker (any state)
 * Both write an actor-log row. Toggling the mode never resets a breaker; only
 * this action does.
 */

const BREAKER_SCOPE_KINDS: readonly BreakerScopeKind[] = [
  "github_write",
  "github_read",
  "permission",
  "hatchet_dispatch",
  "exec_plane",
  "loop_fix",
  "loop_audit",
];

/** Engine lookup budget per thread: one signal, and a page cap. */
const LOOKUP_TIMEOUT_MS = 5_000;
const LOOKUP_MAX_PAGES = 3;

function isBreakerScopeKind(value: unknown): value is BreakerScopeKind {
  return (
    typeof value === "string" &&
    (BREAKER_SCOPE_KINDS as readonly string[]).includes(value)
  );
}

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
  if (!(await isOrgAdmin({ db, organizationId, userId: ctx.userId }))) {
    return NextResponse.json(
      { error: "Only organization admins can run self-heal actions." },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;

  if (input.action === "drain") {
    const config = hatchetConfig();
    const result = await drainSelfHeal({
      db,
      organizationId,
      actorUserId: ctx.userId,
      deps: {
        listRuns: (hint) =>
          listAgentRunsForThread(hint, config, {
            signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
            maxPages: LOOKUP_MAX_PAGES,
          }),
        cancel: (externalIds) => cancelAgentRun(externalIds, config),
        now: () => new Date(),
        log: (message, fields) => console.log(message, fields ?? {}),
      },
    });
    return NextResponse.json(result);
  }

  if (input.action === "reset_breaker") {
    const { scopeKind, scopeKey } = input;
    if (
      !isBreakerScopeKind(scopeKind) ||
      typeof scopeKey !== "string" ||
      scopeKey.length === 0 ||
      scopeKey.length > 256
    ) {
      return NextResponse.json(
        { error: "scopeKind and scopeKey are required" },
        { status: 400 },
      );
    }
    await resetBreaker({
      db,
      organizationId,
      scopeKind,
      scopeKey,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ reset: true, scopeKind, scopeKey });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
