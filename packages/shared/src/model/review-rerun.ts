import { and, asc, eq, lte } from "drizzle-orm";
import { DB } from "../db";
import { reviewRerun } from "../db/schema";

/**
 * #107: bounded automatic re-runs of a review whose run failed before it
 * produced a verdict. The ledger (`review_rerun`) is the only state; its two
 * UNIQUE indexes are the bounds (see the schema comment).
 *
 * Budget: at most REVIEW_RERUN_MAX_ATTEMPTS re-runs per (prKey, headSha), so a
 * head is reviewed by at most 1 + MAX runs that this mechanism started. A new
 * push is a new head and a fresh budget; a closed PR or a moved head is
 * skipped at dispatch.
 */
export const REVIEW_RERUN_MAX_ATTEMPTS = 2;

/** Backoff before attempt N (index N-1): ~1 min, then ~3 min. */
export const REVIEW_RERUN_BACKOFF_MS: readonly number[] = [60_000, 180_000];

/**
 * How long a claimed row may sit before its claimant is presumed dead (a
 * deploy, an OOM, a cron timeout between the claim and the dispatch). A
 * normal claim → dispatch takes seconds. Also how long a due row may wait
 * unclaimed (the dispatcher cron not running) before it stops deferring.
 */
export const REVIEW_RERUN_CLAIM_LEASE_MS = 10 * 60_000;

/**
 * pending → claimed (a cron tick owns it, lease running) → dispatched (the
 * re-run started) | skipped | failed. A claim whose lease lapses becomes
 * `failed` (claim_expired), never re-claimed: the claimant may have started
 * the run just before it died, and a second dispatch could double it.
 */
export type ReviewRerunState =
  | "pending"
  | "claimed"
  | "dispatched"
  | "skipped"
  | "failed";

export interface ReviewRerunRow {
  id: string;
  prKey: string;
  headSha: string;
  attempt: number;
  failedThreadId: string;
  state: ReviewRerunState;
  dueAt: Date;
  updatedAt: Date;
}

const ROW_COLUMNS = {
  id: reviewRerun.id,
  prKey: reviewRerun.prKey,
  headSha: reviewRerun.headSha,
  attempt: reviewRerun.attempt,
  failedThreadId: reviewRerun.failedThreadId,
  state: reviewRerun.state,
  dueAt: reviewRerun.dueAt,
  updatedAt: reviewRerun.updatedAt,
};

/**
 * A row nobody will move any more: claimed with a lapsed lease, or pending
 * long past due (the dispatcher is not running). It must not defer a notice:
 * ADR-009 forbids leaving a PR with neither a re-run nor a notice.
 */
export function isStalledReviewRerun(
  row: Pick<ReviewRerunRow, "state" | "dueAt" | "updatedAt">,
  now: Date,
): boolean {
  const cutoff = now.getTime() - REVIEW_RERUN_CLAIM_LEASE_MS;
  if (row.state === "claimed") return row.updatedAt.getTime() <= cutoff;
  if (row.state === "pending") return row.dueAt.getTime() <= cutoff;
  return false;
}

/**
 * What a failed run's no-verdict path should do. `defer` = a re-run owns this
 * head's outcome, so no notice now; otherwise post the notice, saying how many
 * re-runs already happened.
 */
export type ReviewRerunDecision =
  /** A new re-run was scheduled by this run. */
  | { kind: "scheduled"; defer: true; attempt: number; dueAt: Date }
  /** This run already handed off (the finish hook and the sweep both read it). */
  | {
      kind: "already_handed_off";
      defer: true;
      attempt: number;
      state: ReviewRerunState;
    }
  /** Another failed run at this head already has a re-run waiting. */
  | { kind: "pending_for_head"; defer: true; attempt: number }
  /**
   * The head used its whole budget: post the notice. `attempts` counts the
   * re-runs that were actually dispatched (what the notice may claim).
   */
  | { kind: "exhausted"; defer: false; attempts: number }
  /**
   * This run's own re-run could not be dispatched (refused, errored, or its
   * claim lapsed): post the notice.
   */
  | { kind: "dispatch_failed"; defer: false; attempts: number };

function backoffFor(attempt: number): number {
  return (
    REVIEW_RERUN_BACKOFF_MS[attempt - 1] ??
    REVIEW_RERUN_BACKOFF_MS[REVIEW_RERUN_BACKOFF_MS.length - 1] ??
    60_000
  );
}

async function rowsForHead(
  db: DB,
  prKey: string,
  headSha: string,
): Promise<ReviewRerunRow[]> {
  return await db
    .select(ROW_COLUMNS)
    .from(reviewRerun)
    .where(and(eq(reviewRerun.prKey, prKey), eq(reviewRerun.headSha, headSha)))
    .orderBy(asc(reviewRerun.attempt));
}

function decideFromRows(
  rows: ReviewRerunRow[],
  failedThreadId: string,
  now: Date,
): ReviewRerunDecision | null {
  const dispatched = rows.filter((row) => row.state === "dispatched").length;
  const own = rows.find((row) => row.failedThreadId === failedThreadId);
  if (own) {
    return own.state === "failed" || isStalledReviewRerun(own, now)
      ? { kind: "dispatch_failed", defer: false, attempts: dispatched }
      : {
          kind: "already_handed_off",
          defer: true,
          attempt: own.attempt,
          state: own.state,
        };
  }
  // A live re-run (waiting, or claimed within its lease) owns the head.
  const pending = rows.find(
    (row) =>
      (row.state === "pending" || row.state === "claimed") &&
      !isStalledReviewRerun(row, now),
  );
  if (pending) {
    return { kind: "pending_for_head", defer: true, attempt: pending.attempt };
  }
  if (rows.length >= REVIEW_RERUN_MAX_ATTEMPTS) {
    return { kind: "exhausted", defer: false, attempts: dispatched };
  }
  return null;
}

