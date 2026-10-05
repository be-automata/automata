import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  inArray,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import type { DB } from "../db";
import {
  auditFindings,
  auditFixAttempts,
  thread,
  threadChat,
} from "../db/schema";
import type { ThreadStatus } from "../db/types";
import type { AuditFindingRow, AuditFixAttemptRow } from "./audit-findings";
import { normalizeRepo } from "./repo-review-settings";
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

/**
 * Infra refund (RECON-01). Idempotent: true only for the call that refunded.
 * `outcome` defaults to "refunded"; a Drain/kill-switch cancel passes "killed"
 * (KILL-01) and is refunded all the same.
 */
export async function refundFixAttempt({
  db,
  organizationId,
  attemptId,
  cause,
  outcome = "refunded",
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  attemptId: string;
  cause: string;
  outcome?: string;
  now?: Date;
}): Promise<boolean> {
  return finishFixAttempt({
    db,
    organizationId,
    attemptId,
    outcome,
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

/**
 * The thread a fix attempt is bound to, as the reconcile reads it. Status is
 * the EFFECTIVE status: chat-mode threads (version > 0) keep their live status
 * on the newest threadChat row, legacy threads on the thread row. The typed
 * terminal cause and the error message are read from either row.
 */
export interface FixAttemptThreadState {
  attempt: AuditFixAttemptRow;
  /** null when the attempt has no thread (or the thread row is gone). */
  thread: {
    id: string;
    status: ThreadStatus;
    terminalCause: string | null;
    errorMessage: string | null;
    createdAt: Date;
  } | null;
}

/** Effective statuses after which a fix thread can no longer report. */
export const FIX_THREAD_TERMINAL_STATUSES: ThreadStatus[] = [
  "complete",
  "stopped",
  "error",
  "working-stopped",
];

function newestChat<T>(column: unknown) {
  return sql<T | null>`(select ${column} from ${threadChat} where ${threadChat.threadId} = ${thread.id} order by ${threadChat.updatedAt} desc limit 1)`;
}

const THREAD_STATE_COLUMNS = {
  attempt: auditFixAttempts,
  threadId: thread.id,
  threadVersion: thread.version,
  threadStatus: thread.status,
  threadTerminalCause: thread.terminalCause,
  threadErrorMessage: thread.errorMessage,
  threadCreatedAt: thread.createdAt,
  chatStatus: newestChat<ThreadStatus>(threadChat.status),
  chatTerminalCause: sql<
    string | null
  >`(select ${threadChat.terminalCause} from ${threadChat} where ${threadChat.threadId} = ${thread.id} and ${threadChat.terminalCause} is not null limit 1)`,
  chatErrorMessage: newestChat<string>(threadChat.errorMessage),
};

interface ThreadStateRow {
  attempt: AuditFixAttemptRow;
  threadId: string | null;
  threadVersion: number | null;
  threadStatus: ThreadStatus | null;
  threadTerminalCause: string | null;
  threadErrorMessage: string | null;
  threadCreatedAt: Date | null;
  chatStatus: ThreadStatus | null;
  chatTerminalCause: string | null;
  chatErrorMessage: string | null;
}

function toThreadState(row: ThreadStateRow): FixAttemptThreadState {
  if (
    row.threadId === null ||
    row.threadStatus === null ||
    row.threadCreatedAt === null
  ) {
    return { attempt: row.attempt, thread: null };
  }
  const chatMode = (row.threadVersion ?? 0) > 0;
  return {
    attempt: row.attempt,
    thread: {
      id: row.threadId,
      status: chatMode
        ? (row.chatStatus ?? row.threadStatus)
        : row.threadStatus,
      terminalCause: row.threadTerminalCause ?? row.chatTerminalCause,
      errorMessage: row.chatErrorMessage ?? row.threadErrorMessage,
      createdAt: row.threadCreatedAt,
    },
  };
}

/** Typed terminal cause, or a terminal status on the thread or any chat row. */
function threadIsTerminal() {
  const statuses = sql.join(
    FIX_THREAD_TERMINAL_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  return sql`(${thread.terminalCause} is not null or ${thread.status} in (${statuses}) or exists (select 1 from ${threadChat} where ${threadChat.threadId} = ${thread.id} and ${threadChat.status} in (${statuses})))`;
}

/**
 * UNFENCED (RECON-01): dispatched attempts whose dispatch lease has lapsed,
 * across all orgs, oldest lease first. The reconcile reads each one back from
 * Hatchet before deciding anything; rows carry organizationId and every write
 * that follows is fenced by it.
 */
export async function listStaleDispatchedAttempts({
  db,
  now = new Date(),
  limit = 20,
}: {
  db: DB;
  now?: Date;
  limit?: number;
}): Promise<FixAttemptThreadState[]> {
  const rows = await withSelfHealTx(db, (tx) =>
    tx
      .select(THREAD_STATE_COLUMNS)
      .from(auditFixAttempts)
      .leftJoin(thread, eq(thread.id, auditFixAttempts.threadId))
      .where(
        and(
          eq(auditFixAttempts.phase, "dispatched"),
          lt(auditFixAttempts.dispatchLeaseUntil, now),
        ),
      )
      .orderBy(asc(auditFixAttempts.dispatchLeaseUntil))
      .limit(limit),
  );
  return rows.map(toThreadState);
}

/**
 * UNFENCED (RES-10): attempts still 'dispatched' or 'checking' with no check
 * report whose thread has been terminal for at least `graceMs` (the newest
 * write to the thread or any of its chat rows is older than now - grace), so a
 * report still in flight is not pre-empted. Rows carry organizationId.
 */
export async function listTerminalUnreportedAttempts({
  db,
  now = new Date(),
  graceMs = 600_000,
  limit = 20,
}: {
  db: DB;
  now?: Date;
  graceMs?: number;
  limit?: number;
}): Promise<FixAttemptThreadState[]> {
  const cutoff = new Date(now.getTime() - graceMs);
  const rows = await withSelfHealTx(db, (tx) =>
    tx
      .select(THREAD_STATE_COLUMNS)
      .from(auditFixAttempts)
      .innerJoin(thread, eq(thread.id, auditFixAttempts.threadId))
      .where(
        and(
          inArray(auditFixAttempts.phase, ["dispatched", "checking"]),
          isNull(auditFixAttempts.checkReportedAt),
          threadIsTerminal(),
          lt(thread.updatedAt, cutoff),
          sql`not exists (select 1 from ${threadChat} where ${threadChat.threadId} = ${thread.id} and ${threadChat.updatedAt} >= ${sql.param(cutoff, threadChat.updatedAt)})`,
        ),
      )
      .orderBy(asc(thread.updatedAt))
      .limit(limit),
  );
  return rows.map(toThreadState);
}

/**
 * Push a dispatched attempt's lease forward after Hatchet showed its run
 * QUEUED or RUNNING. Applies only while the attempt is still 'dispatched'.
 */
export async function extendFixDispatchLease({
  db,
  organizationId,
  attemptId,
  until,
}: {
  db: DB;
  organizationId: string;
  attemptId: string;
  until: Date;
}): Promise<boolean> {
  const rows = await db
    .update(auditFixAttempts)
    .set({ dispatchLeaseUntil: until })
    .where(
      and(
        eq(auditFixAttempts.id, attemptId),
        eq(auditFixAttempts.organizationId, organizationId),
        eq(auditFixAttempts.phase, "dispatched"),
      ),
    )
    .returning({ id: auditFixAttempts.id });
  return rows.length > 0;
}

/** The PR opener holds an attempt for 10 minutes (RES-18). */
export const FIX_OPEN_LEASE_MS = 600_000;

/**
 * A report the route recorded but whose opener never ran (its waitUntil was
 * cut off) is picked up by the tick sweep after this grace.
 */
export const FIX_REPORT_SWEEP_GRACE_MS = 120_000;

/**
 * CAS on lease_until: true for exactly one caller while the lease is free or
 * expired. The route's opener and the tick sweep both claim it, so a passed
 * check is never opened twice. A closed attempt is never leased.
 */
export async function claimAttemptLease({
  db,
  organizationId,
  attemptId,
  leaseMs = FIX_OPEN_LEASE_MS,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  attemptId: string;
  leaseMs?: number;
  now?: Date;
}): Promise<boolean> {
  const rows = await db
    .update(auditFixAttempts)
    .set({ leaseUntil: new Date(now.getTime() + leaseMs) })
    .where(
      and(
        eq(auditFixAttempts.id, attemptId),
        eq(auditFixAttempts.organizationId, organizationId),
        ne(auditFixAttempts.phase, "closed"),
        or(
          isNull(auditFixAttempts.leaseUntil),
          lte(auditFixAttempts.leaseUntil, now),
        ),
      ),
    )
    .returning({ id: auditFixAttempts.id });
  return rows.length > 0;
}

/** Give the lease back so a scheduled retry is not held for the full lease. */
export async function releaseAttemptLease({
  db,
  organizationId,
  attemptId,
}: {
  db: DB;
  organizationId: string;
  attemptId: string;
}): Promise<void> {
  await db
    .update(auditFixAttempts)
    .set({ leaseUntil: null })
    .where(
      and(
        eq(auditFixAttempts.id, attemptId),
        eq(auditFixAttempts.organizationId, organizationId),
      ),
    );
}

/**
 * UNFENCED (RES-18): attempts the opener still owes a decision, across all
 * orgs, with a free lease: a pending open whose backoff is due, or a recorded
 * check report nobody processed within the grace (the route's waitUntil was
 * cut off). Rows carry organizationId; every later call re-fences on it.
 */
export async function listPendingPrOpens({
  db,
  now = new Date(),
  limit = 20,
  graceMs = FIX_REPORT_SWEEP_GRACE_MS,
}: {
  db: DB;
  now?: Date;
  limit?: number;
  graceMs?: number;
}): Promise<AuditFixAttemptRow[]> {
  const reportCutoff = new Date(now.getTime() - graceMs);
  return withSelfHealTx(db, (tx) =>
    tx
      .select()
      .from(auditFixAttempts)
      .where(
        and(
          ne(auditFixAttempts.phase, "closed"),
          or(
            isNull(auditFixAttempts.leaseUntil),
            lte(auditFixAttempts.leaseUntil, now),
          ),
          or(
            and(
              eq(auditFixAttempts.prState, "pending_open"),
              lte(auditFixAttempts.nextPrOpenAt, now),
            ),
            and(
              eq(auditFixAttempts.phase, "checking"),
              isNull(auditFixAttempts.prState),
              lte(auditFixAttempts.checkReportedAt, reportCutoff),
            ),
          ),
        ),
      )
      .orderBy(
        asc(
          sql`coalesce(${auditFixAttempts.nextPrOpenAt}, ${auditFixAttempts.checkReportedAt})`,
        ),
      )
      .limit(limit),
  );
}

/** The finding an attempt belongs to, inside the org fence. */
export async function getFindingForAttempt({
  db,
  organizationId,
  findingId,
}: {
  db: DB;
  organizationId: string;
  findingId: string;
}): Promise<AuditFindingRow | null> {
  const rows = await db
    .select()
    .from(auditFindings)
    .where(
      and(
        eq(auditFindings.id, findingId),
        eq(auditFindings.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Fix PR lifecycle (R5): merges and human closes. Observation only — the
// platform never merges; these record what a person did on GitHub.
// ---------------------------------------------------------------------------

/** A merged fix is watched for regressions for 30 days. */
export const FIX_REGRESSION_WINDOW_MS = 30 * 86_400_000;

/** New-side line ranges a merged fix PR touched, per file. */
export type FixChangedRanges = Array<{
  file: string;
  ranges: Array<[number, number]>;
}>;

/**
 * UNFENCED (T-09-14-1): a pull_request webhook carries no organization; its
 * signature is the authority. The row carries organizationId and every
 * later call re-fences on it. The repo compares case-insensitively; the
 * newest attempt for the PR wins.
 */
export async function getFixAttemptByPr({
  db,
  repoFullName,
  prNumber,
}: {
  db: DB;
  repoFullName: string;
  prNumber: number;
}): Promise<AuditFixAttemptRow | null> {
  const rows = await db
    .select()
    .from(auditFixAttempts)
    .where(
      and(
        eq(auditFixAttempts.prNumber, prNumber),
        sql`lower(${auditFixAttempts.repoFullName}) = ${normalizeRepo(repoFullName)}`,
      ),
    )
    .orderBy(desc(auditFixAttempts.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Record a person's merge, exactly once (merged_at is the CAS). The attempt
 * is finished (phase closed, outcome merged, pr_state merged) and its
 * 30-day regression window starts at the merge. The finding's active
 * attempt is cleared when it is this one, and a finding with no attempt in
 * flight leaves the fix queue (fix_ready_at null): the fix is on the default
 * branch and the next audit decides. The commit and file detail may be null
 * here and filled by recordFixPrMergeDetail once GitHub has been read.
 */
export async function recordFixPrMerged({
  db,
  organizationId,
  attemptId,
  mergedAt,
  mergeSha,
  mergedBy,
  humanCommitCount,
  changedRanges,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  attemptId: string;
  mergedAt: Date;
  mergeSha: string | null;
  mergedBy: string | null;
  humanCommitCount: number | null;
  changedRanges: FixChangedRanges | null;
  now?: Date;
}): Promise<boolean> {
  return withSelfHealTx(db, async (tx) => {
    const merged = await tx
      .update(auditFixAttempts)
      .set({
        mergedAt,
        mergeSha,
        mergedBy,
        humanCommitCount,
        changedRanges,
        regressionWindowEndsAt: new Date(
          mergedAt.getTime() + FIX_REGRESSION_WINDOW_MS,
        ),
        outcome: "merged",
        prState: "merged",
        phase: "closed",
        leaseUntil: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(auditFixAttempts.id, attemptId),
          eq(auditFixAttempts.organizationId, organizationId),
          isNull(auditFixAttempts.mergedAt),
        ),
      )
      .returning({ findingId: auditFixAttempts.findingId });
    const row = merged[0];
    if (!row) return false;
    await tx
      .update(auditFindings)
      .set({ activeAttemptId: null, activeThreadId: null })
      .where(
        and(
          eq(auditFindings.id, row.findingId),
          eq(auditFindings.organizationId, organizationId),
          eq(auditFindings.activeAttemptId, attemptId),
        ),
      );
    await tx
      .update(auditFindings)
      .set({ fixReadyAt: null })
      .where(
        and(
          eq(auditFindings.id, row.findingId),
          eq(auditFindings.organizationId, organizationId),
          isNull(auditFindings.activeAttemptId),
        ),
      );
    return true;
  });
}

/** The GitHub-read half of a recorded merge (commit authors, hunks). */
export async function recordFixPrMergeDetail({
  db,
  organizationId,
  attemptId,
  humanCommitCount,
  changedRanges,
}: {
  db: DB;
  organizationId: string;
  attemptId: string;
  humanCommitCount: number | null;
  changedRanges: FixChangedRanges | null;
}): Promise<boolean> {
  const rows = await db
    .update(auditFixAttempts)
    .set({ humanCommitCount, changedRanges })
    .where(
      and(
        eq(auditFixAttempts.id, attemptId),
        eq(auditFixAttempts.organizationId, organizationId),
        isNotNull(auditFixAttempts.mergedAt),
      ),
    )
    .returning({ id: auditFixAttempts.id });
  return rows.length > 0;
}

/**
 * Record that the fix PR closed unmerged ('closed' by a person, 'expired'
 * by the platform). Only the PR state: counting the attempt is
 * closeFixAttempt's job. A merged or expired PR state is never overwritten.
 */
export async function recordFixPrClosed({
  db,
  organizationId,
  attemptId,
  state,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  attemptId: string;
  state: "closed" | "expired";
  now?: Date;
}): Promise<boolean> {
  const rows = await db
    .update(auditFixAttempts)
    .set({ prState: state, updatedAt: now })
    .where(
      and(
        eq(auditFixAttempts.id, attemptId),
        eq(auditFixAttempts.organizationId, organizationId),
        isNull(auditFixAttempts.mergedAt),
        or(
          isNull(auditFixAttempts.prState),
          notInArray(auditFixAttempts.prState, ["merged", "expired"]),
        ),
      ),
    )
    .returning({ id: auditFixAttempts.id });
  return rows.length > 0;
}

/**
 * UNFENCED (R5): attempts still open whose PR GitHub already reported merged
 * or closed (an adopted PR, or a draft the CI evaluator saw a person close
 * or merge) with a free lease, across all orgs, oldest first. The lifecycle
 * sweep settles them when no webhook did. Rows carry organizationId.
 */
export async function listUnsettledFixPrs({
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
          ne(auditFixAttempts.phase, "closed"),
          isNotNull(auditFixAttempts.prNumber),
          inArray(auditFixAttempts.prState, ["merged", "closed"]),
          or(
            isNull(auditFixAttempts.leaseUntil),
            lte(auditFixAttempts.leaseUntil, now),
          ),
        ),
      )
      .orderBy(asc(auditFixAttempts.updatedAt))
      .limit(limit),
  );
}
