/**
 * The backoff of the admission deferral (#371, ADR-007 Decision 5).
 *
 * A deferral is waited out IN PROCESS: the run gives its box slot back, sleeps
 * the backoff (abortable by the engine's cancel), and tries admission again —
 * never as an engine retry. Measured on hatchet-lite v0.94.10 (the IT records
 * both facts): the engine retries its OWN failures (an executionTimeout) under
 * the task's retry policy, which would re-execute an agent; and a retried
 * attempt re-enters a CANCEL_IN_PROGRESS group as the newest item, cancelling
 * a genuinely newer run of the same PR. So the run task keeps `retries: 0` and
 * nothing here involves the engine. A deferred run holds its engine slot while
 * it waits (not its box slot, not any memory); a cancel during the wait ends it
 * like any other cancel.
 */

/** Backoff between deferrals: 2^n seconds, capped at 120. */
export const ADMISSION_BACKOFF = { factor: 2, maxSeconds: 120 } as const;

/**
 * The most a run may spend deferred, in seconds, over all its deferrals. The
 * wait counts against the run's 30-minute executionTimeout, so the budget is
 * the time a deferred run gives up: 12 minutes leaves 18 for the agent (a
 * review takes 2–15; a task run that needs more will time out and fail final,
 * with the deferral count in its journal). It also keeps the whole run inside
 * the control plane's 75-minute stalled-thread cutoff
 * (apps/www/src/server-lib/cron.ts STALLED_CUTOFF_SECS):
 *   ≤ 30 m scheduleTimeout + ≤ 30 m execution (wait included) + margin ≤ 75 m.
 */
export const ADMISSION_DEFERRAL_BUDGET_S = 12 * 60;

/** The n-th wait (n ≥ 1): min(factor^n, maxSeconds). */
export function backoffSeconds(n: number): number {
  return Math.min(ADMISSION_BACKOFF.factor ** n, ADMISSION_BACKOFF.maxSeconds);
}

/** Σ backoffSeconds(n) for n in 1..deferrals — the worst-case total wait. */
export function sumBackoffSeconds(deferrals: number): number {
  let total = 0;
  for (let n = 1; n <= deferrals; n++) total += backoffSeconds(n);
  return total;
}
