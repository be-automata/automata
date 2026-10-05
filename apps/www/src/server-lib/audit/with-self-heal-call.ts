import type { DB } from "@terragon/shared/db";
import * as breakerModel from "@terragon/shared/model/self-heal-breaker";
import type {
  BreakerEventOutcome,
  BreakerRow,
  PermissionName,
} from "@terragon/shared/model/self-heal-breaker";
import { redactSecrets } from "@terragon/utils/redact";

/**
 * The one call policy for every self-heal GitHub request (OCTO-01, TMO-01,
 * BRK-01, OUTBOX-01): timeout, classification (RESILIENCE 3.1), breaker
 * consult and record, rate-limit horizon, permission latch and primary-quota
 * reserve. The wrapper never throws; it returns a result the caller branches on.
 */

export type CallKind = "read" | "write" | "create" | "preflight";

export const SELF_HEAL_CALL_TIMEOUTS: Record<CallKind, number> = {
  read: 8_000,
  write: 8_000,
  create: 10_000,
  preflight: 5_000,
};

const MIN_DEADLINE_LEFT_MS = 1_000;
const RETRY_MIN_BUDGET_MS = 5_000;
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
const MIN_RATE_LIMIT_HORIZON_S = 60;
const RESERVE_FRACTION = 0.2;

export type SelfHealCallOutcome =
  | "breaker_open"
  | "rate_limited"
  | "deadline"
  | "timeout"
  | "server_error"
  | "permission"
  | "not_found"
  | "unprocessable"
  | "primary_quota_reserve"
  | "other";

export type SelfHealCallResult<T> =
  | { ok: true; data: T; status: number; reserveHit?: boolean }
  | {
      ok: false;
      outcome: SelfHealCallOutcome;
      status?: number;
      retryAfterS?: number;
    };

/** The slice of an Octokit response the wrapper reads. */
export interface GithubResponse<T> {
  data: T;
  status: number;
  headers: Record<string, string | number | undefined>;
}

/** Per-execution state shared by every call of one execution. */
export interface SelfHealExecutionState {
  /** Set once x-ratelimit-remaining fell below 20%; later calls make no HTTP. */
  reserveHit: boolean;
}

export type SelfHealBreakerOps = Pick<
  typeof breakerModel,
  | "getBreakerState"
  | "recordBreakerEvent"
  | "evaluateApiBreaker"
  | "extendRateLimitedUntil"
  | "setPermissionLatch"
  | "acquireHalfOpenProbe"
>;

export interface SelfHealCallDeps {
  db: DB;
  now: () => Date;
  log: (message: string, fields: Record<string, unknown>) => void;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
  breaker?: SelfHealBreakerOps;
  execution?: SelfHealExecutionState;
}

export type GithubClassification =
  | { kind: "success" }
  | { kind: "timeout" }
  | { kind: "server_error"; status?: number }
  | { kind: "rate_limited"; status: number; retryAfterS: number }
  | { kind: "permission"; status: number }
  | { kind: "not_found" }
  | { kind: "unprocessable" }
  | { kind: "other"; status: number };

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  response?: { headers?: Record<string, unknown> };
}

