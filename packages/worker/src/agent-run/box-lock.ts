import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * The box's ONE agent-run lock, enforced on the worker plane (#152 Stage B1,
 * #183). Replaces the #125 C4 owner-file slot scheme.
 *
 * WHY: the engine-side "global" concurrency key
 * (`'agent-run-global-memory-budget'`, definition.ts) is scoped PER WORKFLOW in
 * Hatchet v1 — proven by #128's E2E against hatchet-lite v0.94.10: a run on
 * `agent-run-strict` started 193ms into a live `agent-run-newest` run. With the
 * four variants registered, the engine alone would let up to four agent-runs
 * execute at once on a box budgeted for one (the ENOMEM wall the cap exists
 * for). This lock is the box-level belt to the engine's per-workflow
 * suspenders: every run acquires it before its credentials touch disk and
 * releases it last in its finally. The worker's engine `slots` (= WORKER_BOX_SLOTS,
 * #205) bounds how many runs can wait here.
 *
 * Mechanism: a kernel flock(2), held by a tiny helper child. The worker spawns
 * `lockf(1)` (darwin) or util-linux `flock(1)` (linux) on `<root>/box.lock`
 * with the command `sh -c 'printf ok; read _'`. The helper runs the command
 * ONLY once the kernel has granted it the exclusive lock, so the `ok` on its
 * stdout is the acquisition ack; `read _` then parks the command on the
 * helper's stdin pipe, whose only write end is this process. The lock is
 * released when the helper's command exits (ADR-007 amendment §1): normally
 * because `release()` closed stdin (EOF ends `read`), or because the kernel
 * dropped it when the holding process died — a SIGKILLed worker, a crashed
 * relaunch, a helper killed by hand. There is therefore NO staleness
 * threshold, NO liveness beat, NO mtime read, NO reclaim and NO polling loop:
 * liveness is the kernel's, not ours, and a waiter can never mistake a fresh
 * holder for a stale one because there is no owner file to misread.
 *
 * Waiting honours the run's AbortSignal in two branches. BEFORE the ack the
 * helper is blocked inside flock(2) and never reads stdin, so an EOF would go
 * unnoticed until the lock arrived; the waiter is SIGKILLed instead (safe: on
 * darwin only the `lockf` pid holds the fd — `lsof` shows one `lockf … 4r`
 * line — so a killed waiter that had just won drops the lock and its orphaned
 * `sh` exits on pipe EOF; on linux `-o` keeps the fd out of `sh` for the same
 * reason). AFTER the ack the abort is an ordinary `release()`. An abort landing
 * in the instant after a successful claim is honoured too, so an engine cancel
 * while queued here never runs a body. `release()` is idempotent (memoised) and
 * each acquire owns its own helper child, so a late second `release()` can
 * never free a successor's hold.
 *
 * #184 added the try-lock variant (`tryAcquireBoxLock`): the same helper and
 * ack, but the helper is told never to wait (lockf `-t 0`, util-linux flock
 * `-n`), so a held lock surfaces as a pre-ack exit rather than a park. The
 * conflict exit code is normalised to 75 on both platforms (lockf's
 * EX_TEMPFAIL; flock's default is 1 unless `-E 75`). Both entry points share
 * `spawnHelperAndAwaitAck`, so the spawn shape and the ack race never drift.
 *
 * #205 generalised the exclusive lock into a COUNTING budget of N slots without
 * changing the primitive: slot i is an exclusive flock(2) on `<root>/box.lock.<i>`
 * (slot 0 keeps `box.lock`, so N = 1 is byte-identical to the above), and a run
 * holds exactly one slot. `acquireBoxSlot` tries every slot non-blocking from a
 * holder-rotated start — so a burst does not stampede slot 0 — and only then
 * parks on a waiting acquire. Liveness is still the kernel's: no staleness
 * threshold, no liveness beat, no mtime read, no reclaim, no polling loop
 * (ADR-007 I1).
 * The slot index is what names the run's agent account (`agentUserForSlot`),
 * which is the fence between concurrent runs.
 */

export class BoxLockUnavailableError extends Error {
  override readonly name = "BoxLockUnavailableError";
  constructor(
    readonly helper: string,
    readonly detail: string,
  ) {
    super(`box lock helper unavailable (${helper}): ${detail}`);
  }
}

export interface BoxLock {
  release(): Promise<void>;
  /**
   * True once the helper exited BEFORE `release()`: the kernel has already
   * dropped the lock and another run may own the box. A teardown must not
   * issue the uid-wide kill in that state (#184).
   */
  readonly lost: boolean;
  /** Which slot file this lock holds (#205). Always 0 for the exclusive lock. */
  readonly slot: number;
}

export interface AcquireBoxLockOptions {
  /** The run-namespace root; the lock file is `<root>/box.lock` (slot 0) or `<root>/box.lock.<slot>`. */
  root: string;
  /** Who is taking the lock — appears in the log line only. */
  holder: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** #205: the slot file to lock. Default 0 = `box.lock`, exactly as before. */
  slot?: number;
  /** #205: how many slots the box has; > 1 tags the log lines with `slot i/N`. Default 1. */
  slots?: number;
}

export interface AcquireBoxSlotOptions {
  root: string;
  /** How many slot files exist: `WORKER_BOX_SLOTS`. */
  slots: number;
  holder: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface BoxLockHelper {
  file: string;
  args: string[];
}

export interface TryAcquireBoxLockOptions {
  /** The run-namespace root; the lock file is `<root>/box.lock` (slot 0) or `<root>/box.lock.<slot>`. */
  root: string;
  /** Who is trying — appears in the log lines only. */
  holder: string;
  log?: (line: string) => void;
  /**
   * Test seam: the helper to spawn instead of `boxLockTryHelper()`. Lets a
   * test drive the spawn-failure branch with a bogus binary path.
   */
  helper?: BoxLockHelper;
  /** #205: the slot file to try. Default 0 = `box.lock`. */
  slot?: number;
  /** #205: how many slots the box has; > 1 tags the log lines. Default 1. */
  slots?: number;
}

interface HelperExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
}

type AcquireOutcome =
  | { kind: "acquired" }
  | { kind: "aborted" }
  | { kind: "helper-gone"; exit: HelperExit };

const SH_BIN = "/bin/sh";
/** Ack once the lock is held, then park on stdin until EOF. */
const HELPER_COMMAND = "printf ok; read _";
/** How long a released helper gets to exit on EOF before it is SIGKILLed. */
const RELEASE_EXIT_BOUND_MS = 2000;
/**
 * The helper's exit code when a try-lock finds the lock held. lockf(1) exits
 * EX_TEMPFAIL (75) on `-t 0`; util-linux flock(1) is told the same code via
 * `-E 75` so the caller has ONE busy signal on both platforms.
 */
const TRY_LOCK_BUSY_EXIT = 75;

/**
 * The single builder of the lock-file path. Slot 0 is `box.lock` — the name the
 * exclusive lock has always had, so an N = 1 box is byte-identical — and slot
 * i > 0 is `box.lock.<i>` (#205).
 */
export function boxLockPath(root: string, slot = 0): string {
  assertSlotIndex(slot, "boxLockPath");
  return path.join(root, slot === 0 ? "box.lock" : `box.lock.${slot}`);
}

/** A slot index is a non-negative integer; shared by every slot-addressed builder. */
export function assertSlotIndex(slot: number, where: string): void {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new Error(
      `${where}: slot must be a non-negative integer, got ${slot}`,
    );
  }
}

