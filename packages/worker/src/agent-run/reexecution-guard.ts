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
 * The rule: this worker counts the deferrals it threw per thread. An attempt
 * number above that count did not come from a deferral, so it is refused up
 * front with a NonRetryableError, before any side effect (no namespace, no
 * slot, no clone). In-process state is enough: one worker runs a box and the
 * engine retries on it. A worker restart between attempts forgets the ledger
 * and refuses the next attempt too — fail-closed; a redelivery after a worker
 * death was never a retry the run could honour either.
 */
const deferrals = new Map<string, number>();

/** The headroom check deferred this thread once more (the only retryable throw). */
export function recordDeferral(threadId: string): void {
  deferrals.set(threadId, (deferrals.get(threadId) ?? 0) + 1);
}

export function deferralsRecorded(threadId: string): number {
  return deferrals.get(threadId) ?? 0;
}

/**
 * Refuse an attempt the deferral ledger does not account for. Call FIRST in
 * the run, before any side effect. Throws NonRetryableError (final).
 */
export function assertNotReexecuting(threadId: string, attempt: number): void {
  const deferred = deferralsRecorded(threadId);
  if (attempt > deferred) {
    throw new NonRetryableError(
      `attempt ${attempt + 1} of this run follows a failure that was not an admission deferral ` +
        `(${deferred} deferral(s) recorded on this worker — an execution timeout, or a worker restart ` +
        `between attempts); an agent run never re-executes`,
    );
  }
}

/** The run ended (completed, failed final, or cancelled): drop its ledger entry. */
export function forgetRun(threadId: string): void {
  deferrals.delete(threadId);
}

export function _resetReexecutionGuardForTests(): void {
  deferrals.clear();
}