function headerNumber(
  headers: Record<string, unknown> | undefined,
  name: string,
): number | undefined {
  const raw = headers?.[name];
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function errorMessage(error: unknown): string {
  const message = (error as ErrorLike | null)?.message;
  return typeof message === "string" ? message : "";
}

/**
 * RESILIENCE 3.1. `error` is what the call rejected with (an Octokit
 * RequestError carries `status` and `response.headers`; an abort carries no
 * status). A successful response is classified by the caller as success.
 */
export function classifyGithubOutcome(
  error: unknown,
  nowMs: number = Date.now(),
): GithubClassification {
  const e = (error ?? {}) as ErrorLike;
  const status = typeof e.status === "number" ? e.status : undefined;
  if (e.name === "AbortError" || e.name === "TimeoutError") {
    return { kind: "timeout" };
  }
  if (status === undefined || status >= 500) {
    return { kind: "server_error", status };
  }
  const headers = e.response?.headers;
  if (status === 403 || status === 429) {
    const remaining = headerNumber(headers, "x-ratelimit-remaining");
    const rateLimited =
      status === 429 ||
      /rate limit|abuse/i.test(errorMessage(error)) ||
      remaining === 0;
    if (rateLimited) {
      const retryAfter = headerNumber(headers, "retry-after");
      const reset = headerNumber(headers, "x-ratelimit-reset");
      const untilReset =
        reset !== undefined ? Math.ceil(reset - nowMs / 1000) : undefined;
      return {
        kind: "rate_limited",
        status,
        retryAfterS: Math.max(retryAfter ?? untilReset ?? 0, 0),
      };
    }
    return { kind: "permission", status };
  }
  if (status === 404) return { kind: "not_found" };
  if (status === 422) return { kind: "unprocessable" };
  return { kind: "other", status };
}

function breakerScopeFor(kind: CallKind): "github_write" | "github_read" {
  return kind === "write" || kind === "create" ? "github_write" : "github_read";
}

interface EventSpec {
  outcome: BreakerEventOutcome;
  signal: string;
}

function eventFor(
  classification: GithubClassification,
  signalName: string,
  kind: CallKind,
): EventSpec {
  switch (classification.kind) {
    case "success":
      // Creates are recorded as ignored under their own signal so the hourly
      // create budget counts them without skewing the failure ratio (08-03).
      return kind === "create"
        ? { outcome: "ignored", signal: signalName }
        : { outcome: "success", signal: signalName };
    case "timeout":
      return { outcome: "timeout", signal: "gh_timeout" };
    case "server_error":
      return {
        outcome: "failure",
        signal: classification.status === undefined ? "gh_network" : "gh_5xx",
      };
    case "rate_limited":
      return { outcome: "ignored", signal: "gh_rate_limited" };
    case "permission":
      return { outcome: "ignored", signal: "gh_403" };
    case "not_found":
      return { outcome: "ignored", signal: "gh_404" };
    case "unprocessable":
      return { outcome: "ignored", signal: "gh_422" };
    case "other":
      return { outcome: "ignored", signal: `gh_${classification.status}` };
  }
}

function safeError(error: unknown): string {
  return redactSecrets(errorMessage(error) || String(error));
}

class CallAborted extends Error {
  constructor(readonly cause: "timeout" | "deadline") {
    super(`self-heal call aborted: ${cause}`);
    this.name = "AbortError";
  }
}

interface Attempt<T> {
  response?: GithubResponse<T>;
  error?: unknown;
  latencyMs: number;
  deadlineCut: boolean;
}

async function attemptCall<T>(
  call: (signal: AbortSignal) => Promise<GithubResponse<T>>,
  timeoutMs: number,
  deadlineLeftMs: number,
  now: () => Date,
): Promise<Attempt<T>> {
  const startedAt = now().getTime();
  const deadlineCut = deadlineLeftMs < timeoutMs;
  const timeoutCtl = new AbortController();
  const deadlineCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
  const deadlineTimer = setTimeout(
    () => deadlineCtl.abort(),
    Math.max(deadlineLeftMs, 1),
  );
  const signal = AbortSignal.any([timeoutCtl.signal, deadlineCtl.signal]);
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () =>
      reject(
        new CallAborted(
          deadlineCtl.signal.aborted && deadlineCut ? "deadline" : "timeout",
        ),
      );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const response = await Promise.race([call(signal), aborted]);
    return { response, latencyMs: now().getTime() - startedAt, deadlineCut };
  } catch (error: unknown) {
    return { error, latencyMs: now().getTime() - startedAt, deadlineCut };
  } finally {
    clearTimeout(timer);
    clearTimeout(deadlineTimer);
  }
}

function breakerBlocksCall(
  row: BreakerRow,
  now: Date,
): "open" | "half_open" | null {
  if (row.state === "paused_manual") return "open";
  if (row.state === "open") {
    return row.openUntil && row.openUntil.getTime() <= now.getTime()
      ? "half_open"
      : "open";
  }
  if (row.state === "half_open") return "half_open";
  return null;
}

