/**
 * The engine-retry constants of the admission deferral (#371, ADR-007 Decision
 * 5). A separate, import-free module: definition.ts (the PURE registration
 * shape) and config.ts (the boot budget check) both need them, and neither
 * should drag the /proc/meminfo reader (headroom.ts) in. One source, so the
 * registration and the budget check can never disagree.
 */

/**
 * Backoff between deferred admissions: 2^n seconds capped at 120 (the engine's
 * `backoff.factor` / `backoff.maxSeconds`).
 */
export const ADMISSION_BACKOFF = { factor: 2, maxSeconds: 120 } as const;

/**
 * The most a run may spend deferred, in seconds, over all its retries. The
 * control plane reaps a thread still `booting` after 75 minutes
 * (apps/www/src/server-lib/cron.ts STALLED_CUTOFF_SECS) and nothing in a
 * deferral touches the thread, so the budget must satisfy
 *   initial queue wait (≤ 30 m scheduleTimeout) + Σbackoff + 30 m execution + margin ≤ 75 m
 * — 12 minutes is the Σbackoff that leaves that inequality true with a 3-minute margin.
 *
 * ASSUMPTION, stated: `scheduleTimeout` is re-applied PER ATTEMPT by the engine,
 * so the strict worst case is (retries + 1) × 30 m of queueing. The inequality
 * models ONE scheduling wait because a retried attempt is re-queued at priority 4
 * (it jumps the queue) and the slot it needs is the one its own deferral just
 * freed; a box so loaded that a priority-4 retry waits a full scheduleTimeout
 * would be reaped by www as stalled while the engine still has it QUEUED. The
 * remedy for that case (a `booting` heartbeat from the deferral) is outside
 * #371; the risk is recorded in ADR-007.
 */
export const ADMISSION_DEFERRAL_BUDGET_S = 12 * 60;

/** Σ min(factor^n, maxSeconds) for n in 1..retries — the worst-case total wait. */
export function sumBackoffSeconds(retries: number): number {
  let total = 0;
  for (let n = 1; n <= retries; n++) {
    total += Math.min(
      ADMISSION_BACKOFF.factor ** n,
      ADMISSION_BACKOFF.maxSeconds,
    );
  }
  return total;
}
