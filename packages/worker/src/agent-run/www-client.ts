import type { DaemonEventAPIBody } from "@terragon/daemon/shared";
import type { PulledDaemonMessage, TerminalCause } from "./types";

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
  /**
   * #125 C1: this run's Hatchet externalId, sent as `x-run-external-id` on
   * every www call so the control plane's generation fence can refuse a
   * write from a superseded run uniformly (terminal, verdict, failure).
   * Undefined → header omitted (the fence fails open on that arm).
   */
  runExternalId?: string;
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
  if (opts.runExternalId) {
    h["x-run-external-id"] = opts.runExternalId;
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

/**
 * Pull the run's AGENT PROVIDER credential (D1). Mirrors www's AIAgentCredentials:
 * a `json-file` the agent CLI reads (Claude/Codex), an `env-var` (Amp), or
 * `built-in-credits` meaning "no user credential — run through the control-plane
 * proxy". 204 is treated as built-in-credits.
 *
 * H2-class: the `json-file` contents and `env-var` value are LIVE CREDENTIALS.
 * Never log the returned object. Callers materialise it under a per-run HOME at
 * 0600 and wipe it when the run ends.
 */
export type PulledAgentCredentials =
  | { type: "json-file"; contents: string }
  | { type: "env-var"; key: string; value: string }
  | { type: "built-in-credits" };

/**
 * The agent travels WITH the credential because the worker builds the child env
 * (which fixes HOME, and so the credential file path) before it pulls
 * next-message — it cannot learn the agent from there in time.
 */
export interface PulledAgentCredentialsResult {
  agent: string;
  credentials: PulledAgentCredentials;
}

const CREDITS_ONLY: PulledAgentCredentialsResult = {
  agent: "",
  credentials: { type: "built-in-credits" },
};

export async function pullAgentCredentials(
  opts: WwwClientOpts,
  signal?: AbortSignal,
): Promise<PulledAgentCredentialsResult> {
  const res = await fetch(
    endpoint(opts.baseUrl, "/api/daemon/agent-credentials"),
    {
      method: "POST",
      headers: headers(opts),
      body: JSON.stringify({
        threadId: opts.threadId,
        threadChatId: opts.threadChatId,
      }),
      signal,
    },
  );
  if (res.status === 204) {
    return CREDITS_ONLY;
  }
  if (!res.ok) {
    // Never fail the run over this: an older control plane has no such route
    // (404) and a transient 5xx should not strand the run. Falling back to
    // built-in-credits is the same outcome as a user with no credential —
    // the run proceeds through the proxy rather than dying.
    console.warn("[agent-run] agent-credentials unavailable, using credits", {
      threadId: opts.threadId,
      status: res.status,
    });
    return CREDITS_ONLY;
  }
  return (await res.json()) as PulledAgentCredentialsResult;
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

/**
 * One egress decision on the wire — mirrors the control plane's
 * /api/daemon/egress-event body schema (#66 §3.3): `destinationPort` and
 * `policyLevel` optional, `source` fixed to "worker" for this plane.
 */
export type RunTerminalResult = "applied" | "noop" | "rejected" | "error";

/**
 * POST one typed terminal for THIS run (#125 C1/C4) — the sibling of
 * postRunFailed. www fences it by generation: `runExternalId` must equal the
 * thread's active run or the write is refused (409). Idempotent per
 * (thread, run): retries never double-apply. Never throws — the C4 sweep is
 * the backstop. Returns the outcome for the caller's log line.
 */
export async function postRunTerminal(
  opts: WwwClientOpts,
  {
    runExternalId,
    cause,
    policy,
  }: { runExternalId: string; cause: TerminalCause; policy?: string },
): Promise<RunTerminalResult> {
  let res: Response;
  try {
    res = await fetch(endpoint(opts.baseUrl, "/api/daemon/run-terminal"), {
      method: "POST",
      headers: headers(opts),
      body: JSON.stringify({
        threadId: opts.threadId,
        threadChatId: opts.threadChatId,
        runExternalId,
        cause,
        ...(policy ? { detail: { policy } } : {}),
      }),
    });
  } catch (error) {
    console.error("[agent-run] postRunTerminal request failed (swallowed)", {
      threadId: opts.threadId,
      cause,
      error: error instanceof Error ? error.message : String(error),
    });
    return "error";
  }
  if (res.status === 409) {
    // A newer generation already owns the thread — exactly the race the
    // fence exists to close. Not an error.
    return "rejected";
  }
  if (!res.ok) {
    console.error("[agent-run] postRunTerminal non-2xx", {
      threadId: opts.threadId,
      cause,
      status: res.status,
    });
    return "error";
  }
  const body = (await res.json().catch(() => ({}))) as { applied?: boolean };
  return body.applied ? "applied" : "noop";
}

/**
 * Queue-mode staleness self-check (#125 C4): is a NEWER run already recorded
 * for this run's PR? Fails OPEN on any transport error — a self-check must
 * never strand a run; the worst case is reviewing an obsolete SHA.
 */
export async function checkRunStaleness(
  opts: WwwClientOpts,
  { runExternalId }: { runExternalId: string },
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetch(
      endpoint(opts.baseUrl, "/api/daemon/run-staleness"),
      {
        method: "POST",
        headers: headers(opts),
        body: JSON.stringify({
          threadId: opts.threadId,
          threadChatId: opts.threadChatId,
          runExternalId,
        }),
        signal,
      },
    );
    if (!res.ok) return false;
    const body = (await res.json().catch(() => ({}))) as { stale?: boolean };
    return body.stale === true;
  } catch {
    return false;
  }
}

export interface EgressEventWire {
  destinationHost: string;
  destinationPort?: number;
  action: "allow" | "deny";
  policyLevel?: "none" | "ip_port" | "domain";
  source: "worker";
}

/**
 * POST a batch of egress proxy decisions to the audit sink
 * (/api/daemon/egress-event, #66 §3.3). Same X-Daemon-Token custody as the
 * sibling endpoints; the run identity comes from the token server-side, so the
 * body carries only the decisions.
 *
 * NEVER throws — audit delivery must not fail (or stall) the run. Both a
 * request error and a non-2xx are logged, not thrown (the postRunFailed rule).
 *
 * Single POST: callers must keep batches ≤ the route's 100-event cap (the
 * workflow batcher flushes at 20, well under it) — an oversize batch would be
 * rejected by the route (rows lost, logged below), never silently truncated.
 */
export async function postEgressEvents(
  opts: WwwClientOpts,
  events: EgressEventWire[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  let res: Response;
  try {
    res = await fetch(endpoint(opts.baseUrl, "/api/daemon/egress-event"), {
      method: "POST",
      headers: headers(opts),
      body: JSON.stringify({ events }),
    });
  } catch (error) {
    console.error("[agent-run] postEgressEvents request failed (swallowed)", {
      threadId: opts.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!res.ok) {
    console.error("[agent-run] postEgressEvents non-2xx (audit rows lost)", {
      threadId: opts.threadId,
      status: res.status,
    });
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
  /**
   * "stopped": www put the thread in `stopping` (a user Stop). The daemon
   * does not observe that status and www cannot reach a remote-plane daemon,
   * so the WORKER must act: tear the daemon down and post the typed
   * `user-cancelled` terminal. Without this the task waited for terminal=true
   * until its step timeout — holding the box/engine slot for 30 minutes
   * (observed in prod 2026-08-25, PR #139 run starving #137/#138).
   */
  outcome: "completed" | "cancelled" | "stopped";
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
    if (poll.status === "stopping") {
      return { outcome: "stopped", finalStatus: poll.status };
    }

    await sleep(pollIntervalMs);
  }
}