export async function withSelfHealCall<T>({
  kind,
  organizationId,
  installationKey,
  signalName,
  permission = "issues",
  deadlineAt,
  call,
  deps,
  loopFixScopeKey,
}: {
  kind: CallKind;
  organizationId: string;
  installationKey: string;
  signalName: string;
  /** The installation permission this call needs; latched on a permission 403. */
  permission?: PermissionName;
  deadlineAt: Date;
  call: (signal: AbortSignal) => Promise<GithubResponse<T>>;
  deps: SelfHealCallDeps;
  /**
   * The repo (normalized) of a fix-lane write whose 403 / 422 is a real
   * failure. Such a response is also recorded on that repo's loop_fix
   * breaker (the 09-13 gh_403 / gh_422 rule); leave unset where a 422 is
   * an expected end state (a branch already deleted).
   */
  loopFixScopeKey?: string;
}): Promise<SelfHealCallResult<T>> {
  const { db, now, log, sleep, rand } = deps;
  const breaker = deps.breaker ?? breakerModel;
  const scopeKind = breakerScopeFor(kind);
  const deadlineLeft = () => deadlineAt.getTime() - now().getTime();

  try {
    if (deadlineLeft() < MIN_DEADLINE_LEFT_MS) {
      return { ok: false, outcome: "deadline" };
    }
    if (deps.execution?.reserveHit) {
      return { ok: false, outcome: "primary_quota_reserve" };
    }

    // Consult the breaker and the Retry-After horizon before any HTTP.
    // The Retry-After horizon lives on the github_write row and gates every
    // kind: reads share the installation quota.
    const writeRow = await breaker.getBreakerState({
      db,
      organizationId,
      scopeKind: "github_write",
      scopeKey: installationKey,
    });
    if (
      writeRow.rateLimitedUntil &&
      writeRow.rateLimitedUntil.getTime() > now().getTime()
    ) {
      return {
        ok: false,
        outcome: "rate_limited",
        retryAfterS: Math.ceil(
          (writeRow.rateLimitedUntil.getTime() - now().getTime()) / 1000,
        ),
      };
    }
    const row =
      scopeKind === "github_write"
        ? writeRow
        : await breaker.getBreakerState({
            db,
            organizationId,
            scopeKind,
            scopeKey: installationKey,
          });
    const blocked = breakerBlocksCall(row, now());
    if (blocked === "open") return { ok: false, outcome: "breaker_open" };
    if (blocked === "half_open") {
      if (row.state === "open") {
        await breaker.evaluateApiBreaker({
          db,
          organizationId,
          scopeKind,
          scopeKey: installationKey,
          now: now(),
          logger: log,
        });
      }
      const probe = await breaker.acquireHalfOpenProbe({
        db,
        organizationId,
        scopeKind,
        scopeKey: installationKey,
        now: now(),
      });
      if (!probe) return { ok: false, outcome: "breaker_open" };
    }

    const retriesAllowed = kind === "read" || kind === "write";
    const timeoutMs = SELF_HEAL_CALL_TIMEOUTS[kind];

    for (let attempt = 0; ; attempt++) {
      const left = deadlineLeft();
      if (left < MIN_DEADLINE_LEFT_MS)
        return { ok: false, outcome: "deadline" };
      const result = await attemptCall(call, timeoutMs, left, now);

      if (result.response) {
        const { response } = result;
        await breaker.recordBreakerEvent({
          db,
          organizationId,
          scopeKind,
          scopeKey: installationKey,
          ...eventFor({ kind: "success" }, signalName, kind),
          latencyMs: result.latencyMs,
          now: now(),
        });
        await breaker.evaluateApiBreaker({
          db,
          organizationId,
          scopeKind,
          scopeKey: installationKey,
          now: now(),
          logger: log,
        });
        const remaining = headerNumber(
          response.headers,
          "x-ratelimit-remaining",
        );
        const limit = headerNumber(response.headers, "x-ratelimit-limit");
        const reserveHit =
          remaining !== undefined &&
          limit !== undefined &&
          limit > 0 &&
          remaining < limit * RESERVE_FRACTION;
        if (reserveHit) {
          if (deps.execution) deps.execution.reserveHit = true;
          log("[self-heal:github] primary_quota_reserve", {
            installationKey,
            remaining,
            limit,
          });
        }
        return {
          ok: true,
          data: response.data,
          status: response.status,
          ...(reserveHit ? { reserveHit: true } : {}),
        };
      }

      if (
        result.error instanceof CallAborted &&
        result.error.cause === "deadline"
      ) {
        return { ok: false, outcome: "deadline" };
      }

      const classification = classifyGithubOutcome(
        result.error,
        now().getTime(),
      );
      await breaker.recordBreakerEvent({
        db,
        organizationId,
        scopeKind,
        scopeKey: installationKey,
        ...eventFor(classification, signalName, kind),
        latencyMs: result.latencyMs,
        now: now(),
      });
      const transition = await breaker.evaluateApiBreaker({
        db,
        organizationId,
        scopeKind,
        scopeKey: installationKey,
        now: now(),
        logger: log,
      });
      if (
        loopFixScopeKey !== undefined &&
        (kind === "write" || kind === "create") &&
        (classification.kind === "permission" ||
          classification.kind === "unprocessable")
      ) {
        await breaker.recordBreakerEvent({
          db,
          organizationId,
          scopeKind: "loop_fix",
          scopeKey: loopFixScopeKey,
          outcome: "failure",
          signal: classification.kind === "permission" ? "gh_403" : "gh_422",
          now: now(),
        });
      }

      switch (classification.kind) {
        case "rate_limited": {
          const horizonS =
            Math.max(classification.retryAfterS, MIN_RATE_LIMIT_HORIZON_S) *
            (1 + rand() * 0.3);
          const until = new Date(now().getTime() + horizonS * 1000);
          await breaker.extendRateLimitedUntil({
            db,
            organizationId,
            installationKey,
            until,
          });
          log("[self-heal:github] rate_limited", {
            installationKey,
            retry_after_s: Math.ceil(horizonS),
            rate_limited_until: until.toISOString(),
          });
          return {
            ok: false,
            outcome: "rate_limited",
            status: classification.status,
            retryAfterS: Math.ceil(horizonS),
          };
        }
        case "permission":
          await breaker.setPermissionLatch({
            db,
            organizationId,
            installationId: installationKey,
            permission,
            reason: "gh_403",
            now: now(),
          });
          return { ok: false, outcome: "permission", status: 403 };
        case "not_found":
          return { ok: false, outcome: "not_found", status: 404 };
        case "unprocessable":
          return { ok: false, outcome: "unprocessable", status: 422 };
        case "other":
          return { ok: false, outcome: "other", status: classification.status };
        case "timeout":
        case "server_error": {
          const tripped = transition !== null && transition.to === "open";
          if (retriesAllowed && attempt < MAX_RETRIES && !tripped) {
            const backoffMs = rand() * BACKOFF_BASE_MS * 2 ** attempt;
            if (deadlineLeft() - backoffMs >= RETRY_MIN_BUDGET_MS) {
              await sleep(backoffMs);
              continue;
            }
          }
          log("[self-heal:github] call_failed", {
            signalName,
            kind,
            outcome: classification.kind,
            error: safeError(result.error),
          });
          return classification.kind === "timeout"
            ? { ok: false, outcome: "timeout" }
            : {
                ok: false,
                outcome: "server_error",
                ...(classification.status !== undefined
                  ? { status: classification.status }
                  : {}),
              };
        }
      }
    }
  } catch (error: unknown) {
    // Breaker storage failure: fail closed for the call, never throw to the caller.
    log("[self-heal:github] wrapper_error", {
      signalName,
      kind,
      error: safeError(error),
    });
    return { ok: false, outcome: "other" };
  }
}
