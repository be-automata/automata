import fs from "node:fs";

import { NonRetryableError } from "@hatchet-dev/typescript-sdk";

import { sumBackoffSeconds } from "./admission-retry";

/**
 * Memory-headroom admission check (#371, epic #193 ticket 3; ADR-007 Decision 5).
 * The backoff constants live in admission-retry.ts.
 *
 * WHY. The per-run ceiling (#204) bounds ONE run and the slot locks (#205) bound
 * HOW MANY run; neither bounds the SUM. N runs each under their `memory.max` can
 * still push `Committed_AS` past `CommitLimit` together with the ~2 GB base, and
 * that is the box-wide fork/posix_spawn ENOMEM that takes worker, engine and
 * Postgres down together — not a tidy per-run OOM. So admission asks the kernel
 * two questions before a run is allowed to spend memory:
 *
 *   1. is `MemAvailable` minus what each live admitted run is still expected
 *      to add (its `runCommit` less the anon + shmem its cgroup is already
 *      charged — `Reservation.observe`) still above a floor; and
 *   2. would `Committed_AS` plus those outstanding reservations plus THIS run's
 *      expected commit stay under a fraction of `CommitLimit`.
 *
 * Either answer "no" DEFERS the run: it gives its box slot back, waits an
 * exponential backoff IN PROCESS (admission-retry.ts; abortable by the engine's
 * cancel) and asks again, up to WORKER_ADMISSION_MAX_DEFERRALS times — the run
 * stays RUNNING on the engine, is never FAILED by the host for a transient
 * shortage and never cancelled by it (Decision 5: the budget may delay or
 * reject admission, terminating a running review stays the engine's act).
 *
 * WHY A RESERVATION. With N slots two admissions can run at once. Both would
 * read the same `/proc/meminfo`, both would see headroom for ONE more run, and
 * both would pass — the exact over-commit the check exists to prevent. The
 * decision itself is one synchronous step (a sync read of /proc/meminfo, parse,
 * evaluate, reserve) on one event loop, so no two decisions can interleave; and
 * an admitted run RESERVES its expected commit for its WHOLE LIFE, minus what the
 * kernel already charges its cgroup (anonymous memory from `memory.stat`, attached once the daemon
 * exists) — the kernel's `Committed_AS` carries only what a run has committed so
 * far, and a run released at its first sign of life would leave its later growth
 * uncounted for the next admission. Keep `decide` synchronous — an `await`
 * inside it would need a mutex.
 *
 * Every function here is pure or injectable; the only I/O is reading
 * `/proc/meminfo`, which does not exist on macOS — there the check is inert by
 * construction (the pilot Mac runs N = 1 and never had this guard).
 */

/** The `/proc/meminfo` fields the check reads, in BYTES — exactly the three the two arms use. */
export interface MeminfoReading {
  memAvailable: number;
  committedAs: number;
  commitLimit: number;
}

/** Field → its line matcher, compiled once (the parse runs on every admission). */
const MEMINFO_FIELDS: ReadonlyArray<[keyof MeminfoReading, string, RegExp]> = (
  [
    ["memAvailable", "MemAvailable"],
    ["committedAs", "Committed_AS"],
    ["commitLimit", "CommitLimit"],
  ] as const
).map(([key, label]) => [
  key,
  label,
  new RegExp(`^${label}:\\s+(\\d+)\\s+kB\\s*$`, "m"),
]);

export const readProcMeminfo = (): string =>
  fs.readFileSync("/proc/meminfo", "utf8");

/**
 * Parse `/proc/meminfo` text. Values are reported in kB; returned in bytes.
 * Throws when a required field is missing or malformed — a check that cannot
 * read the kernel must not silently pass.
 */
export function parseMeminfo(text: string): MeminfoReading {
  const out: Partial<Record<keyof MeminfoReading, number>> = {};
  for (const [key, label, re] of MEMINFO_FIELDS) {
    const m = re.exec(text);
    if (!m?.[1]) {
      throw new Error(`/proc/meminfo: missing or malformed ${label}`);
    }
    out[key] = Number(m[1]) * 1024;
  }
  return out as MeminfoReading;
}

