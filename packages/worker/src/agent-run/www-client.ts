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
}

function endpoint(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${pathname}`;
}

function headers(daemonToken: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-daemon-token": daemonToken,
  };
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
    headers: headers(opts.daemonToken),
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
    throw new Error(
      `next-message failed: HTTP ${res.status} (${res.statusText})`,
    );
  }
  return (await res.json()) as PulledDaemonMessage;
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
    headers: headers(opts.daemonToken),
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
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - elapsed)));
    elapsed += step;
  }
}

/**
 * Poll thread-status until terminal, applying the revoke-race ruling (ADR-003):
 * handleThreadFinish revokes the daemon token AT terminal, so a poll may get
 * 401/403 before it ever observes {terminal:true}. A 401/403 AFTER at least one
 * successful poll IS the terminal signal (the token's revocation == completion) —
 * logged as 'terminal-inferred-from-revocation'. A 401/403 on the FIRST poll is a
 * real auth error and throws (the step fails loudly). A Hatchet cancellation
 * (ctx.cancelled / aborted signal) ends the loop PROMPTLY with outcome 'cancelled'
 * so the caller can tear the daemon down — no orphan survives a cancelled run.
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
      if (hadSuccessfulPoll) {
        ctx.log("terminal-inferred-from-revocation");
        return { outcome: "completed", finalStatus: lastStatus };
      }
      throw new Error(
        `thread-status auth error on first poll: HTTP ${poll.httpStatus} — daemon token invalid`,
      );
    }

    hadSuccessfulPoll = true;
    lastStatus = poll.status;
    if (poll.terminal) {
      return { outcome: "completed", finalStatus: poll.status };
    }

    await sleep(pollIntervalMs);
  }
}
