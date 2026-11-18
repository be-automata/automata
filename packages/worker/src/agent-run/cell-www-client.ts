import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import type { CellCreatePlan } from "@terragon/types/cell";

import {
  AUTH_ERROR_CONFIRM_ATTEMPTS,
  AUTH_ERROR_RETRY_MS,
  wwwEndpoint,
  wwwHeaders,
  type WwwClientOpts,
} from "./www-client";

/**
 * The worker's HTTP client for the cell routes (#656 PR-E): `cell-plan` and
 * `cell-teardown`. Same X-Daemon-Token custody as www-client.ts, same ids in the
 * body. NEVER logged: the plan (it carries raw secrets), a response body, the
 * request id. Only `{threadId, code, status, attempt}` are.
 */

/** The longest plan response read (a plan is a few KiB; the cap is a bound). */
const MAX_PLAN_BYTES = 256 * 1024;
const PLAN_TRIES = 3;
const PLAN_REQUEST_TIMEOUT_MS = 30_000;
const PLAN_BACKOFF_MS = [1_000, 2_000] as const;
const TEARDOWN_CALL_TIMEOUT_MS = 10_000;
const MAX_ATTEMPT = 1_000;
const ERROR_CODE = /^[a-z_]{1,40}$/;

export type CellPlanResult =
  | { ok: true; attempt: number; plan: CellCreatePlan }
  /** Refused, final: the code is the route's `error` (or `unknown`). */
  | { ok: false; code: string; status: number }
  | {
      ok: false;
      code: "cell_plan_unavailable" | "cell_plan_superseded";
      status: number;
    };

/** Codes `fetchCellPlan` itself reports: retries exhausted, not a route refusal. */
export const CELL_PLAN_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "cell_plan_unavailable",
  "cell_plan_superseded",
]);

/** A refused plan (AC-2). The message carries the code and status only. */
export class CellPlanRefusedError extends NonRetryableError {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(`cell plan refused: ${code} (HTTP ${status})`);
    this.name = "CellPlanRefusedError";
  }
}

/** The plan could not be fetched in its retry budget (5xx, transport, superseded). */
export class CellPlanUnavailableError extends NonRetryableError {
  constructor(
    public readonly code: "cell_plan_unavailable" | "cell_plan_superseded",
    public readonly status: number,
  ) {
    super(`${code} (HTTP ${status})`);
    this.name = "CellPlanUnavailableError";
  }
}

export interface CellWwwDeps {
  /** Resolves early, and never rejects, when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetch?: typeof fetch;
  /** The run's signal: a cancel ends the wait and the request. */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

/** `setTimeout` that resolves early, and never rejects, when `signal` aborts. */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function codeOf(body: unknown): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const code = (body as { error: unknown }).error;
    if (typeof code === "string" && ERROR_CODE.test(code)) return code;
  }
  return "unknown";
}

/** Reads a response body as JSON under a byte cap; `undefined` when unreadable or over the cap. */
async function readCappedJson(
  res: Response,
  cap: number,
): Promise<unknown | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        // Not awaited: a cancel can wait on a peer branch of a tee'd body.
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function withTimeout(
  timeoutMs: number,
  ...signals: (AbortSignal | undefined)[]
): AbortSignal {
  return AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...signals.filter((s): s is AbortSignal => s !== undefined),
  ]);
}

function validPlan(
  value: unknown,
): { attempt: number; plan: CellCreatePlan } | null {
  if (typeof value !== "object" || value === null) return null;
  const { attempt, plan } = value as { attempt?: unknown; plan?: unknown };
  if (
    typeof attempt !== "number" ||
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    attempt > MAX_ATTEMPT
  ) {
    return null;
  }
  if (typeof plan !== "object" || plan === null) return null;
  const p = plan as { provider?: unknown; tags?: unknown };
  if (p.provider !== "opensandbox") return null;
  if (typeof p.tags !== "object" || p.tags === null) return null;
  const tagAttempt = (p.tags as { attempt?: unknown }).attempt;
  if (typeof tagAttempt !== "string" || Number(tagAttempt) !== attempt) {
    return null;
  }
  return { attempt, plan: plan as CellCreatePlan };
}

