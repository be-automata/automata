import {
  MAX_PUBLISH_BODY_BYTES,
  parseFailResponse,
  parsePublishResponse,
  parseReconcileContextResponse,
  RECONCILE_PATHS,
  RECONCILE_TOKEN_HEADER,
  type ReconcileContextResponse,
  type ReconcileFailResponse,
  type ReconcilePublishRequest,
  type ReconcilePublishResponse,
  type ReconcileWorkerErrorCode,
} from "@terragon/knowledge/reconcile-wire";

/**
 * The worker's HTTP client for the three internal reconcile endpoints (Phase 13).
 * Authenticated by a dedicated secret header; the worker never touches the
 * database. Every call is bounded and never throws. Logs carry the intent id,
 * attempt, status and error name only: never the secret, the installation token
 * or any response body.
 */

export type ReconcileCallResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "rejected"; status: number }
  | { kind: "unreachable" };

export interface ReconcileClientOptions {
  baseUrl: string;
  /** SECRET, worker-only. Sent in the reconcile token header; never logged. */
  secret: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, fields: Record<string, unknown>) => void;
}

export interface ReconcileClient {
  context(
    intentId: string,
  ): Promise<ReconcileCallResult<ReconcileContextResponse>>;
  publish(
    request: ReconcilePublishRequest,
  ): Promise<ReconcileCallResult<ReconcilePublishResponse>>;
  fail(
    intentId: string,
    code: ReconcileWorkerErrorCode,
  ): Promise<ReconcileCallResult<ReconcileFailResponse>>;
}

const BACKOFF_MS = [2_000, 4_000] as const;
const REQUEST_TIMEOUT_MS = 10_000;

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export function createReconcileClient(
  opts: ReconcileClientOptions,
): ReconcileClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log =
    opts.log ??
    ((message: string, fields: Record<string, unknown>) =>
      console.error(message, fields));
  const base = opts.baseUrl.replace(/\/+$/, "");

  async function post<T>(
    label: string,
    path: string,
    body: string,
    intentId: string,
    parse: (raw: unknown) => T | null,
  ): Promise<ReconcileCallResult<T>> {
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1] ?? 2_000);
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [RECONCILE_TOKEN_HEADER]: opts.secret,
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        log(`[knowledge-reconcile] ${label} request failed`, {
          intentId,
          attempt: attempt + 1,
          error: error instanceof Error ? error.name : "unknown",
        });
        continue;
      }
      if (res.ok) {
        const raw: unknown = await res.json().catch(() => null);
        const value = parse(raw);
        if (value === null) {
          log(`[knowledge-reconcile] ${label} malformed response`, {
            intentId,
            status: res.status,
          });
          return { kind: "rejected", status: res.status };
        }
        return { kind: "ok", value };
      }
      if (!isRetryableStatus(res.status)) {
        log(`[knowledge-reconcile] ${label} rejected`, {
          intentId,
          status: res.status,
        });
        return { kind: "rejected", status: res.status };
      }
      log(`[knowledge-reconcile] ${label} non-2xx`, {
        intentId,
        attempt: attempt + 1,
        status: res.status,
      });
    }
    return { kind: "unreachable" };
  }

  return {
    context: (intentId) =>
      post(
        "context",
        RECONCILE_PATHS.context,
        JSON.stringify({ intentId }),
        intentId,
        parseReconcileContextResponse,
      ),
    publish: async (request) => {
      const body = JSON.stringify(request);
      if (Buffer.byteLength(body, "utf8") > MAX_PUBLISH_BODY_BYTES) {
        log("[knowledge-reconcile] publish body over the cap", {
          intentId: request.intentId,
        });
        return { kind: "rejected", status: 413 };
      }
      return post(
        "publish",
        RECONCILE_PATHS.publish,
        body,
        request.intentId,
        parsePublishResponse,
      );
    },
    fail: (intentId, code) =>
      post(
        "fail",
        RECONCILE_PATHS.fail,
        JSON.stringify({ intentId, code }),
        intentId,
        parseFailResponse,
      ),
  };
}
