import { formatMemoryMax, MemoryStarvationError } from "./retry-classification";
import type { TerminalCause } from "./types";
import {
  postRunTerminal,
  type RunTerminalResult,
  type WwwClientOpts,
} from "./www-client";

/**
 * #437: how a TASK run ended abnormally, as one typed terminal cause.
 *
 * Without this every abnormal end of a task run (timeout, OOM kill, a crash)
 * reached the thread only through onFailure's synthetic `custom-error`:
 * `agent-generic-error` with Hatchet's raw error map as the text and no
 * `terminal_cause` at all. The worker now names the cause itself, inside the
 * run's teardown; onFailure stays the backstop and its later post is absorbed
 * by www's terminal-idempotent write.
 *
 * Only runs that `ownsAbnormalTerminal` (run-lane.ts) classify: review, pr and
 * self-heal terminals are owned elsewhere (postSuperseded, the user-Stop post,
 * the fix check).
 */

/** How far before the execution limit a cancel still counts as the timeout. */
export const TIMEOUT_CANCEL_TOLERANCE_MS = 15_000;

/** What ended the run, as the exit that saw it knows it. */
export interface RunEnd {
  /** The thrown value, when the run threw. */
  thrown?: { error: unknown };
  /** The engine cancelled the run (ctx.cancelled / the run's signal aborted). */
  cancelled: boolean;
  /**
   * The daemon's own OOM signal (cgroup `oom_kill` / container OOMKilled): the
   * terminal error it would fail the run with, or null.
   */
  starvation: unknown;
}

export interface AbnormalEndInput extends RunEnd {
  /** True once the daemon was spawned (`daemon spawned`). */
  daemonStarted: boolean;
  runStartedAt: number;
  now: number;
  runExecutionTimeoutMs: number;
}

/**
 * First match wins (#437 Part A):
 *   1. OOM kill — even when a cancel lands in the same tick → `out-of-memory`
 *   2. cancel at the execution limit → `timeout`
 *   3. an earlier cancel → null (see below)
 *   4. a throw before the daemon started → `run-failed-unreported`
 *   5. any other throw → `daemon-failed`
 * A run that neither threw nor was cancelled ended normally: null.
 *
 * Why an earlier cancel posts nothing (a deliberate departure from #437's
 * `user-cancelled`): a user Stop never gets here — it reaches the worker as
 * the `stopped` outcome and is posted as `user-cancelled` by the run fn. What
 * is left is an engine-side cancel the worker cannot attribute, including a
 * stale attempt cancelled after a heartbeat reassignment while attempt n+1
 * of the SAME workflow run id still works the thread. Closing the thread
 * from that attempt would be wrong; the C4 sweep reconciles, as before.
 */
export function classifyAbnormalEnd(o: AbnormalEndInput): TerminalCause | null {
  if (!o.thrown && !o.cancelled) return null;
  if (
    o.starvation != null ||
    o.thrown?.error instanceof MemoryStarvationError
  ) {
    return "out-of-memory";
  }
  if (o.cancelled) {
    const elapsed = o.now - o.runStartedAt;
    return elapsed >= o.runExecutionTimeoutMs - TIMEOUT_CANCEL_TOLERANCE_MS
      ? "timeout"
      : null;
  }
  return o.daemonStarted ? "daemon-failed" : "run-failed-unreported";
}

/**
 * The worker-authored line shown under the error (`detail.info`). Never agent
 * output, never a credential: built only from the cause, the configured limit
 * and the kernel's kill count.
 */
export function abnormalEndInfo(
  cause: TerminalCause,
  o: Pick<RunEnd, "thrown" | "starvation"> & { runExecutionTimeoutMs: number },
): string | undefined {
  if (cause === "timeout") {
    const minutes = Math.round(o.runExecutionTimeoutMs / 60_000);
    return `The run reached its ${minutes}-minute limit.`;
  }
  if (cause === "out-of-memory") {
    // The thrown error when the poll loop raised it, else the daemon's signal
    // (an OOM whose cancel landed in the same tick never threw).
    const oom = [o.thrown?.error, o.starvation].find(
      (e): e is MemoryStarvationError => e instanceof MemoryStarvationError,
    );
    if (oom) {
      return `Memory limit ${formatMemoryMax(oom.memoryMaxBytes)} reached (${oom.oomKills} process(es) killed).`;
    }
  }
  return undefined;
}

export const TERMINAL_POST_ATTEMPTS = 3;
export const TERMINAL_POST_TIMEOUT_MS = 10_000;
/** Backoff before attempt 2 and 3 (#437 Part A2). */
const TERMINAL_POST_BACKOFF_MS = [1_000, 2_000] as const;