export interface HeadroomPolicy {
  /** `MemAvailable` must stay at or above this after reservations. 0 = arm inert. */
  floorBytes: number;
  /** `Committed_AS` + reservations + this run must stay at or below this fraction of `CommitLimit`. 1 = arm inert. */
  commitFraction: number;
  /** What one run is expected to commit; the admitted run's own ceiling by default. */
  runCommitBytes: number;
}

/** True when neither arm can ever reject — the documented rollback setting. */
export function isInertPolicy(policy: HeadroomPolicy): boolean {
  return policy.floorBytes <= 0 && policy.commitFraction >= 1;
}

export type HeadroomReason =
  | "mem-available-below-floor"
  | "commit-over-fraction";

export interface HeadroomObserved {
  memAvailable: number;
  committedAs: number;
  commitLimit: number;
  floor: number;
  fraction: number;
  runCommit: number;
  reserved: number;
}

export type HeadroomVerdict =
  | { ok: true; observed: HeadroomObserved }
  | { ok: false; reason: HeadroomReason; observed: HeadroomObserved };

/** Pure: both arms, boundary-inclusive (exactly at the floor / fraction admits). */
export function evaluateHeadroom(
  reading: MeminfoReading,
  policy: HeadroomPolicy,
  reservedBytes = 0,
): HeadroomVerdict {
  const observed: HeadroomObserved = {
    memAvailable: reading.memAvailable,
    committedAs: reading.committedAs,
    commitLimit: reading.commitLimit,
    floor: policy.floorBytes,
    fraction: policy.commitFraction,
    runCommit: policy.runCommitBytes,
    reserved: reservedBytes,
  };
  if (
    policy.floorBytes > 0 &&
    reading.memAvailable - reservedBytes < policy.floorBytes
  ) {
    return { ok: false, reason: "mem-available-below-floor", observed };
  }
  if (
    policy.commitFraction < 1 &&
    reading.committedAs + reservedBytes + policy.runCommitBytes >
      policy.commitFraction * reading.commitLimit
  ) {
    return { ok: false, reason: "commit-over-fraction", observed };
  }
  return { ok: true, observed };
}

/**
 * One refused admission (ADR-007 Decision 5). INTERNAL to the worker: the run
 * catches it, gives its box slot back, waits the backoff and tries again
 * (workflow.ts) — it never reaches the engine. After the last allowed
 * deferral the run ends with `AdmissionBudgetExhaustedError` instead.
 */
export class AdmissionDeferredError extends Error {
  override readonly name = "AdmissionDeferredError";
  constructor(
    readonly reason: HeadroomReason,
    readonly observed: HeadroomObserved,
    attempt: number,
  ) {
    // Operator-facing: when the deferrals run out this becomes the thread's
    // error banner (onFailure), so it must read as a cause, not a dump.
    super(
      `The box had no memory headroom for this run (attempt ${attempt + 1}, ${reason}): ` +
        `MemAvailable=${mib(observed.memAvailable)} Committed_AS=${mib(observed.committedAs)}/` +
        `CommitLimit=${mib(observed.commitLimit)} floor=${mib(observed.floor)} ` +
        `fraction=${observed.fraction} runCommit=${mib(observed.runCommit)} reserved=${mib(observed.reserved)}`,
    );
  }
}

/**
 * The run's final word when every allowed deferral was refused: non-retryable
 * (the task registers no retries anyway), operator-facing (it becomes the
 * thread's failure banner via onFailure), carrying the last refusal.
 */
export class AdmissionBudgetExhaustedError extends NonRetryableError {
  constructor(
    readonly deferrals: number,
    readonly last: AdmissionDeferredError,
    /** Wall clock deferred (backoff + slot re-acquire waits); defaults to Σbackoff. */
    readonly elapsedS: number = sumBackoffSeconds(deferrals),
  ) {
    super(
      `The box had no memory headroom for this run after ${deferrals} deferral(s) ` +
        `(${elapsedS}s deferred); last check: ${last.message}`,
    );
    this.name = "AdmissionBudgetExhaustedError";
  }
}

