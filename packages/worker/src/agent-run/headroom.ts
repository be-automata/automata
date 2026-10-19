import fs from "node:fs";

/**
 * Memory-headroom admission check (#371, epic #193 ticket 3; ADR-007 Decision 5).
 *
 * WHY. The per-run ceiling (#204) bounds ONE run and the slot locks (#205) bound
 * HOW MANY run; neither bounds the SUM. N runs each under their `memory.max` can
 * still push `Committed_AS` past `CommitLimit` together with the ~2 GB base, and
 * that is the box-wide fork/posix_spawn ENOMEM that takes worker, engine and
 * Postgres down together — not a tidy per-run OOM. So admission asks the kernel
 * two questions before a run is allowed to spend memory:
 *
 *   1. is `MemAvailable` (minus what admitted-but-not-yet-spawned runs will take)
 *      still above a floor; and
 *   2. would `Committed_AS` plus those reservations plus THIS run's expected
 *      commit stay under a fraction of `CommitLimit`.
 *
 * Either answer "no" DEFERS the run: `AdmissionDeferredError` is a plain Error,
 * so the engine (task `retries` + exponential `backoff`, definition.ts) frees the
 * worker slot and re-queues the attempt — the run shows QUEUED, never FAILED, and
 * is never cancelled by the host (Decision 5: the budget may delay or reject
 * admission, terminating a running review stays the engine's act).
 *
 * WHY A RESERVATION AND A MUTEX. With N slots two admissions can run at once. Both
 * would read the same `/proc/meminfo`, both would see headroom for ONE more run,
 * and both would pass — the exact over-commit the check exists to prevent. The
 * worker is one process, so an in-process mutex serialises the decision, and an
 * admitted run RESERVES its expected commit until its daemon has started (by then
 * the kernel's own `Committed_AS` carries it).
 *
 * Every function here is pure or injectable; the only I/O is reading
 * `/proc/meminfo`, which does not exist on macOS — there the check is inert by
 * construction (the pilot Mac runs N = 1 and never had this guard).
 */

/** The `/proc/meminfo` fields the check reads, in BYTES. */
export interface MeminfoReading {
  memTotal: number;
  memAvailable: number;
  committedAs: number;
  commitLimit: number;
  swapTotal: number;
  swapFree: number;
}

const REQUIRED_FIELDS: ReadonlyArray<[keyof MeminfoReading, string]> = [
  ["memTotal", "MemTotal"],
  ["memAvailable", "MemAvailable"],
  ["committedAs", "Committed_AS"],
  ["commitLimit", "CommitLimit"],
  ["swapTotal", "SwapTotal"],
  ["swapFree", "SwapFree"],
];

/**
 * Parse `/proc/meminfo` text. Values are reported in kB; returned in bytes.
 * Throws when a required field is missing or malformed — a check that cannot
 * read the kernel must not silently pass.
 */
export function parseMeminfo(text: string): MeminfoReading {
  const out: Partial<Record<keyof MeminfoReading, number>> = {};
  for (const [key, label] of REQUIRED_FIELDS) {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\s+kB\\s*$`, "m").exec(text);
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
 * The retryable admission error (ADR-007 Decision 5). A PLAIN Error subclass
 * on purpose: the engine retries plain errors (task `retries` + `backoff`) and
 * refuses to retry `NonRetryableError`, so this is the one error the run task
 * may let escape retryable — everything thrown AFTER admission is wrapped
 * non-retryable by `runAgent` (workflow.ts), because an agent run must never
 * re-execute.
 */
export class AdmissionDeferredError extends Error {
  override readonly name = "AdmissionDeferredError";
  constructor(
    readonly reason: HeadroomReason,
    readonly observed: HeadroomObserved,
    readonly attempt: number,
  ) {
    super(
      `admission deferred (${reason}): MemAvailable=${observed.memAvailable} Committed_AS=${observed.committedAs} ` +
        `CommitLimit=${observed.commitLimit} floor=${observed.floor} fraction=${observed.fraction} ` +
        `runCommit=${observed.runCommit} reserved=${observed.reserved} attempt=${attempt}`,
    );
  }
}

export interface Reservation {
  /** Drop the reservation: idempotent. Called once the daemon has started. */
  release(): void;
}

const NO_RESERVATION: Reservation = { release: () => {} };

/**
 * The per-worker admission gate: one mutex, one reservation table, one reader.
 *
 * `enabled` is decided ONCE at boot: false on a platform with no `/proc/meminfo`
 * (macOS) or with an inert policy. Disabled, `admit()` never reads anything and
 * never throws — the default-off path is byte-for-byte today's admission.
 */
export class AdmissionController {
  private reserved = new Map<string, number>();
  /** The mutex: each admission awaits the previous decision, success or throw. */
  private lock: Promise<void> = Promise.resolve();

  constructor(
    readonly policy: HeadroomPolicy,
    readonly enabled: boolean,
    private readonly readMeminfo: () => string = () =>
      fs.readFileSync("/proc/meminfo", "utf8"),
  ) {}

  /** Sum of every live reservation, in bytes. */
  reservedBytes(): number {
    let sum = 0;
    for (const v of this.reserved.values()) sum += v;
    return sum;
  }

  /**
   * Admit one run or throw `AdmissionDeferredError`. Decisions are serialised,
   * and a successful admission reserves `policy.runCommitBytes` under
   * `threadId` until the returned reservation is released.
   */
  async admit(opts: {
    threadId: string;
    attempt: number;
    log?: (line: string) => void;
  }): Promise<Reservation> {
    if (!this.enabled) {
      return NO_RESERVATION;
    }
    // Serialise: the next admission waits for this decision (success OR
    // throw) so it reads a `reserved` sum that already includes ours.
    const previous = this.lock;
    let unlock: () => void = () => {};
    this.lock = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    try {
      await previous;
      return this.decide(opts);
    } finally {
      unlock();
    }
  }

  private decide(opts: {
    threadId: string;
    attempt: number;
    log?: (line: string) => void;
  }): Reservation {
    {
      const reading = parseMeminfo(this.readMeminfo());
      // A redelivered attempt of the same thread must not count its own stale
      // reservation (a crashed worker never releases; the map dies with it, but
      // an in-process retry of the same threadId could).
      this.reserved.delete(opts.threadId);
      const verdict = evaluateHeadroom(
        reading,
        this.policy,
        this.reservedBytes(),
      );
      const fields = JSON.stringify({
        threadId: opts.threadId,
        attempt: opts.attempt,
        ...verdict.observed,
        ...(verdict.ok ? {} : { reason: verdict.reason }),
      });
      if (!verdict.ok) {
        opts.log?.(`admission.headroom_rejected ${fields}`);
        throw new AdmissionDeferredError(
          verdict.reason,
          verdict.observed,
          opts.attempt,
        );
      }
      opts.log?.(`admission.headroom_ok ${fields}`);
      this.reserved.set(opts.threadId, this.policy.runCommitBytes);
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          this.reserved.delete(opts.threadId);
        },
      };
    }
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
  try {
    parseMeminfo(
      (opts.readMeminfo ?? (() => fs.readFileSync("/proc/meminfo", "utf8")))(),
    );
  } catch (e) {
    return {
      enabled: false,
      reason: `cannot read /proc/meminfo: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return { enabled: true };
}