/** A slot count is a positive integer. */
export function assertSlotCount(slots: number, where: string): void {
  if (!Number.isInteger(slots) || slots < 1) {
    throw new Error(`${where}: slots must be a positive integer, got ${slots}`);
  }
}

/**
 * Log-line suffix for a slot: empty at N = 1 (those lines stay byte-identical),
 * `, slot i/N` above.
 */
export function slotTag(slot: number, slots: number): string {
  return slots > 1 ? `, slot ${slot}/${slots}` : "";
}

/**
 * Where a holder starts trying slots (#205): a stable hash of the holder id
 * modulo N, so concurrent admissions spread over the slot files instead of all
 * colliding on slot 0 and serialising through the waiting acquire. Pure.
 */
export function rotationStart(holder: string, slots: number): number {
  assertSlotCount(slots, "rotationStart");
  let h = 0;
  for (let i = 0; i < holder.length; i++) {
    h = (h * 31 + holder.charCodeAt(i)) >>> 0;
  }
  return h % slots;
}

/**
 * darwin: `lockf -k -s -w` — keep the file (`-k`), no chatter on the wait
 * (`-s`), open for writing (`-w`; harmless on APFS, required for an exclusive
 * lock on NFSv4-class filesystems). linux: util-linux `flock -x -o` — exclusive
 * (`-x`) and close the lock fd before exec'ing the command (`-o`) so `sh` never
 * holds it. Both create a missing file and take a positional command, so the
 * spawn shape is one code path.
 */