/**
 * `POST /api/daemon/cell-plan`. The caller creates `requestId` once per run
 * invocation and reuses it ONLY for an HTTP retry of this fetch, before any
 * create was sent (H1): a transport error, a 5xx, a 503, a 401/403 that is not a
 * route refusal, or a 409 `superseded` (an earlier abandoned request of the same
 * id won the mint, and a replay kills its stray bearer, H2), at most
 * PLAN_TRIES in all. Any other 4xx is a final refusal carrying the route's code.
 */
export async function fetchCellPlan(
  opts: WwwClientOpts,
  body: { worker: string; epoch: string; requestId: string },
  deps: CellWwwDeps = {},
): Promise<CellPlanResult> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? abortableSleep;
  let lastKind: "unavailable" | "superseded" = "unavailable";
  let lastStatus = 0;
  for (let attempt = 1; attempt <= PLAN_TRIES; attempt++) {
    if (deps.signal?.aborted) break;
    let res: Response | undefined;
    try {
      res = await doFetch(wwwEndpoint(opts.baseUrl, "/api/daemon/cell-plan"), {
        method: "POST",
        headers: wwwHeaders(opts),
        body: JSON.stringify({
          threadId: opts.threadId,
          threadChatId: opts.threadChatId,
          worker: body.worker,
          epoch: body.epoch,
          requestId: body.requestId,
        }),
        signal: withTimeout(PLAN_REQUEST_TIMEOUT_MS, deps.signal),
      });
    } catch {
      lastKind = "unavailable";
      lastStatus = 0;
    }
    if (res !== undefined) {
      lastStatus = res.status;
      if (res.ok) {
        const valid = validPlan(await readCappedJson(res, MAX_PLAN_BYTES));
        if (valid === null) {
          return { ok: false, code: "cell_plan_mismatch", status: res.status };
        }
        return { ok: true, ...valid };
      }
      const code = codeOf(await readCappedJson(res, 4096));
      if (res.status === 409 && code === "superseded") {
        lastKind = "superseded";
      } else if (res.status >= 500 || res.status === 408) {
        lastKind = "unavailable";
      } else if (
        res.status === 401 ||
        (res.status === 403 && code === "unknown")
      ) {
        // The daemon token's verification: a blip is a 401 too (see
        // AUTH_ERROR_CONFIRM_ATTEMPTS), so confirm before refusing.
        lastKind = "unavailable";
        if (attempt >= Math.min(PLAN_TRIES, AUTH_ERROR_CONFIRM_ATTEMPTS)) {
          return { ok: false, code, status: res.status };
        }
      } else {
        return { ok: false, code, status: res.status };
      }
    }
    if (attempt < PLAN_TRIES) {
      await sleep(
        PLAN_BACKOFF_MS[attempt - 1] ?? AUTH_ERROR_RETRY_MS,
        deps.signal,
      );
    }
  }
  return {
    ok: false,
    code:
      lastKind === "superseded"
        ? "cell_plan_superseded"
        : "cell_plan_unavailable",
    status: lastStatus,
  };
}

export type FailedStep =
  | "revoke_attempt"
  | "vault"
  | "quarantine"
  | "delete"
  | "survivor";
export type TeardownCallResult = "ok" | "already_reported" | "failed";

export interface TeardownRetry {
  tries: number;
  /** Sleeps between tries; the last entry repeats. */
  backoffMs: readonly number[];
}

const REVOKE_RETRY: TeardownRetry = { tries: 3, backoffMs: [1_000, 2_000] };
const REPORT_RETRY: TeardownRetry = { tries: 2, backoffMs: [1_000] };

