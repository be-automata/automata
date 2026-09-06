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
 * releases it last in its finally. Worker `slots: 1` bounds how many runs can
 * wait here.
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
 * #184 adds the try-lock variant; conflict exit codes differ per platform
 * (lockf `-t 0` → 75, util-linux flock `-n` → 1 unless `-E 75`).
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
}

export interface AcquireBoxLockOptions {
  /** The run-namespace root; the lock file is `<root>/box.lock`. */
  root: string;
  /** Who is taking the lock — appears in the log line only. */
  holder: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

interface BoxLockHelper {
  file: string;
  args: string[];
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

/** The single builder of the lock-file path. */
export function boxLockPath(root: string): string {
  return path.join(root, "box.lock");
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
async function settlesWithin(
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

export async function acquireBoxLock({
  root,
  holder,
  signal,
  log,
}: AcquireBoxLockOptions): Promise<BoxLock> {
  await mkdir(root, { recursive: true });
  if (signal?.aborted) throw abortError();
  const { file, args } = boxLockHelper();
  const lockFile = boxLockPath(root);
  const child = spawn(file, [...args, lockFile, SH_BIN, "-c", HELPER_COMMAND], {
    stdio: ["pipe", "pipe", "pipe"],
  });
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

  if (outcome.kind === "helper-gone") {
    throw new BoxLockUnavailableError(file, describeExit(outcome.exit, stderr));
  }
  if (outcome.kind === "aborted") {
    // Blocked in flock(2): it will never read the EOF, so kill it outright.
    child.kill("SIGKILL");
    child.stdin.destroy();
    await exited;
    throw abortError();
  }

  log?.(`box lock acquired by ${holder} (helper pid ${child.pid})`);

  // A helper that dies AFTER the ack (killed by hand, OOM, a stray cleanup)
  // drops the lock while this run still believes it holds it. Nothing can
  // recover that mid-run; make it loud instead of silent.
  let released = false;
  void (async () => {
    const exit = await exited;
    if (!released) {
      log?.(
        `box lock LOST by ${holder}: helper ${describeExit(exit, stderr)} — the box budget is unguarded until this run ends`,
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
      })`,
    );
  };
  const release = (): Promise<void> => {
    releasing ??= doRelease();
    return releasing;
  };

  if (signal?.aborted) {
    // A cancel can land in the instant the previous holder released: never
    // run a cancelled run's body — give the lock straight back.
    await release();
    throw abortError();
  }
  return { release };
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
