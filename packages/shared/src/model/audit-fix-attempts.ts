import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";

import type { DB } from "../db";
import { auditFindings, auditFixAttempts } from "../db/schema";
import type { AuditFindingRow, AuditFixAttemptRow } from "./audit-findings";
import { withSelfHealTx, type SelfHealTx } from "./self-heal-tx";

/**
 * Fix-attempt ledger (Phase 9): leased claims, an idempotent thread bind and
 * refunds (RACE-01, LEASE-01, RECON-01).
 *
 * MULTI-TENANT (ADR-001): every function takes `organizationId` and filters on
 * it, except the ones named in UNFENCED_SELF_HEAL_MODEL_FUNCTIONS
 * (self-heal-breaker.ts), which are cross-org by design.
 */

/** A fix claim (and a fresh dispatch) is leased for 10 minutes (LEASE-01). */
export const FIX_ATTEMPT_LEASE_MS = 600_000;
export const FIX_DISPATCH_LEASE_MS = 600_000;

export type AuditFixAttemptInsert = typeof auditFixAttempts.$inferInsert;

export interface ClaimedFixAttempt {
  finding: AuditFindingRow;
  attempt: AuditFixAttemptRow;
}

export interface ClaimFixAttemptInput {
  db: DB;
  organizationId: string;
  findingId: string;
  maxAttempts: number;
  cooldownMin: number;
  /** Branch name for the attempt number (fixBranchName in www). */
  branchFor: (attemptNo: number) => string;
  leaseMs?: number;
  now?: Date;
  /**
   * Run inside the caller's transaction (it must come from withSelfHealTx) so
   * a breaker probe can share the claim's atomicity. Default: own transaction.
   */
  tx?: SelfHealTx;
}

/**
 * ONE compare-and-set: the finding must be open, script, fix-ready, under the
 * attempts cap, outside the cooldown and hold no active attempt. The winner
 * increments attempts, stamps last_attempt_at and active_attempt_id, and inserts
 * the attempt ('claimed', leased). Concurrent claims serialise on the finding
 * row lock and the loser re-evaluates the predicate to zero rows → null.
 */
export async function claimFixAttempt({
  db,
  organizationId,
  findingId,
  maxAttempts,
  cooldownMin,
  branchFor,
  leaseMs = FIX_ATTEMPT_LEASE_MS,
  now = new Date(),
  tx,
}: ClaimFixAttemptInput): Promise<ClaimedFixAttempt | null> {
  const cooldownCutoff = new Date(now.getTime() - cooldownMin * 60_000);
  const claimExpiresAt = new Date(now.getTime() + leaseMs);
  const attemptId = randomUUID();

  const body = async (t: SelfHealTx): Promise<ClaimedFixAttempt | null> => {
    const findings = await t
      .update(auditFindings)
      .set({
        attempts: sql`${auditFindings.attempts} + 1`,
        lastAttemptAt: now,
        activeAttemptId: attemptId,
      })
      .where(
        and(
          eq(auditFindings.id, findingId),
          eq(auditFindings.organizationId, organizationId),
          eq(auditFindings.status, "open"),
          eq(auditFindings.checkKind, "script"),
          isNotNull(auditFindings.fixReadyAt),
          lt(auditFindings.attempts, maxAttempts),
          isNull(auditFindings.activeAttemptId),
          or(
            isNull(auditFindings.lastAttemptAt),
            lte(auditFindings.lastAttemptAt, cooldownCutoff),
          ),
        ),
      )
      .returning();
    const finding = findings[0];
    if (!finding) return null;

    // Refunded attempts keep their row, so the number is max+1, not the
    // (refund-decremented) attempts counter. The finding row lock serialises this.
    const [last] = await t
      .select({ attemptNo: auditFixAttempts.attemptNo })
      .from(auditFixAttempts)
      .where(
        and(
          eq(auditFixAttempts.findingId, findingId),
          eq(auditFixAttempts.organizationId, organizationId),
        ),
      )
      .orderBy(desc(auditFixAttempts.attemptNo))
      .limit(1);
    const attemptNo = (last?.attemptNo ?? 0) + 1;

    const attempts = await t
      .insert(auditFixAttempts)
      .values({
        id: attemptId,
        organizationId,
        repoFullName: finding.repoFullName,
        findingId,
        attemptNo,
        branch: branchFor(attemptNo),
        phase: "claimed",
        claimedAt: now,
        claimExpiresAt,
        gateKind: "ci-draft",
      })
      .returning();
    const attempt = attempts[0];
    if (!attempt) {
      throw new Error("claimFixAttempt: attempt insert returned no row");
    }
    return { finding, attempt };
  };

  return tx ? body(tx) : withSelfHealTx(db, body);
}