export function boxLockHelper(
  platform: NodeJS.Platform = process.platform,
): BoxLockHelper {
  switch (platform) {
    case "darwin":
      return { file: "/usr/bin/lockf", args: ["-k", "-s", "-w"] };
    case "linux":
      return { file: "/usr/bin/flock", args: ["-x", "-o"] };
    default:
      throw new BoxLockUnavailableError(platform, "unsupported platform");
  }
}

/**
 * The non-waiting variant of `boxLockHelper` (#184): darwin `lockf -t 0`
 * ("fail unless it can acquire the lock immediately"), linux `flock -n -E 75`
 * (`-n` fails instead of waiting; `-E` sets that failure's exit code, whose
 * default is 1). Same binary, same lock file, same ack command.
 */
export function boxLockTryHelper(
  platform: NodeJS.Platform = process.platform,
): BoxLockHelper {
  const base = boxLockHelper(platform);
  switch (platform) {
    case "darwin":
      return { file: base.file, args: [...base.args, "-t", "0"] };
    case "linux":
      return {
        file: base.file,
        args: [...base.args, "-n", "-E", String(TRY_LOCK_BUSY_EXIT)],
      };
    default:
      throw new BoxLockUnavailableError(platform, "unsupported platform");
  }
}

/** Boot-time assert: the helper binary exists and is executable. */
export async function assertBoxLockHelperAvailable(opts?: {
  platform?: NodeJS.Platform;
  access?: (p: string) => Promise<void>;
}): Promise<{ file: string }> {
  const { file } = boxLockHelper(opts?.platform);
  const probe = opts?.access ?? ((p: string) => access(p, fsConstants.X_OK));
  try {
    await probe(file);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new BoxLockUnavailableError(file, detail);
  }
  return { file };
}

function abortError(): Error {
  const err = new Error("box lock wait aborted");
  err.name = "AbortError";
  return err;
}

function describeExit(exit: HelperExit, stderr: string): string {
  if (exit.spawnError) return `spawn failed: ${exit.spawnError.message}`;
  const tail = stderr.trim();
  return `exit ${exit.code ?? "null"}/${exit.signal ?? "null"}${tail ? `: ${tail}` : ""}`;
}

