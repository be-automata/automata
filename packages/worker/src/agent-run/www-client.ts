import type { DaemonEventAPIBody } from "@terragon/daemon/shared";
import type { PulledDaemonMessage } from "./types";

/**
 * The worker's HTTP client for the control plane's daemon endpoints (ADR-003).
 * Auth is the same X-Daemon-Token the in-sandbox daemon uses; the ids travel in
 * the POST body (F5 — threadChatId is an enumeration key, kept out of URLs/logs).
 */

export interface WwwClientOpts {
  baseUrl: string;
  daemonToken: string;
  threadId: string;
  threadChatId: string;
  /**
   * W3C `traceparent` for the #7 end-to-end trace join. When present it is sent as a
   * `traceparent` header on every www call so the control-plane handler (and the
   * GitHub post it triggers) continue the dispatch-minted trace. Undefined → the
   * header is simply omitted (trace join is a no-op, no behaviour change).
   */
  traceparent?: string;
}

function endpoint(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${pathname}`;
}

function headers(opts: WwwClientOpts): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    "x-daemon-token": opts.daemonToken,
  };
  if (opts.traceparent) {
    h.traceparent = opts.traceparent;
  }
  return h;
}

/**
 * A next-message HTTP failure that carries the status code so the workflow can
 * classify it (#6): a 4xx (PR gone / permission / bad token) is a NonRetryableError;
 * a 5xx / network error stays retryable.
 */
export class NextMessageHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "NextMessageHttpError";
  }
}

/**
 * Pull the DaemonMessage to run. Returns null when www has nothing to send (204):
 * the run is a no-op and the worker cleans up without spawning the agent.
 *
 * H2 (ADR-003): the 200 body carries the prompt (repo content + user text) — it is
 * SENSITIVE. This returns it to the caller but never logs it; callers must not log
 * it either.
 */
export async function pullNextMessage(
  opts: WwwClientOpts,
  signal?: AbortSignal,
): Promise<PulledDaemonMessage | null> {
  const res = await fetch(endpoint(opts.baseUrl, "/api/daemon/next-message"), {
    method: "POST",
    headers: headers(opts),
    body: JSON.stringify({
      threadId: opts.threadId,
      threadChatId: opts.threadChatId,
    }),
    signal,
  });
  if (res.status === 204) {
    return null;
  }
  if (!res.ok) {
    throw new NextMessageHttpError(
      res.status,
      `next-message failed: HTTP ${res.status} (${res.statusText})`,
    );
  }
  return (await res.json()) as PulledDaemonMessage;
}

/** Max length of the failure reason forwarded to www (bounds accidental leakage). */
const MAX_REASON_LEN = 500;

/**
 * #2 terminal-failure callback. On a FAILED run, POST a SYNTHETIC `custom-error`
 * daemon-event to /api/daemon-event so www runs its existing terminal-error finish
 * pipeline (marks the thread failed, review reconciler posts a "couldn't complete"
 * comment, queue drains) instead of leaving a silent "working…" hang. Reuses the
 * daemon-event path + the run's daemonToken — no new endpoint, no new terminal path
 * (a second terminal transition on an already-terminal thread is a CAS no-op).
 *
 * H2: `reason` must ONLY ever be a Hatchet error summary (error class/message from
 * ctx.errors() or a caught error) — NEVER agent output or the prompt. Truncated to
 * MAX_REASON_LEN as belt-and-suspenders.
 *
 * NEVER throws: onFailure must not throw uncaught. A revoked-token failure class
 * (S12 family) 401s here — the daemonToken is already dead — in which case the
 * www-side stalled-thread watchdog is the only backstop (documented at the call
 * site in workflow.ts). Both a request error and a non-2xx are logged, not thrown.
 */
export async function postRunFailed(
  opts: WwwClientOpts,
  { reason }: { reason: string },
): Promise<void> {
  const body: DaemonEventAPIBody = {
    threadId: opts.threadId,
    threadChatId: opts.threadChatId,
    timezone: "UTC",
    messages: [
      {
        type: "custom-error",
        session_id: null,
        duration_ms: 0,
        error_info: reason.slice(0, MAX_REASON_LEN),
      },
    ],
  };
  let res: Response;
  try {
    res = await fetch(endpoint(opts.baseUrl, "/api/daemon-event"), {
      method: "POST",
      headers: headers(opts),
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error("[agent-run] postRunFailed request failed (swallowed)", {
      threadId: opts.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!res.ok) {
    // 401 here = the revoked-token failure class (daemonToken already dead); the
    // stalled-thread watchdog is the backstop. Log, never throw.
    console.error(
      "[agent-run] postRunFailed non-2xx — thread not marked failed here",
      {
        threadId: opts.threadId,
        status: res.status,
      },
    );
  }
}

export type ThreadStatusPoll =
  | { kind: "status"; status: string; terminal: boolean }
  | { kind: "auth-error"; httpStatus: number };

/**
 * One thread-status poll. A 401/403 is reported as `revoked` — the caller decides
 * whether that means "terminal, token revoked at finish" (any poll after a prior
 * success) or a genuine first-poll auth failure (ADR-003 revoke-race ruling).
 */
export async function pollThreadStatus(
  opts: WwwClientOpts,
  signal?: AbortSignal,
): Promise<ThreadStatusPoll> {
  const res = await fetch(endpoint(opts.baseUrl, "/api/daemon/thread-status"), {
    method: "POST",
    headers: headers(opts),
    body: JSON.stringify({
      threadId: opts.threadId,
      threadChatId: opts.threadChatId,
    }),
    signal,
  });
  if (res.status === 401 || res.status === 403) {
    return { kind: "auth-error", httpStatus: res.status };
  }
  if (!res.ok) {
    throw new Error(
      `thread-status failed: HTTP ${res.status} (${res.statusText})`,
    );
  }
  const body = (await res.json()) as { status: string; terminal: boolean };
  return { kind: "status", status: body.status, terminal: body.terminal };
}

/** Minimal slice of the Hatchet task Context the poll loop needs. */
export interface PollContext {
  readonly cancelled: boolean;
  log: (message: string) => unknown;
  /** Aborted when Hatchet cancels the run (scheduleTimeout/executionTimeout). */
  signal?: AbortSignal;
}

export interface PollResult {
  outcome: "completed" | "cancelled";
  finalStatus?: string;
}

/**
 * Sleep that returns EARLY the moment the run is cancelled, so the poll loop reacts
 * to a Hatchet cancel within ~250ms instead of a full poll interval — the daemon
 * teardown must not wait out a 7s sleep after cancellation.
 */
async function cancellableSleep(ms: number, ctx: PollContext): Promise<void> {
  const step = 250;
  let elapsed = 0;
  while (elapsed < ms) {
    if (ctx.cancelled || ctx.signal?.aborted) {
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(step, ms - elapsed)),
    );
    elapsed += step;
  }
}

/**
 * Poll thread-status until terminal. Completion is observed directly: www revokes the
 * daemon token only on the terminal-READ (ADR-003 revoke-on-terminal-read) — i.e. right
 * after serving {terminal:true} — so the worker reliably sees terminal=true and returns
 * before the token dies. Therefore a 401/403 (auth-error) at ANY point is a FAILURE, not
 * a completion: on the first poll it's a bad/invalid token; after a successful poll it
 * means the token was revoked WITHOUT this worker ever observing terminal=true — a
 * premature/anomalous revocation mid-run. Both throw (Hatchet FAILED), never a silent
 * COMPLETED-with-no-reply. (This closes the S12 laundering: the prior ruling treated a
 * mid-work 401/403 as 'terminal-inferred-from-revocation'→completed, which masked any
 * mid-run revocation as success.) A Hatchet cancellation (ctx.cancelled / aborted signal)
 * ends the loop PROMPTLY with outcome 'cancelled' so the caller can tear the daemon down.
 */
export async function pollUntilTerminal(
  ctx: PollContext,
  opts: WwwClientOpts,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => cancellableSleep(ms, ctx),
): Promise<PollResult> {
  let hadSuccessfulPoll = false;
  let lastStatus: string | undefined;

  for (;;) {
    if (ctx.cancelled || ctx.signal?.aborted) {
      return { outcome: "cancelled", finalStatus: lastStatus };
    }

    let poll: ThreadStatusPoll;
    try {
      poll = await pollThreadStatus(opts, ctx.signal);
    } catch (error) {
      // A cancel-aborted fetch throws AbortError — treat as cancellation, not a
      // hard failure, so the finally-block teardown runs cleanly.
      if (ctx.cancelled || ctx.signal?.aborted) {
        return { outcome: "cancelled", finalStatus: lastStatus };
      }
      throw error;
    }
    if (poll.kind === "auth-error") {
      // Under revoke-on-terminal-READ (ADR-003), www revokes the daemon token only
      // AFTER serving terminal=true — which this loop returns on below (the poll.terminal
      // branch). So a 401/403 here, even after a prior successful poll, means the token
      // was revoked WITHOUT this worker ever observing a terminal status: a premature /
      // anomalous revocation while the run was still in flight, NOT a completion. Fail
      // LOUD (Hatchet FAILED) rather than silently reporting COMPLETED with no reply —
      // that silent-completion laundering is the S12 class this closes.
      if (hadSuccessfulPoll) {
        throw new Error(
          `thread-status auth error (HTTP ${poll.httpStatus}) after last status ` +
            `'${lastStatus ?? "unknown"}' without observing terminal=true — token ` +
            `revoked before completion (premature revocation; run did not finish)`,
        );
      }
      throw new Error(
        `thread-status auth error on first poll: HTTP ${poll.httpStatus} — daemon token invalid`,
      );
    }

    hadSuccessfulPoll = true;
    lastStatus = poll.status;
    ctx.log(`thread-status: ${poll.status} (terminal=${poll.terminal})`);
    if (poll.terminal) {
      return { outcome: "completed", finalStatus: poll.status };
    }

    await sleep(pollIntervalMs);
  }
}
