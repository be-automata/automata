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

export type ReviewRerunState = "pending" | "dispatched" | "skipped" | "failed";

export interface ReviewRerunRow {
  id: string;
  prKey: string;
  headSha: string;
  attempt: number;
  failedThreadId: string;
  state: ReviewRerunState;
  dueAt: Date;
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
  /** This run's own re-run could not be dispatched: post the notice. */
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
    .select({
      id: reviewRerun.id,
      prKey: reviewRerun.prKey,
      headSha: reviewRerun.headSha,
      attempt: reviewRerun.attempt,
      failedThreadId: reviewRerun.failedThreadId,
      state: reviewRerun.state,
      dueAt: reviewRerun.dueAt,
    })
    .from(reviewRerun)
    .where(and(eq(reviewRerun.prKey, prKey), eq(reviewRerun.headSha, headSha)))
    .orderBy(asc(reviewRerun.attempt));
}

function decideFromRows(
  rows: ReviewRerunRow[],
  failedThreadId: string,
): ReviewRerunDecision | null {
  const dispatched = rows.filter((row) => row.state === "dispatched").length;
  const own = rows.find((row) => row.failedThreadId === failedThreadId);
  if (own) {
    return own.state === "failed"
      ? { kind: "dispatch_failed", defer: false, attempts: dispatched }
      : {
          kind: "already_handed_off",
          defer: true,
          attempt: own.attempt,
          state: own.state,
        };
  }
  const pending = rows.find((row) => row.state === "pending");
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
  const decided = decideFromRows(rows, failedThreadId);
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
    decideFromRows(after, failedThreadId) ?? {
      // Unreachable while the indexes hold; defer rather than double-schedule.
      kind: "pending_for_head",
      defer: true,
      attempt,
    }
  );
}

/**
 * Claim the re-runs that are due. Each row moves pending → dispatched by a
 * compare-and-set, so two overlapping cron ticks never dispatch one row twice.
 * The claimant then dispatches or settles the row as skipped / failed.
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
      .set({ state: "dispatched" })
      .where(and(eq(reviewRerun.id, id), eq(reviewRerun.state, "pending")))
      .returning({
        id: reviewRerun.id,
        prKey: reviewRerun.prKey,
        headSha: reviewRerun.headSha,
        attempt: reviewRerun.attempt,
        failedThreadId: reviewRerun.failedThreadId,
        state: reviewRerun.state,
        dueAt: reviewRerun.dueAt,
      });
    if (row) claimed.push(row);
  }
  return claimed;
}

/**
 * Settle a claimed row that was not dispatched. Only a `dispatched` row moves,
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
    .where(and(eq(reviewRerun.id, id), eq(reviewRerun.state, "dispatched")))
    .returning({ id: reviewRerun.id });
  return rows.length > 0;
}