/** Resolves true when `p` settles within `ms`, false on timeout. */
export async function settlesWithin(
  p: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = new Promise<true>((resolve) => {
    void (async () => {
      await p;
      resolve(true);
    })();
  });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** `spawn()` with three pipes: keeps stdin/stdout/stderr typed non-null. */
type PipedChild = ReturnType<typeof spawnPiped>;
function spawnPiped(file: string, args: string[]) {
  return spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
}

interface HelperSession {
  child: PipedChild;
  exited: Promise<HelperExit>;
  outcome: AcquireOutcome;
  /** Stderr accumulated so far; keeps filling until the helper exits. */
  stderr: () => string;
  file: string;
}

/**
 * The one spawn-and-ack path behind both `acquireBoxLock` and
 * `tryAcquireBoxLock`. Spawns `helper` on `<root>/box.lock`, wires the stdin
 * error sink and the output accumulators BEFORE any await, then races the
 * `ok` ack against the helper's exit and (optionally) the caller's abort.
 * Decides nothing: each caller maps the outcome to its own contract.
 */
async function spawnHelperAndAwaitAck(
  root: string,
  helper: BoxLockHelper,
  signal?: AbortSignal,
  slot = 0,
): Promise<HelperSession> {
  await mkdir(root, { recursive: true });
  if (signal?.aborted) throw abortError();
  const { file, args } = helper;
  const lockFile = boxLockPath(root, slot);
  const child = spawnPiped(file, [
    ...args,
    lockFile,
    SH_BIN,
    "-c",
    HELPER_COMMAND,
  ]);
  // A helper that died before we wrote to it makes stdin EPIPE on end(); an
  // unhandled 'error' there would take the worker down. Register before any
  // await, together with the output accumulators.
  child.stdin.on("error", () => {});
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<HelperExit>((resolve) => {
    child.on("error", (spawnError) =>
      resolve({ code: null, signal: null, spawnError }),
    );
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  let onAbort: (() => void) | undefined;
  const outcome = await new Promise<AcquireOutcome>((resolve) => {
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.startsWith("ok")) resolve({ kind: "acquired" });
    });
    void (async () => resolve({ kind: "helper-gone", exit: await exited }))();
    onAbort = () => resolve({ kind: "aborted" });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  if (onAbort) signal?.removeEventListener("abort", onAbort);

  return { child, exited, outcome, stderr: () => stderr, file };
}

/**
 * Turn an acked helper into the caller's `BoxLock`: the LOST observer (a
 * helper that dies after the ack drops the lock while the run still believes
 * it holds it — nothing can recover that mid-run; make it loud instead of
 * silent) and the memoised release closure (EOF on stdin ends `read`, with a
 * SIGKILL fallback after RELEASE_EXIT_BOUND_MS).
 */
function heldLock(
  session: HelperSession,
  holder: string,
  log?: (line: string) => void,
  slot = 0,
  slots = 1,
): BoxLock {
  const { child, exited, stderr } = session;
  const tag = slotTag(slot, slots);
  let released = false;
  let lost = false;
  void (async () => {
    const exit = await exited;
    if (!released) {
      lost = true;
      log?.(
        `box lock LOST by ${holder}: helper ${describeExit(exit, stderr())} — the box budget is unguarded until this run ends${tag}`,
      );
    }
  })();

  let releasing: Promise<void> | undefined;
  const doRelease = async (): Promise<void> => {
    released = true;
    child.stdin.end();
    const exitedInTime = await settlesWithin(exited, RELEASE_EXIT_BOUND_MS);
    if (!exitedInTime) {
      child.kill("SIGKILL");
      await exited;
    }
    log?.(
      `box lock released by ${holder} (helper pid ${child.pid}${
        exitedInTime ? "" : `, SIGKILLed after ${RELEASE_EXIT_BOUND_MS}ms`
      }${tag})`,
    );
  };
  const release = (): Promise<void> => {
    releasing ??= doRelease();
    return releasing;
  };
  return {
    release,
    get lost() {
      return lost;
    },
    slot,
  };
}

export async function acquireBoxLock({
  root,
  holder,
  signal,
  log,
  slot = 0,
  slots = 1,
}: AcquireBoxLockOptions): Promise<BoxLock> {
  const tag = slotTag(slot, slots);
  const session = await spawnHelperAndAwaitAck(
    root,
    boxLockHelper(),
    signal,
    slot,
  );
  const { child, exited, outcome, stderr, file } = session;

  if (outcome.kind === "helper-gone") {
    // Nothing to release, but the unwritten stdin pipe handle would otherwise
    // linger until GC.
    child.stdin.destroy();
    throw new BoxLockUnavailableError(
      file,
      describeExit(outcome.exit, stderr()),
    );
  }
  if (outcome.kind === "aborted") {
    // Blocked in flock(2): it will never read the EOF, so kill it outright.
    child.kill("SIGKILL");
    child.stdin.destroy();
    await exited;
    throw abortError();
  }

  log?.(`box lock acquired by ${holder} (helper pid ${child.pid}${tag})`);
  const lock = heldLock(session, holder, log, slot, slots);

  if (signal?.aborted) {
    // A cancel can land in the instant the previous holder released: never
    // run a cancelled run's body — give the lock straight back.
    await lock.release();
    throw abortError();
  }
  return lock;
}

/**
 * Acquire ONE of `slots` box slots (#205). At `slots === 1` this is exactly
 * `acquireBoxLock` on `box.lock`. Above that: try every slot without waiting,
 * starting at the holder-rotated index, and only when all are held park on a
 * waiting acquire of the rotated slot — honouring the run's AbortSignal between
 * tries and inside the wait, exactly as the exclusive path does. A full budget
 * therefore DELAYS admission; it never fails a run and never cancels one
 * (ADR-007 Decision 5).
 *
 * KNOWN TRADE-OFF: a parked waiter waits on its rotated slot ONLY. If another
 * slot frees first it keeps waiting while that slot idles, and a later arrival
 * whose rotation names the free slot takes it. Polling every slot would fix
 * that and would be the polling loop I1 forbids; in practice the engine's
 * `slots = N` keeps in-process concurrency at N, so the park only ever happens
 * in the crash-relaunch overlap window, where a short idle beats a poll.
 */
export async function acquireBoxSlot({
  root,
  slots,
  holder,
  signal,
  log,
}: AcquireBoxSlotOptions): Promise<BoxLock> {
  assertSlotCount(slots, "acquireBoxSlot");
  if (slots === 1) {
    return acquireBoxLock({ root, holder, signal, log });
  }
  const start = rotationStart(holder, slots);
  for (let k = 0; k < slots; k++) {
    if (signal?.aborted) throw abortError();
    const slot = (start + k) % slots;
    const lock = await tryAcquireBoxLock({ root, holder, log, slot, slots });
    if (lock) {
      if (signal?.aborted) {
        await lock.release();
        throw abortError();
      }
      return lock;
    }
  }
  log?.(
    `box budget full (${slots} slots held) — ${holder} waits on slot ${start}`,
  );
  return acquireBoxLock({ root, holder, signal, log, slot: start, slots });
}

/**
 * Non-blocking take of EVERY slot (#205), for the boot uid scan: with all N
 * held, no run can be live on this box, so a scan of every slot's uid is safe.
 * Any slot busy ⇒ release whatever was taken and return null — a live run owns
 * part of the box and its own teardown scan reclaims. Never partially held on
 * return.
 */
export async function tryAcquireAllBoxSlots({
  root,
  slots,
  holder,
  log,
}: Omit<AcquireBoxSlotOptions, "signal">): Promise<BoxLock[] | null> {
  assertSlotCount(slots, "tryAcquireAllBoxSlots");
  const held: BoxLock[] = [];
  try {
    for (let slot = 0; slot < slots; slot++) {
      const lock = await tryAcquireBoxLock({ root, holder, log, slot, slots });
      if (!lock) {
        await releaseAll(held, log);
        return null;
      }
      held.push(lock);
    }
    return held;
  } catch (e) {
    await releaseAll(held, log);
    throw e;
  }
}

/**
 * Release every lock concurrently; a failed release is logged (naming the
 * slot) and never masks the caller's error or skips the others. Each release
 * is bounded by RELEASE_EXIT_BOUND_MS, so N releases cost one bound, not N.
 */
export async function releaseAll(
  held: BoxLock[],
  log?: (line: string) => void,
): Promise<void> {
  const results = await Promise.allSettled(held.map((h) => h.release()));
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      const e: unknown = r.reason;
      log?.(
        `box lock release failed for slot ${held[i]?.slot ?? i}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });
}

/**
 * Non-blocking acquire (#184): `null` when another process holds the lock,
 * never waits. Used by the boot-time uid scan, which must skip — not queue
 * behind — a live run. Busy is the helper's pre-ack exit 75 with no spawn
 * error; any other pre-ack exit is the same `BoxLockUnavailableError` as the
 * waiting acquire. On ack the returned lock is the same memoised release
 * closure, LOST observer included.
 */
export async function tryAcquireBoxLock({
  root,
  holder,
  log,
  helper,
  slot = 0,
  slots = 1,
}: TryAcquireBoxLockOptions): Promise<BoxLock | null> {
  const tag = slotTag(slot, slots);
  const session = await spawnHelperAndAwaitAck(
    root,
    helper ?? boxLockTryHelper(),
    undefined,
    slot,
  );
  const { child, outcome, stderr, file } = session;

  if (outcome.kind === "helper-gone") {
    child.stdin.destroy();
    const { exit } = outcome;
    if (exit.code === TRY_LOCK_BUSY_EXIT && !exit.spawnError) {
      log?.(`box lock busy — ${holder} did not wait${tag}`);
      return null;
    }
    throw new BoxLockUnavailableError(file, describeExit(exit, stderr()));
  }
  if (outcome.kind === "aborted") {
    // Unreachable: no signal is passed to the try path. Kept exhaustive so a
    // future signal parameter cannot silently fall through to "acquired".
    child.kill("SIGKILL");
    child.stdin.destroy();
    await session.exited;
    throw abortError();
  }

  log?.(`box lock acquired by ${holder} (helper pid ${child.pid}${tag})`);
  return heldLock(session, holder, log, slot, slots);
}

/** Run `fn` holding the box lock; releases on return, throw, or abort. */
export async function withBoxLock<T>(
  opts: AcquireBoxLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireBoxLock(opts);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
