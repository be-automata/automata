import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import { NextMessageHttpError } from "./www-client";

/**
 * Non-retryable error classification (#6). Mark KNOWN-TERMINAL errors
 * `NonRetryableError` so they route straight to the on-failure handler instead of
 * burning agent-minutes on backoff. This is correct to apply now even though the run
 * task is `retries: 0` today (no auto-retry) — it keeps the classification right if
 * retries are ever raised, and documents intent.
 *
 * TRANSIENT (5xx / network) stays a plain Error (retryable); a 4xx from next-message
 * (PR gone / permission revoked / bad token) is terminal → NonRetryableError.
 */
export function classifyNextMessageError(err: unknown): unknown {
  if (
    err instanceof NextMessageHttpError &&
    err.status >= 400 &&
    err.status < 500
  ) {
    return new NonRetryableError(
      `next-message ${err.status} (PR gone / permission / bad token) — non-retryable: ${err.message}`,
    );
  }
  return err; // 5xx / network / abort → retryable (unchanged)
}

/** Wrap a preflight gh-auth failure as non-retryable (a misconfig, never transient). */
export function nonRetryablePreflight(err: unknown): NonRetryableError {
  return new NonRetryableError(
    `gh auth precondition failed — non-retryable (misconfig, not transient): ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}

/**
 * #204: the agent exceeded its per-run memory ceiling.
 *
 * Terminal, not retryable: a run that did not fit will not fit on a retry, and
 * burning agent-minutes on backoff to prove it is waste. The client sees a cause
 * instead of an opaque crash.
 *
 * WHY THE CALLER MUST PASS `oomKills` AND NOT JUST THE EXIT CODE. Every SIGKILL
 * exits 137 — including our OWN teardown kill and a supersede. Classifying on 137
 * alone would report a cancelled run as having blown its memory budget, which is
 * a confidently wrong cause and worse than a generic failure. The kernel's
 * `memory.events` `oom_kill` counter is the only positive signal, so this asks
 * for it and refuses to guess.
 */
export class ResourceLimitError extends Error {
  constructor(
    readonly memoryMaxBytes: number,
    readonly oomKills: number,
  ) {
    super(
      `agent run exceeded its memory ceiling (${memoryMaxBytes} bytes); ` +
        `the kernel OOM-killed it ${oomKills} time(s) inside its cgroup`,
    );
    this.name = "ResourceLimitError";
  }
}

/**
 * Classify a dead agent child. Returns a terminal `ResourceLimitError` ONLY when
 * the kernel says it OOM-killed something in this run's cgroup; anything else is
 * returned untouched so its own cause survives.
 */
export function classifyAgentExit(opts: {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** From memory.events; 0 when the feature is off or the file is gone. */
  oomKills: number;
  memoryMaxBytes: number;
  fallback: unknown;
}): unknown {
  const killed = opts.signal === "SIGKILL" || opts.exitCode === 137;
  if (killed && opts.oomKills > 0) {
    return new NonRetryableError(
      new ResourceLimitError(opts.memoryMaxBytes, opts.oomKills).message,
    );
  }
  return opts.fallback;
}
