import fs from "node:fs";

/**
 * Memory-headroom admission check (#371, epic #193 ticket 3; ADR-007 Decision 5).
 * The engine-retry constants live in admission-retry.ts (import-free).
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

const NO_RESERVATION: Reservation = { release: () => {}, observe: () => {} };

/**
 * The per-worker admission gate: one reservation table, one reader. Built only
 * where the check can run (assessHeadroomSupport); where it cannot — no
 * `/proc/meminfo` (macOS), an inert policy — there is no controller at all and
 * admission is byte-for-byte today's.
 */
export class AdmissionController {
  /** threadId → the live reservation: expected commit, its identity (a stale generation's release cannot drop a newer one), and the run's own anonymous-memory probe once it has one. */
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
    let sum = 0;
    for (const v of this.reserved.values()) {
      sum += Math.max(0, v.bytes - (v.current?.() ?? 0));
    }
    return sum;
  }

  /**
   * Admit one run or throw `AdmissionDeferredError`. One synchronous decision
   * (see the module comment: no await, so no interleaving); a successful
   * admission reserves `policy.runCommitBytes` under `threadId` until the
   * returned reservation is released.
   */
  admit(opts: {
    threadId: string;
    attempt: number;
    log?: (line: string) => void;
  }): Reservation {
    // FAIL-OPEN on an unreadable kernel: a check that cannot read
    // /proc/meminfo at this instant admits with one loud line rather than
    // failing the run (the fence would make that failure final). Boot already
    // proved the file readable; this covers a transient error only.
    let reading: MeminfoReading;
    try {
      reading = parseMeminfo(this.readMeminfo());
    } catch (e) {
      opts.log?.(
        `box.headroom_unreadable ${JSON.stringify({
          threadId: opts.threadId,
          attempt: opts.attempt,
          error: e instanceof Error ? e.message : String(e),
        })}`,
      );
      return NO_RESERVATION;
    }
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
    const token = Symbol(opts.threadId);
    const entry = { bytes: this.policy.runCommitBytes, token };
    this.reserved.set(opts.threadId, entry);
    const mine = () => this.reserved.get(opts.threadId)?.token === token;
    return {
      release: () => {
        // Only this generation's entry: an older attempt's late release must
        // not drop a re-admitted attempt's reservation.
        if (mine()) this.reserved.delete(opts.threadId);
      },
      observe: (current) => {
        if (mine()) this.reserved.set(opts.threadId, { ...entry, current });
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
  try {
    parseMeminfo((opts.readMeminfo ?? readProcMeminfo)());
  } catch (e) {
    return {
      enabled: false,
      reason: `cannot read /proc/meminfo: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return { enabled: true };
}