export type TerminalPostResult = "applied" | "noop" | "failed";

/**
 * Post one typed terminal, up to 3 attempts on a FRESH 10 s signal each (a
 * teardown's run signal is already aborted). A 409 (a newer generation owns
 * the thread), `applied: false` or any other 4xx is final, never retried.
 * Never throws: after the last failed attempt the onFailure path still closes
 * the thread, exactly as before #437.
 */
export async function postRunTerminalWithRetry({
  wwwOpts,
  runExternalId,
  cause,
  info,
  log,
  post = postRunTerminal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  wwwOpts: WwwClientOpts;
  runExternalId: string;
  cause: TerminalCause;
  info?: string;
  log: (line: string) => void;
  post?: typeof postRunTerminal;
  sleep?: (ms: number) => Promise<void>;
}): Promise<TerminalPostResult> {
  for (let attempt = 1; attempt <= TERMINAL_POST_ATTEMPTS; attempt++) {
    let result: RunTerminalResult;
    try {
      result = await post(
        wwwOpts,
        { runExternalId, cause, ...(info ? { info } : {}) },
        AbortSignal.timeout(TERMINAL_POST_TIMEOUT_MS),
      );
    } catch {
      // postRunTerminal never throws; a substituted post might.
      result = "error";
    }
    if (result === "applied") return "applied";
    if (result === "noop" || result === "rejected") return "noop";
    if (result === "refused") {
      // A 4xx (e.g. the token was revoked on the terminal read) will not
      // change on a retry.
      log(`terminal post refused by www (${cause})`);
      return "failed";
    }
    const backoff = TERMINAL_POST_BACKOFF_MS[attempt - 1];
    if (backoff !== undefined) await sleep(backoff);
  }
  log(
    `terminal post failed after ${TERMINAL_POST_ATTEMPTS} attempts (${cause})`,
  );
  return "failed";
}

/**
 * The once-per-run state shared by the daemon teardown and the outer
 * pre-daemon catch, so a run posts at most one abnormal terminal whichever
 * exit it took.
 */
export interface AbnormalEndState {
  /** ownsAbnormalTerminal(input): false ⇒ every claim is null. */
  owns: boolean;
  runStartedAt: number;
  runExecutionTimeoutMs: number;
  daemonStarted: boolean;
  claimed: boolean;
  /** When the run's abort signal fired; the timeout check reads this. */
  cancelledAt?: number;
}

export function newAbnormalEndState(o: {
  owns: boolean;
  runStartedAt: number;
  runExecutionTimeoutMs: number;
}): AbnormalEndState {
  return { ...o, daemonStarted: false, claimed: false };
}

/** A claimed abnormal end: its cause, and what it was built from. */
export interface AbnormalEnd extends RunEnd {
  cause: TerminalCause;
}

/**
 * Step 1: claim the run's end (at most once per run) and classify it. Null for
 * a run this plane does not own, a normal end, or an end already claimed.
 * Kept apart from the post so a teardown can act on the cause in between.
 */
export function claimAbnormalEnd(
  state: AbnormalEndState,
  end: RunEnd,
  now: number = Date.now(),
): AbnormalEnd | null {
  if (!state.owns || state.claimed) return null;
  state.claimed = true;
  const cause = classifyAbnormalEnd({
    ...end,
    daemonStarted: state.daemonStarted,
    runStartedAt: state.runStartedAt,
    runExecutionTimeoutMs: state.runExecutionTimeoutMs,
    now: end.cancelled ? (state.cancelledAt ?? now) : now,
  });
  return cause === null ? null : { ...end, cause };
}

/**
 * Step 2: post a claimed end. Logs one line:
 * `abnormal end → <cause> terminal: <applied|noop|failed>`. Never throws.
 */
export async function postAbnormalEnd(
  state: AbnormalEndState,
  end: AbnormalEnd,
  {
    wwwOpts,
    log,
    post,
    sleep,
  }: {
    wwwOpts: WwwClientOpts;
    log: (line: string) => void;
    post?: typeof postRunTerminal;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<TerminalPostResult | null> {
  const runExternalId = wwwOpts.runExternalId;
  if (!runExternalId) {
    log(`abnormal end → ${end.cause}: terminal not posted (no workflowRunId)`);
    return null;
  }
  const result = await postRunTerminalWithRetry({
    wwwOpts,
    runExternalId,
    cause: end.cause,
    info: abnormalEndInfo(end.cause, {
      ...end,
      runExecutionTimeoutMs: state.runExecutionTimeoutMs,
    }),
    log,
    ...(post ? { post } : {}),
    ...(sleep ? { sleep } : {}),
  });
  log(`abnormal end → ${end.cause} terminal: ${result}`);
  return result;
}
