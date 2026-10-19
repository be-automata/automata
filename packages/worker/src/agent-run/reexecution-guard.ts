import { NonRetryableError } from "@hatchet-dev/typescript-sdk";

/**
 * The re-execution guard (#371; ADR-007 Decision 5 amendment).
 *
 * The run task registers `retries` so the engine can re-queue an admission
 * deferral. But the engine also retries failures IT decides on its own —
 * measured on hatchet-lite v0.94.10: an `executionTimeout` is retried under
 * the task's retry policy (attempts 0, 1, 2 all executed). The worker's fence
 * (fenceNonRetryable) never sees those, so without this guard a review that
 * hit its 30-minute timeout would be re-cloned and re-run — a second review
 * post or push. An agent run never re-executes.
 *
 * The rule: this worker counts the deferrals it threw per WORKFLOW RUN (the
 * engine's run id — stable across that run's retries, distinct for every run
 * of a thread: supersede siblings, re-reviews; never the threadId). An attempt
 * number above that count did not come from a deferral, so it is refused up
 * front with a NonRetryableError, before any side effect (no namespace, no
 * slot, no clone). In-process state is enough: one worker runs a box and the
 * engine retries on it. A worker restart between attempts forgets the ledger
 * and refuses the next attempt too — fail-closed; a redelivery after a worker
 * death was never a retry the run could honour either.
 *
 * Bounded: an entry whose retry never comes back to this worker (the budget
 * ran out, a cancel while QUEUED in backoff) is pruned once it is older than
 * the longest a retry can legitimately take to return — the whole deferral
 * budget plus one scheduleTimeout.
 */
const deferrals = new Map<string, { count: number; at: number }>();

/** Σbackoff budget (12 min) + one scheduleTimeout (30 m), with margin. */
export const LEDGER_TTL_MS = 45 * 60 * 1000;

function prune(now: number): void {
  for (const [key, entry] of deferrals) {
    if (now - entry.at > LEDGER_TTL_MS) deferrals.delete(key);
  }
}

/** The headroom check deferred this run once more (the only retryable throw). */
export function recordDeferral(runKey: string, now = Date.now()): void {
  prune(now);
  deferrals.set(runKey, {
    count: (deferrals.get(runKey)?.count ?? 0) + 1,
    at: now,
  });
}

export function deferralsRecorded(runKey: string): number {
  return deferrals.get(runKey)?.count ?? 0;
}

/** How many runs the ledger currently tracks (tests, boot line). */
export function ledgerSize(): number {
  return deferrals.size;
}

/**
 * Refuse an attempt the deferral ledger does not account for. Call FIRST in
 * the run, before any side effect. Throws NonRetryableError (final).
 */
export function assertNotReexecuting(runKey: string, attempt: number): void {
  const deferred = deferralsRecorded(runKey);
  if (attempt > deferred) {
    throw new NonRetryableError(
      `attempt ${attempt + 1} of this run follows a failure that was not an admission deferral ` +
        `(${deferred} deferral(s) recorded on this worker — an execution timeout, or a worker restart ` +
        `between attempts); an agent run never re-executes`,
    );
  }
}

/** The run ended on this worker (completed, failed final, cancelled, or its last deferral): drop its ledger entry. */
export function forgetRun(runKey: string): void {
  deferrals.delete(runKey);
}

export function _resetReexecutionGuardForTests(): void {
  deferrals.clear();
}
