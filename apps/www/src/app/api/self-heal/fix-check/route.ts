import { and, eq, inArray, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { waitUntil } from "@/lib/wait-until";
import { openDraftFixPr } from "@/server-lib/audit/open-fix-pr";
import {
  deriveFixCheckStatus,
  selfHealTokenMatches,
  type FixCheckStatus,
} from "@/server-lib/audit/plan-self-heal-run";
import { auditFixAttempts } from "@terragon/shared/db/schema";
import type { AuditFixAttemptRow } from "@terragon/shared/model/audit-findings";
import { getFixAttemptForGateReport } from "@terragon/shared/model/audit-fix-attempts";

/**
 * POST /api/self-heal/fix-check
 *
 * The fix lane's finding-check report (GATE-01, R1). After the fix agent
 * exits, the worker runs ONLY the finding's deterministic check on a clean
 * checkout of the pushed HEAD and reports here once. A draft PR can only be
 * opened from a `passed` report, so the endpoint is as narrow as the audit
 * lane's:
 *
 *  - Authority is the attempt's gate token, minted by www at dispatch and
 *    delivered in the run payload to the worker process only. The daemon
 *    token is NOT accepted. Only the sha256 is stored; the compare is
 *    constant-time on equal-length digests; an expired token is refused. A
 *    missing, wrong or expired token gets one identical 401.
 *  - Single use: the first report wins (check_reported_at CAS); a later one
 *    is answered 200 { recorded: false } and changes nothing. A report for an
 *    attempt the reconcile already closed is not recorded either.
 *  - `passed` only when the worker completed, the check passed and no denied
 *    path was touched. A check error is never a pass.
 *  - organizationId comes from the attempt row, never from the body.
 *  - Only a RECORDED report hands the attempt to the draft-PR opener
 *    (waitUntil, once). The opener decides every verdict's outcome; if the
 *    waitUntil is cut off, the tick's runFixPrOpenSweep picks the attempt up.
 *
 * Logs carry attemptId and the verdict only, never the token.
 */

const TOKEN_HEADER = "x-self-heal-gate-token";
const MAX_DENIED_PATHS = 50;
const MAX_PATH_LENGTH = 300;
const REPORTABLE_PHASES: AuditFixAttemptRow["phase"][] = [
  "dispatched",
  "checking",
];

const bodySchema = z
  .object({
    attemptId: z.string().uuid(),
    workerStatus: z.enum(["completed", "aborted", "error", "no_branch"]),
    headSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    checkOutcome: z.enum(["pass", "fail", "error"]).nullable(),
    deniedPaths: z
      .array(z.string().min(1).max(MAX_PATH_LENGTH))
      .max(MAX_DENIED_PATHS),
  })
  // A completed run gates a specific commit; without it nothing can be bound.
  .refine((body) => body.workerStatus !== "completed" || body.headSha !== null);

/**
 * The stored check_status (passed | failed | error): no_branch is a counted
 * failure, aborted an error that is refunded later. The full verdict is kept
 * in check_results.status.
 */
const STORED_CHECK_STATUS: Record<
  FixCheckStatus,
  "passed" | "failed" | "error"
> = {
  passed: "passed",
  failed: "failed",
  no_branch: "failed",
  error: "error",
  aborted: "error",
};

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
  const { attemptId, workerStatus, headSha, checkOutcome, deniedPaths } =
    parsed.data;

  const attempt = await getFixAttemptForGateReport({ db, attemptId });
  if (!attempt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const now = new Date();
  if (
    !attempt.gateTokenHash ||
    !attempt.gateTokenExpiresAt ||
    attempt.gateTokenExpiresAt.getTime() <= now.getTime() ||
    !selfHealTokenMatches(presented, attempt.gateTokenHash)
  ) {
    return unauthorized();
  }

  const status = deriveFixCheckStatus({
    workerStatus,
    checkOutcome,
    deniedPaths,
  });
  const written = await db
    .update(auditFixAttempts)
    .set({
      checkStatus: STORED_CHECK_STATUS[status],
      checkResults: { status, workerStatus, checkOutcome },
      gatedHeadSha: headSha,
      deniedPaths,
      checkReportedAt: now,
      phase: "checking",
      updatedAt: now,
    })
    .where(
      and(
        eq(auditFixAttempts.id, attempt.id),
        eq(auditFixAttempts.organizationId, attempt.organizationId),
        // The token checked above is still the attempt's token.
        eq(auditFixAttempts.gateTokenHash, attempt.gateTokenHash),
        isNull(auditFixAttempts.checkReportedAt),
        inArray(auditFixAttempts.phase, REPORTABLE_PHASES),
      ),
    )
    .returning({ id: auditFixAttempts.id });
  const recorded = written.length > 0;

  if (recorded) {
    waitUntil(
      openDraftFixPr({
        db,
        organizationId: attempt.organizationId,
        attemptId: attempt.id,
      }),
    );
  }

  console.log("[self-heal] fix-check reported", {
    attemptId: attempt.id,
    status,
    recorded,
    workerStatus,
    deniedPaths: deniedPaths.length,
  });
  return NextResponse.json({ recorded, status });
}