/** Drives one teardown call: its own timeout per try, the deadline above them all. */
async function teardownCall(
  opts: WwwClientOpts,
  payload: Record<string, unknown>,
  deadline: AbortSignal,
  retry: TeardownRetry,
  deps: CellWwwDeps,
  /** Called on a 401/403; `priorSent` = an earlier try ended in a transport error or a 5xx, so it may have landed. */
  onUnauthorized?: (priorSent: boolean) => "stop" | "retry",
): Promise<{
  status: "ok" | "unauthorized" | "failed";
  body?: unknown;
  stopped?: boolean;
}> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? abortableSleep;
  let last: "unauthorized" | "failed" = "failed";
  let priorSent = false;
  for (let attempt = 1; attempt <= retry.tries; attempt++) {
    if (deadline.aborted) return { status: "failed" };
    let res: Response | undefined;
    try {
      res = await doFetch(
        wwwEndpoint(opts.baseUrl, "/api/daemon/cell-teardown"),
        {
          method: "POST",
          headers: wwwHeaders(opts),
          body: JSON.stringify({
            threadId: opts.threadId,
            threadChatId: opts.threadChatId,
            ...payload,
          }),
          signal: withTimeout(TEARDOWN_CALL_TIMEOUT_MS, deadline),
        },
      );
    } catch {
      last = "failed";
      priorSent = true;
    }
    if (res !== undefined) {
      if (res.ok) {
        return { status: "ok", body: await readCappedJson(res, 4096) };
      }
      if (res.status === 401 || res.status === 403) {
        last = "unauthorized";
        if (onUnauthorized?.(priorSent) === "stop") {
          return { status: "unauthorized", stopped: true };
        }
      } else if (res.status >= 500 || res.status === 408) {
        last = "failed";
        priorSent = true;
      } else {
        return { status: "failed" }; // any other 4xx is final
      }
    }
    if (attempt < retry.tries) {
      const wait =
        retry.backoffMs[Math.min(attempt - 1, retry.backoffMs.length - 1)] ??
        1_000;
      await sleep(wait, deadline);
    }
  }
  return { status: last };
}

/**
 * `cell-teardown` `revoke` for `attempt`. `ok` = 200 (`revoked` says whether it
 * changed anything: it is a no-op after `finishStep`); `unauthorized` = a
 * 401/403 that survived the retries (the token is gone); `failed` = a 5xx,
 * transport error or timeout after them. Never throws. The route accepts a
 * RETIRED token, so this is also how a worker confirms a retire that committed
 * (Decision 11): pass a longer `retry` for that.
 */
export async function postCellRevoke(
  opts: WwwClientOpts,
  attempt: number,
  deadline: AbortSignal,
  deps: CellWwwDeps & { retry?: TeardownRetry } = {},
): Promise<{ result: TeardownCallResult | "unauthorized"; revoked?: boolean }> {
  const out = await teardownCall(
    opts,
    { action: "revoke", attempt },
    deadline,
    deps.retry ?? REVOKE_RETRY,
    deps,
  );
  if (out.status === "ok") {
    const revoked =
      typeof out.body === "object" &&
      out.body !== null &&
      (out.body as { revoked?: unknown }).revoked === true;
    return { result: "ok", revoked };
  }
  return { result: out.status };
}

/**
 * `cell-teardown` `report`. www deletes a RETIRED token after it, so a retry
 * (or a report after the retire) gets 401: after an earlier send, or when the
 * run is known retired (`retired`), that is `already_reported`. A 401 on the
 * first send of a run that is not known retired is logged as
 * `report_unauthorized` and is `failed`. Never throws.
 */
export async function postCellReport(
  opts: WwwClientOpts,
  attempt: number,
  outcome:
    | { outcome: "clean" }
    | { outcome: "incomplete"; failedSteps: FailedStep[] },
  deadline: AbortSignal,
  flags: { retired: boolean },
  deps: CellWwwDeps = {},
): Promise<TeardownCallResult> {
  const payload: Record<string, unknown> = {
    action: "report",
    attempt,
    outcome: outcome.outcome,
    ...(outcome.outcome === "incomplete"
      ? { failedSteps: outcome.failedSteps }
      : {}),
  };
  const out = await teardownCall(
    opts,
    payload,
    deadline,
    REPORT_RETRY,
    deps,
    (priorSent) => (priorSent || flags.retired ? "stop" : "retry"),
  );
  if (out.status === "ok") return "ok";
  if (out.status === "unauthorized") {
    if (out.stopped) return "already_reported";
    (deps.log ?? console.warn)(
      `cell.report_unauthorized ${JSON.stringify({ threadId: opts.threadId, attempt })}`,
    );
  }
  return "failed";
}