/**
 * Idempotent CAS bind, callable from the dispatcher and the dispatch planner:
 * whichever runs first binds, the other is a no-op (true for the same thread,
 * false for a different one or an attempt no longer 'claimed').
 */
export async function bindFixAttemptThread({
  db,
  organizationId,
  attemptId,
  threadId,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  attemptId: string;
  threadId: string;
  now?: Date;
}): Promise<boolean> {
  return withSelfHealTx(db, async (tx) => {
    const bound = await tx
      .update(auditFixAttempts)
      .set({
        threadId,
        phase: "dispatched",
        dispatchLeaseUntil: new Date(now.getTime() + FIX_DISPATCH_LEASE_MS),
      })
      .where(
        and(
          eq(auditFixAttempts.id, attemptId),
          eq(auditFixAttempts.organizationId, organizationId),
          isNull(auditFixAttempts.threadId),
          eq(auditFixAttempts.phase, "claimed"),
        ),
      )
      .returning({ findingId: auditFixAttempts.findingId });
    const row = bound[0];
    if (row) {
      await tx
        .update(auditFindings)
        .set({ activeThreadId: threadId })
        .where(
          and(
            eq(auditFindings.id, row.findingId),
            eq(auditFindings.organizationId, organizationId),
            eq(auditFindings.activeAttemptId, attemptId),
          ),
        );
      return true;
    }
    const same = await tx
      .select({ id: auditFixAttempts.id })
      .from(auditFixAttempts)
      .where(
        and(
          eq(auditFixAttempts.id, attemptId),
          eq(auditFixAttempts.organizationId, organizationId),
          eq(auditFixAttempts.threadId, threadId),
        ),
      )
      .limit(1);
    return same.length > 0;
  });
}

/** UNFENCED: the reconcile sweep finds lost dispatches across all orgs. */
export async function listExpiredFixClaims({
  db,
  now = new Date(),
  limit = 20,
}: {
  db: DB;
  now?: Date;
  limit?: number;
}): Promise<AuditFixAttemptRow[]> {
  return withSelfHealTx(db, (tx) =>
    tx
      .select()
      .from(auditFixAttempts)
      .where(
        and(
          eq(auditFixAttempts.phase, "claimed"),
          isNull(auditFixAttempts.threadId),
          lt(auditFixAttempts.claimExpiresAt, now),
        ),
      )
      .orderBy(asc(auditFixAttempts.claimExpiresAt))
      .limit(limit),
  );
}

const SEVERITY_ORDER = sql`case ${auditFindings.severity} when 'high' then 2 when 'medium' then 1 else 0 end`;

/**
 * UNFENCED: the dispatcher's selector across all orgs; callers re-fence by the
 * row's organizationId on every subsequent call.
 */
export async function listFixReadyFindings({
  db,
  limit = 20,
}: {
  db: DB;
  limit?: number;
}): Promise<AuditFindingRow[]> {
  return withSelfHealTx(db, (tx) =>
    tx
      .select()
      .from(auditFindings)
      .where(
        and(
          isNotNull(auditFindings.fixReadyAt),
          eq(auditFindings.autoFixLabeled, true),
          eq(auditFindings.status, "open"),
          eq(auditFindings.checkKind, "script"),
          isNull(auditFindings.activeAttemptId),
        ),
      )
      .orderBy(desc(SEVERITY_ORDER), asc(auditFindings.fixReadyAt))
      .limit(limit),
  );
}