/**
 * Decide, and when the budget allows schedule, the re-run for a run that
 * ended without a verdict at `headSha`. Idempotent per failed thread: a second
 * call for the same thread returns its existing hand-off and inserts nothing.
 * Two different failed runs racing at one head get one re-run between them
 * (the attempt UNIQUE index); the loser defers to it.
 */
export async function planReviewRerun({
  db,
  prKey,
  headSha,
  failedThreadId,
  now = new Date(),
}: {
  db: DB;
  prKey: string;
  headSha: string;
  failedThreadId: string;
  now?: Date;
}): Promise<ReviewRerunDecision> {
  const rows = await rowsForHead(db, prKey, headSha);
  const decided = decideFromRows(rows, failedThreadId, now);
  if (decided) return decided;

  const attempt = Math.max(0, ...rows.map((row) => row.attempt)) + 1;
  const dueAt = new Date(now.getTime() + backoffFor(attempt));
  const inserted = await db
    .insert(reviewRerun)
    .values({ prKey, headSha, attempt, failedThreadId, dueAt })
    .onConflictDoNothing()
    .returning({ id: reviewRerun.id });
  if (inserted.length > 0) {
    return { kind: "scheduled", defer: true, attempt, dueAt };
  }
  // Lost a race: either this thread's row landed concurrently (the hook and
  // the sweep at once) or another failed run took this attempt number. Re-read
  // and answer from the winner's row.
  const after = await rowsForHead(db, prKey, headSha);
  return (
    decideFromRows(after, failedThreadId, now) ?? {
      // Unreachable while the indexes hold; defer rather than double-schedule.
      kind: "pending_for_head",
      defer: true,
      attempt,
    }
  );
}

/**
 * Claim the re-runs that are due. Each row moves pending → claimed by a
 * compare-and-set (stamping the lease start), so two overlapping cron ticks
 * never dispatch one row twice. The claimant then marks it dispatched, or
 * settles it skipped / failed; a claimant that dies leaves a claim that
 * `expireStaleReviewRerunClaims` turns into `failed` once the lease lapses.
 */
export async function claimDueReviewReruns({
  db,
  now = new Date(),
  limit = 10,
}: {
  db: DB;
  now?: Date;
  limit?: number;
}): Promise<ReviewRerunRow[]> {
  const due = await db
    .select({ id: reviewRerun.id })
    .from(reviewRerun)
    .where(and(eq(reviewRerun.state, "pending"), lte(reviewRerun.dueAt, now)))
    .orderBy(asc(reviewRerun.dueAt))
    .limit(limit);
  const claimed: ReviewRerunRow[] = [];
  for (const { id } of due) {
    const [row] = await db
      .update(reviewRerun)
      .set({ state: "claimed", updatedAt: now })
      .where(and(eq(reviewRerun.id, id), eq(reviewRerun.state, "pending")))
      .returning(ROW_COLUMNS);
    if (row) claimed.push(row);
  }
  return claimed;
}

/** The claimed re-run started. Only a `claimed` row moves. */
export async function markReviewRerunDispatched({
  db,
  id,
}: {
  db: DB;
  id: string;
}): Promise<boolean> {
  const rows = await db
    .update(reviewRerun)
    .set({ state: "dispatched" })
    .where(and(eq(reviewRerun.id, id), eq(reviewRerun.state, "claimed")))
    .returning({ id: reviewRerun.id });
  return rows.length > 0;
}

/**
 * Settle a claimed row that was not dispatched. Only a `claimed` row moves,
 * so a settle never rewrites a row another path already settled.
 */
export async function settleReviewRerun({
  db,
  id,
  state,
  reason,
}: {
  db: DB;
  id: string;
  state: "skipped" | "failed";
  reason: string;
}): Promise<boolean> {
  const rows = await db
    .update(reviewRerun)
    .set({ state, outcomeReason: reason })
    .where(and(eq(reviewRerun.id, id), eq(reviewRerun.state, "claimed")))
    .returning({ id: reviewRerun.id });
  return rows.length > 0;
}

/**
 * Claims whose lease lapsed (the claimant died between the claim and the
 * dispatch) become `failed` with reason `claim_expired`. They are never
 * re-claimed: the dead claimant may already have started the run. The failed
 * run's next no-verdict pass then posts the notice. Returns the expired rows.
 */
export async function expireStaleReviewRerunClaims({
  db,
  now = new Date(),
}: {
  db: DB;
  now?: Date;
}): Promise<ReviewRerunRow[]> {
  return await db
    .update(reviewRerun)
    .set({ state: "failed", outcomeReason: "claim_expired" })
    .where(
      and(
        eq(reviewRerun.state, "claimed"),
        lte(
          reviewRerun.updatedAt,
          new Date(now.getTime() - REVIEW_RERUN_CLAIM_LEASE_MS),
        ),
      ),
    )
    .returning(ROW_COLUMNS);
}
