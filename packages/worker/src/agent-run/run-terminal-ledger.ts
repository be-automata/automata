import fs from "node:fs";
import path from "node:path";

import { NonRetryableError } from "@hatchet-dev/typescript-sdk";

/**
 * The box's record of which workflow runs already reached a terminal (#386).
 *
 * The hole this closes: on SIGTERM the SDK (v1.26.0, `exitGracefully` in
 * worker-internal.js) stops the dispatcher heartbeat and unsubscribes the
 * listener FIRST, and only then awaits the in-flight task futures. Each future
 * awaits its own COMPLETED/FAILED event (`sendStepActionEvent`, with the SDK's
 * retrier), so the event IS sent before the drain completes — the SDK ordering
 * is not the gap. The gap is that the engine has stopped hearing from the
 * worker while the run is still draining: observed in prod (2026-10-19), a
 * deferring run failed on schedule five minutes into a drain, the process
 * exited, and the engine redelivered the SAME workflow run (attempt 0) to the
 * next worker process, which ran the agent to completion — a task the worker
 * had reported failed was executed again. Any terminal that ends a long drain
 * can be redelivered the same way.
 *
 * So the run fn writes `<root>/run-terminals/<runId>.json` the moment it ends
 * (returned or threw), and an attempt of a run id already recorded is refused
 * with a NonRetryableError before it touches anything — no admission, no
 * clone, no daemon. A worker-loss redelivery of a run that never ENDED (a
 * crash mid-run, #152) finds no entry and re-executes as before.
 *
 * `root` is `WORKER_RUN_TERMINAL_ROOT` (config.ts `runTerminalRoot`), shared by
 * every worker process on the box. On the execution box run-worker.sh names
 * `/usr/local/automata/state`, which survives a reboot; the code default, the
 * run namespace root under /tmp, survives only a restart (`PrivateTmp=no`).
 * Every op is best-effort: an unwritable or unreadable ledger fails OPEN (the
 * run executes) — it narrows the redelivery window, it never blocks a run.
 */

/** How long an entry is kept: well past any redelivery (30m execution + 30m schedule). */
export const RUN_TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The ledger's dir under the run namespace root. It sits beside the
 * per-worker `<workerId>/` dirs, so the reapers' root scan (reclaim.ts
 * `listWorkerDirs`) excludes it by this name.
 */
export const RUN_TERMINAL_LEDGER_DIR = "run-terminals";
// Hatchet run ids are UUIDs; anything else is never used as a file name.
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type RunTerminalOutcome = "returned" | "failed";

export interface RunTerminal {
  outcome: RunTerminalOutcome;
  /** The error class/message for a failed run (never agent output). */
  detail?: string;
}

export interface RecordedRunTerminal extends RunTerminal {
  /** Epoch ms when the run ended. */
  at: number;
}

interface InFlightAttempt {
  /** Epoch ms when the attempt started. */
  startedAt: number;
  /** Settles with the attempt's terminal once it ends (never rejects). */
  ended: Promise<RecordedRunTerminal>;
}

/** The attempts executing in THIS process, by workflow run id. */
const IN_FLIGHT = new Map<string, InFlightAttempt>();

/** A redelivered attempt of a run id that already reached a terminal on this box. */
export class RunAlreadyTerminalError extends NonRetryableError {
  constructor(
    readonly runId: string,
    readonly prior: RecordedRunTerminal,
  ) {
    super(
      `workflow run ${runId} already ${prior.outcome === "failed" ? "failed" : "finished"} on this box at ` +
        `${new Date(prior.at).toISOString()}; redelivered attempt refused, not re-executed (#386)`,
    );
    this.name = "RunAlreadyTerminalError";
  }
}

/**
 * The boot log line naming the ledger root, plus a warning when that root is
 * under /tmp on Linux: Ubuntu's tmpfiles (`D /tmp`) wipes it at boot, so a
 * reboot mid-drain would let the engine re-execute a run that already ended.
 */
export function runTerminalRootBootLines(
  root: string,
  platform: NodeJS.Platform = process.platform,
): { line: string; warning: string | null } {
  const underTmp = root === "/tmp" || root.startsWith("/tmp/");
  return {
    line: `run-terminal ledger root=${root}`,
    warning:
      platform === "linux" && underTmp
        ? `run-terminal ledger root ${root} is under /tmp, which is wiped at boot — set WORKER_RUN_TERMINAL_ROOT to a durable dir (#386)`
        : null,
  };
}

function entryPath(root: string, runId: string): string | null {
  return SAFE_RUN_ID.test(runId)
    ? path.join(root, RUN_TERMINAL_LEDGER_DIR, `${runId}.json`)
    : null;
}

function isRecordedRunTerminal(v: unknown): v is RecordedRunTerminal {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    (o.outcome === "returned" || o.outcome === "failed") &&
    typeof o.at === "number"
  );
}

/** The recorded terminal for `runId`, or null (none, unsafe id, unreadable). */
export function readRunTerminal(
  root: string,
  runId: string,
): RecordedRunTerminal | null {
  const file = entryPath(root, runId);
  if (!file) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecordedRunTerminal(parsed) ? parsed : null;
  } catch {
    // Absent (the common case) or corrupt: fail open.
    return null;
  }
}

