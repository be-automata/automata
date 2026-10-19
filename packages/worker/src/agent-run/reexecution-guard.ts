import fs from "node:fs";
import path from "node:path";

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
 * The rule: the box counts the deferrals it threw per WORKFLOW RUN (the
 * engine's run id — stable across that run's retries, distinct for every run
 * of a thread: supersede siblings, re-reviews; never the threadId). An attempt
 * number above that count did not come from a deferral, so it is refused up
 * front with a NonRetryableError, before any side effect (no namespace, no
 * slot, no clone). The refusal is short: the engine's first retry backs off
 * 2 s and is re-queued at priority 4, so the run reaches FAILED (and www's
 * failure banner) seconds after the timeout, not after another queue wait.
 *
 * The ledger is DURABLE across a worker restart or deploy: one tiny file per
 * run under `<runNamespaceRoot>/deferrals/`, written on each deferral, removed
 * when the run ends on this box, read whenever the in-process map has no
 * entry. So a run deferred before a deploy is still admitted by its retry on
 * the new process. What it does not cover — stated, not hidden — is a second
 * worker process on the same engine tenant: the box is one worker
 * (ADR-007 I3), and a retry that lands elsewhere is refused (fail-closed).
 *
 * Bounded: an entry whose retry never comes back (the budget ran out, a cancel
 * while QUEUED in backoff) is pruned once older than the longest a retry can
 * legitimately take to return — the whole deferral budget plus one
 * scheduleTimeout.
 */
const deferrals = new Map<string, { count: number; at: number }>();

/** Σbackoff budget (12 min) + one scheduleTimeout (30 m), with margin. */
export const LEDGER_TTL_MS = 45 * 60 * 1000;

/** Where the durable copy lives under the run-namespace root. */
export const LEDGER_DIRNAME = "deferrals";

export interface LedgerOpts {
  /** The run-namespace root; the durable copy is `<root>/deferrals/<key>.json`. Omitted ⇒ in-process only (tests). */
  root?: string;
  now?: number;
  /** Where a failed durable write/remove is reported (it decides whether a retry after a restart is admitted). */
  log?: (line: string) => void;
}

function fileFor(root: string, runKey: string): string {
  // The key is an engine uuid or a threadId; keep the filename inert anyway.
  return path.join(
    root,
    LEDGER_DIRNAME,
    `${runKey.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`,
  );
}

function readDurable(root: string, runKey: string, now: number): number {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(root, runKey), "utf8")) as {
      count?: unknown;
      at?: unknown;
    };
    const count = typeof raw.count === "number" ? raw.count : 0;
    const at = typeof raw.at === "number" ? raw.at : 0;
    if (now - at > LEDGER_TTL_MS) return 0;
    return Number.isInteger(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

function writeDurable(
  root: string,
  runKey: string,
  entry: { count: number; at: number },
  log?: (line: string) => void,
): void {
  try {
    fs.mkdirSync(path.join(root, LEDGER_DIRNAME), {
      recursive: true,
      mode: 0o700,
    });
    const file = fileFor(root, runKey);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch (e) {
    // The in-process copy still governs this process's retries; what is lost
    // is the retry after a RESTART, which the guard would then refuse — so the
    // operator must be able to trace that refusal back to this line.
    log?.(
      `box.deferral_ledger_write_failed ${JSON.stringify({
        runKey,
        error: e instanceof Error ? e.message : String(e),
      })}`,
    );
  }
}

function removeDurable(
  root: string,
  runKey: string,
  log?: (line: string) => void,
): void {
  try {
    fs.rmSync(fileFor(root, runKey), { force: true });
  } catch (e) {
    log?.(
      `box.deferral_ledger_remove_failed ${JSON.stringify({
        runKey,
        error: e instanceof Error ? e.message : String(e),
      })}`,
    );
  }
}

function prune(now: number): void {
  for (const [key, entry] of deferrals) {
    if (now - entry.at > LEDGER_TTL_MS) deferrals.delete(key);
  }
}

/** The headroom check deferred this run once more (the only retryable throw). */
export function recordDeferral(runKey: string, opts: LedgerOpts = {}): void {
  const now = opts.now ?? Date.now();
  prune(now);
  const entry = {
    count:
      (deferrals.get(runKey)?.count ??
        (opts.root ? readDurable(opts.root, runKey, now) : 0)) + 1,
    at: now,
  };
  deferrals.set(runKey, entry);
  if (opts.root) {
    writeDurable(opts.root, runKey, entry, opts.log);
    sweepDeferralLedger(opts.root, now);
  }
}

export function deferralsRecorded(
  runKey: string,
  opts: LedgerOpts = {},
): number {
  const now = opts.now ?? Date.now();
  // The TTL applies to the in-memory copy on every read too, so a stale count
  // admits nothing whether or not the process restarted meanwhile.
  prune(now);
  return (
    deferrals.get(runKey)?.count ??
    (opts.root ? readDurable(opts.root, runKey, now) : 0)
  );
}

/**
 * Remove durable entries older than the TTL — the ones no retry will ever
 * claim (a cancel while QUEUED in backoff, a retry that landed elsewhere).
 * Run at boot and on every recorded deferral; returns how many were removed.
 */
export function sweepDeferralLedger(root: string, now = Date.now()): number {
  const dir = path.join(root, LEDGER_DIRNAME);
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { at?: unknown };
      const at = typeof raw.at === "number" ? raw.at : 0;
      if (now - at > LEDGER_TTL_MS) {
        fs.rmSync(file, { force: true });
        removed += 1;
      }
    } catch {
      // unreadable ⇒ worthless; remove it too
      try {
        fs.rmSync(file, { force: true });
        removed += 1;
      } catch {
        // best-effort
      }
    }
  }
  return removed;
}

/** How many runs the in-process ledger currently tracks (tests, boot line). */
export function ledgerSize(): number {
  return deferrals.size;
}

/**
 * Refuse an attempt the deferral ledger does not account for. Call FIRST in
 * the run, before any side effect. Throws NonRetryableError (final) — and that
 * message is what the thread's failure banner shows, so it names the cause
 * the engine's retry hid.
 */
export function assertNotReexecuting(
  runKey: string,
  attempt: number,
  opts: LedgerOpts = {},
): void {
  const deferred = deferralsRecorded(runKey, opts);
  if (attempt > deferred) {
    throw new NonRetryableError(
      `The previous attempt of this run ended in an engine-side failure — most likely its execution timeout ` +
        `(30 minutes), otherwise a worker restart or a redelivery — and the engine re-dispatched it ` +
        `(attempt ${attempt + 1}, ${deferred} admission deferral(s) on record). An agent run never ` +
        `re-executes, so it stops here with the first attempt's result.`,
    );
  }
}

/** The run ended on this box (completed, failed final, cancelled, or its last deferral): drop its ledger entry. */
export function forgetRun(runKey: string, opts: LedgerOpts = {}): void {
  deferrals.delete(runKey);
  if (opts.root) removeDurable(opts.root, runKey, opts.log);
}

/** Tests: clear the in-process ledger and, given a root, its durable copy. */
export function _resetReexecutionGuardForTests(root?: string): void {
  deferrals.clear();
  if (root) {
    fs.rmSync(path.join(root, LEDGER_DIRNAME), {
      recursive: true,
      force: true,
    });
  }
}