/** `1234M` for log lines and the error banner. */
function mib(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 2)}M`;
}

export interface Reservation {
  /**
   * Drop the reservation: idempotent. Called when the RUN ends (its finally or
   * its pre-daemon unwind) — never earlier: a reservation released at the
   * agent's first sign of life would leave the run's later growth uncounted,
   * and a second admission would see an idle Committed_AS.
   */
  release(): void;
  /**
   * Attach the run's own memory reading (its cgroup's anonymous memory,
   * `memory.stat` anon + shmem — what Committed_AS actually counts; never
   * `memory.current`, which includes page cache) once it exists. From then on
   * the reservation counts only `runCommit − anon` (floored at 0); without a
   * probe, or when it reads nothing, the whole runCommit stays reserved.
   */
  observe(current: () => number | null): void;
}

/**
 * The per-worker admission gate: one reservation table, one reader. Built only
 * where the check can run (assessHeadroomSupport); where it cannot — no
 * `/proc/meminfo` (macOS), an inert policy — there is no controller at all and
 * admission is byte-for-byte today's.
 */
export class AdmissionController {
  /** run id (the workflow run; a thread's supersede siblings are distinct runs) → the live reservation: expected commit, its identity (a stale generation's release cannot drop a newer one), and the run's own anonymous-memory probe once it has one. */
  private reserved = new Map<
    string,
    { bytes: number; token: symbol; current?: () => number | null }
  >();

  constructor(
    readonly policy: HeadroomPolicy,
    private readonly readMeminfo: () => string = readProcMeminfo,
  ) {}

  /** Sum over live runs of what each still owes: `runCommit − anon` (0 when fully charged), the whole runCommit before its probe exists or when it reads nothing. */
  reservedBytes(): number {
    return this.reservedBytesExcept(null);
  }

  private reservedBytesExcept(runId: string | null): number {
    let sum = 0;
    for (const [id, v] of this.reserved) {
      if (id === runId) continue;
      sum += Math.max(0, v.bytes - (v.current?.() ?? 0));
    }
    return sum;
  }

  /**
   * Admit one run or throw `AdmissionDeferredError`. One synchronous decision
   * (see the module comment: no await, so no interleaving); a successful
   * admission reserves `policy.runCommitBytes` under the run's id (the workflow run, never the thread) until the
   * returned reservation is released.
   */
  admit(opts: {
    /**
     * The reservation key: the WORKFLOW RUN — distinct per run of a thread (a
     * supersede sibling is another run). REQUIRED: a thread-keyed reservation
     * would let two runs of one thread overwrite each other's entry and skip a
     * live sibling in `reservedBytesExcept`.
     */
    runId: string;
    threadId: string;
    attempt: number;
    log?: (line: string) => void;
  }): Reservation {
    const runId = opts.runId;
    // FAIL-OPEN on an unreadable kernel: a check that cannot read
    // /proc/meminfo at this instant admits with one loud line rather than
    // failing the run (the task registers retries: 0, so a throw here would end
    // the run final). Boot already proved the file readable; this covers a
    // transient error only.
    let reading: MeminfoReading;
    try {
      reading = parseMeminfo(this.readMeminfo());
    } catch (e) {
      opts.log?.(
        `box.headroom_unreadable ${JSON.stringify({
          runId,
          threadId: opts.threadId,
          attempt: opts.attempt,
          error: e instanceof Error ? e.message : String(e),
        })}`,
      );
      // Fail-open on the DECISION only: the admitted run still reserves its
      // expected commit, or the next admission would see it as free headroom.
      return this.reserve(runId);
    }
    // A retried attempt of the same RUN must not count its own earlier
    // reservation; a sibling run of the same thread (a supersede whose old
    // attempt is still tearing down on another slot) keeps counting. The table
    // is left untouched until the decision: a refusal drops nothing.
    const verdict = evaluateHeadroom(
      reading,
      this.policy,
      this.reservedBytesExcept(runId),
    );
    // runId is the reservation key: two runs of one thread (a supersede
    // sibling) are told apart in the journal by it, never by threadId.
    const fields = JSON.stringify({
      runId,
      threadId: opts.threadId,
      attempt: opts.attempt,
      ...verdict.observed,
      reason: verdict.ok ? undefined : verdict.reason,
    });
    if (!verdict.ok) {
      opts.log?.(`box.headroom_rejected ${fields}`);
      throw new AdmissionDeferredError(
        verdict.reason,
        verdict.observed,
        opts.attempt,
      );
    }
    opts.log?.(`box.headroom_ok ${fields}`);
    return this.reserve(runId);
  }

  /** Reserve `runCommitBytes` under `runId` and hand back its handle (token-scoped release/observe). */
  private reserve(runId: string): Reservation {
    const token = Symbol(runId);
    const entry = { bytes: this.policy.runCommitBytes, token };
    this.reserved.set(runId, entry);
    const mine = () => this.reserved.get(runId)?.token === token;
    return {
      release: () => {
        // Only this generation's entry: an older attempt's late release must
        // not drop a re-admitted attempt's reservation.
        if (mine()) this.reserved.delete(runId);
      },
      observe: (current) => {
        if (mine()) this.reserved.set(runId, { ...entry, current });
      },
    };
  }
}

/**
 * Decide at boot whether the check can run here: Linux with a readable
 * `/proc/meminfo` and a non-inert policy. Returns the reason when it cannot,
 * so the boot log says WHY the guard is off instead of nothing.
 */
export function assessHeadroomSupport(opts: {
  policy: HeadroomPolicy;
  platform?: NodeJS.Platform;
  readMeminfo?: () => string;
}): { enabled: true } | { enabled: false; reason: string } {
  if (isInertPolicy(opts.policy)) {
    return { enabled: false, reason: "policy is inert (floor 0, fraction 1)" };
  }
  if ((opts.platform ?? process.platform) !== "linux") {
    return {
      enabled: false,
      reason: `platform ${opts.platform ?? process.platform} has no /proc/meminfo`,
    };
  }
  // Linux with a live policy: the file MUST be readable, or the boot is refused
  // (worker.ts). Returning "off" here would silently disable a configured
  // check for the life of the process on one transient read; the documented way
  // to run without it is the inert rollback (floor 0, fraction 1.0). The
  // per-admission fail-open in `admit` covers only a transient read AFTER boot
  // proved the file readable.
  let reading: MeminfoReading;
  let memTotal: number | null = null;
  try {
    const text = (opts.readMeminfo ?? readProcMeminfo)();
    reading = parseMeminfo(text);
    // MemTotal is only needed here (the floor's box check), never per admission.
    const m = /^MemTotal:\s+(\d+)\s+kB/m.exec(text);
    memTotal = m?.[1] ? Number(m[1]) * 1024 : null;
  } catch (e) {
    throw new Error(
      `the memory headroom check is configured but /proc/meminfo cannot be read or parsed: ${
        e instanceof Error ? e.message : String(e)
      } — set WORKER_HEADROOM_FLOOR=0 and WORKER_HEADROOM_COMMIT_FRACTION=1.0 to run without it`,
    );
  }
  // The knobs against the BOX: a run commit above fraction × CommitLimit can
  // never pass the commit arm (Committed_AS ≥ 0), so every dispatched run would
  // hold its engine slot for the whole deferral budget and fail final — the
  // silent "every run fails" a boot check exists to refuse up front (an
  // oversized WORKER_RUN_MEMORY_MAX on a small box, or a typo such as 50G).
  const commitCeiling = opts.policy.commitFraction * reading.commitLimit;
  if (
    opts.policy.commitFraction < 1 &&
    opts.policy.runCommitBytes > commitCeiling
  ) {
    throw new Error(
      `the memory headroom check can never admit a run on this box: run commit ${mib(opts.policy.runCommitBytes)} (WORKER_HEADROOM_RUN_COMMIT, default WORKER_RUN_MEMORY_MAX) exceeds ${opts.policy.commitFraction} × CommitLimit ${mib(reading.commitLimit)} = ${mib(commitCeiling)} — lower the run commit or the ceiling, raise WORKER_HEADROOM_COMMIT_FRACTION, or set floor 0 and fraction 1.0 to run without the check`,
    );
  }
  // Same for the floor arm: a floor at or above the box's memory means
  // `MemAvailable − reserved ≥ floor` can never hold (a typo such as 10G on a
  // 7.6 GB box) — refuse at boot rather than fail every run after its budget.
  if (
    opts.policy.floorBytes > 0 &&
    memTotal !== null &&
    opts.policy.floorBytes >= memTotal
  ) {
    throw new Error(
      `the memory headroom check can never admit a run on this box: floor ${mib(opts.policy.floorBytes)} (WORKER_HEADROOM_FLOOR) is at or above MemTotal ${mib(memTotal)} — lower the floor, or set floor 0 and fraction 1.0 to run without the check`,
    );
  }
  return { enabled: true };
}