/**
 * Record `runId`'s terminal (atomic write: tmp + rename) and prune entries
 * older than RUN_TERMINAL_TTL_MS. Never throws; failures go to `log`.
 */
export function recordRunTerminal(
  root: string,
  runId: string,
  terminal: RunTerminal,
  now: number = Date.now(),
  log: (msg: string) => void = () => {},
): void {
  const file = entryPath(root, runId);
  if (!file) return;
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const entry: RecordedRunTerminal = { ...terminal, at: now };
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, file);
  } catch (err) {
    log(
      `run-terminal ledger: could not record ${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      // A `.tmp` left by a crash mid-write is aged by its mtime like an
      // unreadable entry; anything else is not ours.
      const isTmp = name.endsWith(".tmp");
      if (!isTmp && !name.endsWith(".json")) continue;
      const at =
        (isTmp
          ? undefined
          : readRunTerminal(root, name.slice(0, -".json".length))?.at) ??
        fs.statSync(path.join(dir, name)).mtimeMs;
      if (now - at > RUN_TERMINAL_TTL_MS) fs.rmSync(path.join(dir, name));
    }
  } catch (err) {
    log(
      `run-terminal ledger: prune failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Run `run` at most once to a terminal per workflow run id on this box: refuse
 * (RunAlreadyTerminalError) an id already recorded, otherwise run it and record
 * how it ended. Without a run id there is nothing to key on — run unguarded.
 *
 * `onAlreadyReturned` turns the refusal of a run whose first attempt RETURNED
 * into a no-op output instead of a throw. Measured on hatchet-lite
 * (run-terminal-redelivery.integration.test.ts): the drained attempt's own
 * FINISHED event is ignored once the engine REASSIGNED the run, so the
 * redelivered attempt's result IS the run's engine status — a throw would
 * mark a run whose work completed FAILED and fire onFailure. A run whose first
 * attempt failed is still refused with a throw: FAILED is its true status.
 *
 * An attempt of a run id whose earlier attempt is STILL RUNNING in this
 * process (the engine REASSIGNED it after a heartbeat stall > 30 s while the
 * process stayed alive — an engine-internal retry that ignores `retries: 0`)
 * waits for that attempt to end, then is answered from its terminal exactly as
 * above: never two attempts of one run at once. It waits before admission, so
 * it holds no box slot meanwhile. Two worker processes, or a second box, are
 * not covered here; the www generation fence is the backstop there.
 */
export async function guardRunTerminal<T>(
  opts: {
    root: string;
    runId: string;
    log: (msg: string) => void;
    onAlreadyReturned?: (prior: RecordedRunTerminal) => T;
  },
  run: () => Promise<T>,
): Promise<T> {
  const { root, runId, log, onAlreadyReturned } = opts;
  if (!runId) return run();
  const inFlight = IN_FLIGHT.get(runId);
  let prior: RecordedRunTerminal | null;
  if (inFlight) {
    log(
      `run.concurrent_attempt ${JSON.stringify({
        runId,
        priorStartedAt: new Date(inFlight.startedAt).toISOString(),
        action: "wait",
      })}`,
    );
    const ended = await inFlight.ended;
    // The ledger write is best-effort; the in-memory terminal is not.
    prior = readRunTerminal(root, runId) ?? ended;
  } else {
    prior = readRunTerminal(root, runId);
  }
  if (prior) {
    const noop = prior.outcome === "returned" && onAlreadyReturned;
    const err = new RunAlreadyTerminalError(runId, prior);
    log(
      noop
        ? `workflow run ${runId} already finished on this box at ` +
            `${new Date(prior.at).toISOString()}; redelivered attempt completed as a no-op, not re-executed (#386)`
        : err.message,
    );
    // One greppable, structured line per redelivery the ledger caught — the
    // box has no metrics pipeline, so this is what a post-restart check reads.
    log(
      `run.redelivery_refused ${JSON.stringify({
        runId,
        prior: prior.outcome,
        priorAt: new Date(prior.at).toISOString(),
        gapMs: Date.now() - prior.at,
        action: noop ? "noop" : "refused",
      })}`,
    );
    if (noop) return onAlreadyReturned(prior);
    throw err;
  }
  let settle: (terminal: RecordedRunTerminal) => void = () => {};
  const entry: InFlightAttempt = {
    startedAt: Date.now(),
    ended: new Promise((resolve) => {
      settle = resolve;
    }),
  };
  IN_FLIGHT.set(runId, entry);
  const end = (terminal: RunTerminal): void => {
    const at = Date.now();
    recordRunTerminal(root, runId, terminal, at, log);
    if (IN_FLIGHT.get(runId) === entry) IN_FLIGHT.delete(runId);
    settle({ ...terminal, at });
  };
  try {
    const output = await run();
    end({ outcome: "returned" });
    return output;
  } catch (err) {
    end({
      outcome: "failed",
      detail: err instanceof Error ? `${err.name}: ${err.message}` : "",
    });
    throw err;
  }
}