/**
 * Close the attempt and release the finding. Counted keeps the spent attempt;
 * uncounted refunds it (attempts - 1, never below 0) and marks infra_refunded.
 * last_attempt_at is kept either way, so the cooldown still applies. Only an
 * attempt that is not already closed and not refunded can be closed.
 */
async function finishFixAttempt({
  db,
  organizationId,
  attemptId,
  outcome,
  counted,
  terminalCause,
  now,
}: {
  db: DB;
  organizationId: string;
  attemptId: string;
  outcome: string;
  counted: boolean;
  terminalCause: string | null;
  now: Date;
}): Promise<boolean> {
  return withSelfHealTx(db, async (tx) => {
    const closed = await tx
      .update(auditFixAttempts)
      .set({
        phase: "closed",
        outcome,
        terminalCause,
        infraRefunded: !counted,
        updatedAt: now,
      })
      .where(
        and(
          eq(auditFixAttempts.id, attemptId),
          eq(auditFixAttempts.organizationId, organizationId),
          eq(auditFixAttempts.infraRefunded, false),
          ne(auditFixAttempts.phase, "closed"),
        ),
      )
      .returning({ findingId: auditFixAttempts.findingId });
    const row = closed[0];
    if (!row) return false;
    await tx
      .update(auditFindings)
      .set({
        ...(counted
          ? {}
          : { attempts: sql`greatest(${auditFindings.attempts} - 1, 0)` }),
        activeAttemptId: null,
        activeThreadId: null,
      })
      .where(
        and(
          eq(auditFindings.id, row.findingId),
          eq(auditFindings.organizationId, organizationId),
          eq(auditFindings.activeAttemptId, attemptId),
        ),
      );
    return true;
  });
}

/** Infra refund (RECON-01). Idempotent: true only for the call that refunded. */
export async function refundFixAttempt({
  db,
  organizationId,
  attemptId,
  cause,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  attemptId: string;
  cause: string;
  now?: Date;
}): Promise<boolean> {
  return finishFixAttempt({
    db,
    organizationId,
    attemptId,
    outcome: "refunded",
    counted: false,
    terminalCause: cause,
    now,
  });
}

export async function closeFixAttempt({
  db,
  organizationId,
  attemptId,
  outcome,
  counted,
  terminalCause,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  attemptId: string;
  outcome: string;
  counted: boolean;
  terminalCause?: string;
  now?: Date;
}): Promise<boolean> {
  return finishFixAttempt({
    db,
    organizationId,
    attemptId,
    outcome,
    counted,
    terminalCause: terminalCause ?? null,
    now,
  });
}

export async function getFixAttemptById({
  db,
  organizationId,
  id,
}: {
  db: DB;
  organizationId: string;
  id: string;
}): Promise<AuditFixAttemptRow | null> {
  const rows = await db
    .select()
    .from(auditFixAttempts)
    .where(
      and(
        eq(auditFixAttempts.id, id),
        eq(auditFixAttempts.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getFixAttemptByThread({
  db,
  organizationId,
  threadId,
}: {
  db: DB;
  organizationId: string;
  threadId: string;
}): Promise<AuditFixAttemptRow | null> {
  const rows = await db
    .select()
    .from(auditFixAttempts)
    .where(
      and(
        eq(auditFixAttempts.threadId, threadId),
        eq(auditFixAttempts.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** UNFENCED: the gate token is the authority; the row carries organizationId. */
export async function getFixAttemptForGateReport({
  db,
  attemptId,
}: {
  db: DB;
  attemptId: string;
}): Promise<AuditFixAttemptRow | null> {
  const rows = await db
    .select()
    .from(auditFixAttempts)
    .where(eq(auditFixAttempts.id, attemptId))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateFixAttempt({
  db,
  organizationId,
  id,
  patch,
}: {
  db: DB;
  organizationId: string;
  id: string;
  patch: Partial<
    Omit<
      AuditFixAttemptInsert,
      "id" | "organizationId" | "repoFullName" | "findingId" | "attemptNo"
    >
  >;
}): Promise<AuditFixAttemptRow | null> {
  const rows = await db
    .update(auditFixAttempts)
    .set(patch)
    .where(
      and(
        eq(auditFixAttempts.id, id),
        eq(auditFixAttempts.organizationId, organizationId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
