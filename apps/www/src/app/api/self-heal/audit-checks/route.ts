import { and, eq, sql, type SQL } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { selfHealTokenMatches } from "@/server-lib/audit/plan-self-heal-run";
import { thread, threadChat } from "@terragon/shared/db/schema";
import {
  getAuditRunForCheckReport,
  recordAuditCheckResults,
  type AuditCheckResult,
} from "@terragon/shared/model/audit-findings";

/**
 * POST /api/self-heal/audit-checks
 *
 * The audit lane's deterministic-check report (R2, FORGE-01). The worker runs
 * the platform-defined checks on a pristine checkout BEFORE the agent starts
 * and reports here once. Closure decisions rest on these outcomes, so the
 * endpoint is deliberately narrower than the daemon endpoints:
 *
 *  - Authority is a per-run check token minted by www at dispatch, delivered in
 *    the run payload to the worker process only, never placed in the daemon or
 *    agent environment. The daemon token is NOT accepted. Only the sha256 is
 *    stored; the compare is constant-time on equal-length digests.
 *  - The report is sealed once the thread has any agent message: anything in a
 *    run (including the agent) could otherwise post a late "pass".
 *  - The first report wins (single write). Every requested fingerprint the
 *    report omits is recorded as "error", so a partial report can never read
 *    as a pass.
 *  - organizationId comes from the run row, never from the body.
 *
 * Logs carry threadId and counts only, never the token.
 */

const MAX_RESULTS = 50;
const TOKEN_HEADER = "x-self-heal-check-token";

const bodySchema = z.object({
  threadId: z.string().uuid(),
  results: z
    .array(
      z.object({
        fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
        outcome: z.enum(["pass", "fail", "error"]),
      }),
    )
    .max(MAX_RESULTS),
});

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function hasAgentMessage(messages: SQL): SQL {
  return sql`exists (
    select 1
    from jsonb_array_elements(
      case when jsonb_typeof(${messages}) = 'array' then ${messages} else '[]'::jsonb end
    ) as m
    where m->>'type' = 'agent'
  )`;
}

/** True when any chat of the thread (or the legacy thread row) holds an agent message. */
async function threadHasAgentMessage(threadId: string): Promise<boolean> {
  const [chatRows, legacyRows] = await Promise.all([
    db
      .select({ id: threadChat.id })
      .from(threadChat)
      .where(
        and(
          eq(threadChat.threadId, threadId),
          hasAgentMessage(sql`${threadChat.messages}`),
        ),
      )
      .limit(1),
    db
      .select({ id: thread.id })
      .from(thread)
      .where(
        and(eq(thread.id, threadId), hasAgentMessage(sql`${thread.messages}`)),
      )
      .limit(1),
  ]);
  return chatRows.length > 0 || legacyRows.length > 0;
}

function requestedFingerprints(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { fingerprint } = entry as Record<string, unknown>;
    if (typeof fingerprint === "string") out.add(fingerprint);
  }
  return out;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const presented = request.headers.get(TOKEN_HEADER);
  if (!presented) return unauthorized();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { threadId, results } = parsed.data;

  const run = await getAuditRunForCheckReport({ db, threadId });
  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (
    !run.checkTokenHash ||
    !run.checkTokenExpiresAt ||
    run.checkTokenExpiresAt.getTime() <= Date.now() ||
    !selfHealTokenMatches(presented, run.checkTokenHash)
  ) {
    return unauthorized();
  }

  if (await threadHasAgentMessage(threadId)) {
    console.warn("[self-heal] audit-checks: report after agent output", {
      threadId,
    });
    return NextResponse.json({ error: "sealed" }, { status: 409 });
  }

  const requested = requestedFingerprints(run.requestedChecks);
  const accepted = new Map<string, AuditCheckResult["outcome"]>();
  let ignored = 0;
  for (const result of results) {
    if (
      !requested.has(result.fingerprint) ||
      accepted.has(result.fingerprint)
    ) {
      ignored += 1;
      continue;
    }
    accepted.set(result.fingerprint, result.outcome);
  }
  let sealedAsError = 0;
  for (const fingerprint of requested) {
    if (!accepted.has(fingerprint)) {
      accepted.set(fingerprint, "error");
      sealedAsError += 1;
    }
  }

  const recorded = await recordAuditCheckResults({
    db,
    organizationId: run.organizationId,
    threadId,
    results: [...accepted].map(([fingerprint, outcome]) => ({
      fingerprint,
      outcome,
    })),
  });
  console.log("[self-heal] audit-checks reported", {
    threadId,
    recorded,
    accepted: accepted.size - sealedAsError,
    ignored,
    sealedAsError,
  });
  return NextResponse.json({ recorded, ignored, sealedAsError });
}
