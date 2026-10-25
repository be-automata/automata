import { redactSecrets } from "@terragon/utils/redact";

import { TERMINAL_CAUSES, type TerminalCause } from "../../src/agent-run/types";
import { secretHash, secretsEqual, type CanaryThreadSpec } from "./thread-spec";

/**
 * The canary stub of www's daemon endpoints (ADR-013 throwaway box). DEV ONLY.
 *
 * Pure request → response logic with no socket: stub-www.mts wraps it in a
 * node:http server. Each route mirrors the auth contract and the status
 * semantics of its apps/www counterpart, cut down to what a single box needs:
 *
 *   X-Daemon-Token  → the thread it was minted for (401 unknown or revoked)
 *   F2              → body threadId/threadChatId must be the token's (403)
 *   state machine   → queued → working (first daemon-event) → complete |
 *                     error | stopped (result / custom-error / custom-stop,
 *                     or a typed run-terminal)
 *   revoke-on-terminal-READ → the token dies right after thread-status has
 *                     served terminal=true to it (ADR-003 F3), as in www
 *
 * Every request is handed to `record` (the evidence log); secrets never are.
 */

export type CanaryThreadStatus =
  | "queued"
  | "working"
  | "complete"
  | "error"
  | "stopped";

export function isTerminalStatus(status: CanaryThreadStatus): boolean {
  return status === "complete" || status === "error" || status === "stopped";
}

/** One thread: the dispatch-written spec plus the stub's runtime state. */
export interface CanaryThreadEntry {
  spec: CanaryThreadSpec;
  status: CanaryThreadStatus;
  terminalCause?: TerminalCause;
  /** Set once thread-status served terminal=true (revoke-on-terminal-read). */
  revoked: boolean;
  /** Self-heal reports already recorded (first write wins). */
  selfHealReported: Set<string>;
}

/** Where the handler finds threads. `refresh` picks up specs written since. */
export interface CanaryThreadStore {
  refresh(): void;
  byDaemonToken(token: string): CanaryThreadEntry | undefined;
  bySelfHealToken(token: string): CanaryThreadEntry | undefined;
  all(): CanaryThreadEntry[];
}

/** A store over a spec source; runtime state survives refreshes. */
export function createThreadStore(
  loadSpecs: () => CanaryThreadSpec[],
): CanaryThreadStore {
  const byThreadId = new Map<string, CanaryThreadEntry>();
  const byTokenHash = new Map<string, CanaryThreadEntry>();
  const bySelfHealHash = new Map<string, CanaryThreadEntry>();
  const store: CanaryThreadStore = {
    refresh() {
      for (const spec of loadSpecs()) {
        const existing = byThreadId.get(spec.threadId);
        if (existing) {
          // Only the post-trigger stamp may change; a re-minted token would
          // be a different run, which the canary never does.
          if (secretsEqual(existing.spec.daemonToken, spec.daemonToken)) {
            existing.spec = spec;
          }
          continue;
        }
        const entry: CanaryThreadEntry = {
          spec,
          status: "queued",
          revoked: false,
          selfHealReported: new Set(),
        };
        byThreadId.set(spec.threadId, entry);
        byTokenHash.set(secretHash(spec.daemonToken), entry);
        if (spec.selfHealToken) {
          bySelfHealHash.set(secretHash(spec.selfHealToken), entry);
        }
      }
    },
    byDaemonToken(token) {
      return byTokenHash.get(secretHash(token));
    },
    bySelfHealToken(token) {
      return bySelfHealHash.get(secretHash(token));
    },
    all() {
      return [...byThreadId.values()];
    },
  };
  return store;
}

export interface StubRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  body: string;
}

export interface StubResponse {
  status: number;
  json?: unknown;
  text?: string;
}

export interface StubDeps {
  store: CanaryThreadStore;
  /**
   * The owner credential: an Anthropic API key, or a `claude setup-token`
   * subscription token (`sk-ant-oat…`). SECRET.
   */
  readAnthropicKey: () => string;
  /** The evidence sink: one call per request (and one per agent result). */
  record: (entry: Record<string, unknown>) => void;
  now?: () => Date;
}

/** A `claude setup-token` subscription token, as opposed to an API key. */
export function isSetupToken(key: string): boolean {
  return key.startsWith("sk-ant-oat");
}

/**
 * The claudeAiOauth shape www emits for a setup-token credential: no refresh
 * token (the CLI must never refresh) and a far-future expiry.
 */
export function setupTokenCredentials(accessToken: string, at: Date) {
  return {
    claudeAiOauth: {
      accessToken,
      refreshToken: "",
      expiresAt: at.getTime() + 365 * 24 * 60 * 60 * 1000,
      scopes: ["user:inference"],
      subscriptionType: null,
    },
  };
}

/** The marker GET /__canary/health answers; dispatch refuses a callback URL without it. */
export const CANARY_HEALTH_PATH = "/__canary/health";
export const CANARY_HEALTH_MARKER = "automata-canary-stub-www";

type AuthResult =
  | { ok: true; entry: CanaryThreadEntry }
  | { ok: false; status: 401; reason: "missing" | "unknown" | "revoked" };

/** X-Daemon-Token → its thread. Revoked and unknown tokens are both 401, as in www. */
export function authenticateDaemonToken(
  store: CanaryThreadStore,
  token: string | undefined,
): AuthResult {
  if (!token) return { ok: false, status: 401, reason: "missing" };
  store.refresh();
  const entry = store.byDaemonToken(token);
  if (!entry) return { ok: false, status: 401, reason: "unknown" };
  if (entry.revoked) return { ok: false, status: 401, reason: "revoked" };
  return { ok: true, entry };
}

/**
 * F2: the token is bound to ONE thread + threadChat. Undefined = allowed;
 * otherwise the status to refuse with (400 for a missing id, 403 for a
 * foreign one), exactly as the www routes answer.
 */
export function checkThreadBinding(
  entry: CanaryThreadEntry,
  body: { threadId?: unknown; threadChatId?: unknown },
): 400 | 403 | undefined {
  if (
    typeof body.threadId !== "string" ||
    typeof body.threadChatId !== "string" ||
    body.threadId === "" ||
    body.threadChatId === ""
  ) {
    return 400;
  }
  if (
    body.threadChatId !== entry.spec.threadChatId ||
    body.threadId !== entry.spec.threadId
  ) {
    return 403;
  }
  return undefined;
}

/**
 * The thread status after one daemon-event batch — www's handleDaemonEvent
 * reduced to its status outcome: custom-stop ⇒ stopped, custom-error or an
 * error result ⇒ error, a result ⇒ complete, anything else ⇒ working.
 * A terminal thread never moves again.
 */
export function nextStatusForEvent(
  current: CanaryThreadStatus,
  messages: ReadonlyArray<{ type?: unknown; is_error?: unknown }>,
): CanaryThreadStatus {
  if (isTerminalStatus(current)) return current;
  let isStop = false;
  let isDone = false;
  let isError = false;
  for (const m of messages) {
    if (m.type === "custom-stop") isStop = true;
    if (m.type === "custom-error") isError = true;
    if (m.type === "result") {
      isDone = true;
      if (m.is_error === true) isError = true;
    }
  }
  if (isStop) return "stopped";
  if (isError) return "error";
  if (isDone) return "complete";
  return "working";
}

/**
 * Generation fence (#125 C1), reduced: a caller that names a run other than
 * the thread's stamped one is refused. No stamp, or no header ⇒ fails open.
 */
export function generationRefused(
  entry: CanaryThreadEntry,
  runExternalId: string | null | undefined,
): boolean {
  const active = entry.spec.activeRunExternalId;
  return Boolean(active && runExternalId && runExternalId !== active);
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(body);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A redactor that also blanks every secret the stub knows about. */
export function makeScrubber(
  secrets: () => string[],
): (text: string) => string {
  return (text) => {
    let out = text;
    const values = secrets()
      .filter((v) => v.length >= 8)
      .sort((a, b) => b.length - a.length);
    for (const v of values) out = out.split(v).join("<redacted>");
    return redactSecrets(out);
  };
}

const json = (status: number, body: unknown): StubResponse => ({
  status,
  json: body,
});

/** The handler. Never throws: an unexpected error is a recorded 500. */
export function createStubHandler(
  deps: StubDeps,
): (req: StubRequest) => StubResponse {
  const now = deps.now ?? (() => new Date());

  const daemonRoute = (
    req: StubRequest,
    route: string,
    fn: (
      entry: CanaryThreadEntry,
      body: Record<string, unknown>,
      note: Record<string, unknown>,
    ) => StubResponse,
    opts: { binding: boolean } = { binding: true },
  ): StubResponse => {
    const note: Record<string, unknown> = { route };
    const auth = authenticateDaemonToken(
      deps.store,
      req.headers["x-daemon-token"],
    );
    if (!auth.ok) {
      note.auth = auth.reason;
      deps.record({ ...note, status: 401 });
      return json(401, { error: "Unauthorized" });
    }
    const { entry } = auth;
    note.auth = "ok";
    note.threadId = entry.spec.threadId;
    note.lane = entry.spec.lane;
    const body = parseJson(req.body);
    if (!body) {
      deps.record({ ...note, status: 400 });
      return json(400, { error: "Invalid body" });
    }
    if (opts.binding) {
      const refused = checkThreadBinding(entry, body);
      if (refused) {
        deps.record({ ...note, status: refused, refused: "binding" });
        return json(refused, {
          error:
            refused === 400 ? "Missing threadId or threadChatId" : "Forbidden",
        });
      }
    }
    const res = fn(entry, body, note);
    deps.record({ ...note, status: res.status });
    return res;
  };

  const routes: Record<string, (req: StubRequest) => StubResponse> = {
    "/api/daemon/next-message": (req) =>
      daemonRoute(req, "next-message", (entry) => {
        // www answers 204 when there is no pending user message; a finished
        // canary thread has none.
        if (isTerminalStatus(entry.status)) return { status: 204 };
        return json(200, entry.spec.message);
      }),

    "/api/daemon/agent-credentials": (req) =>
      daemonRoute(req, "agent-credentials", (_entry, _body, note) => {
        // www's getAndVerifyCredentials for a claudeCode credential: a
        // `json-file` (apps/www/src/agent/msg/claudeCredentials.ts). H2: never
        // recorded.
        const key = deps.readAnthropicKey();
        const setupToken = isSetupToken(key);
        note.credential = setupToken
          ? "json-file(claudeAiOauth setup-token)"
          : "json-file(anthropicApiKey)";
        return json(200, {
          agent: "claudeCode",
          credentials: {
            type: "json-file",
            contents: JSON.stringify(
              setupToken
                ? setupTokenCredentials(key, now())
                : { anthropicApiKey: key },
            ),
          },
        });
      }),

    "/api/daemon-event": (req) =>
      daemonRoute(req, "daemon-event", (entry, body, note) => {
        if (generationRefused(entry, req.headers["x-run-external-id"])) {
          note.refused = "generation";
          return { status: 409, text: "superseded" };
        }
        const messages = Array.isArray(body.messages)
          ? (body.messages as Array<Record<string, unknown>>)
          : [];
        const before = entry.status;
        entry.status = nextStatusForEvent(entry.status, messages);
        note.transition = `${before}->${entry.status}`;
        note.messageTypes = messages.map((m) => m.type);
        // Evidence: the agent's own output, which is what the canary is for.
        note.messages = messages;
        for (const m of messages) {
          if (m.type === "result" || m.type === "custom-error") {
            deps.record({
              kind: "agent-result",
              threadId: entry.spec.threadId,
              lane: entry.spec.lane,
              type: m.type,
              subtype: m.subtype,
              is_error: m.is_error,
              result: m.result ?? m.error ?? m.error_info,
            });
          }
        }
        return { status: 200, text: "OK" };
      }),

    "/api/daemon/thread-status": (req) =>
      daemonRoute(req, "thread-status", (entry, _body, note) => {
        const terminal = isTerminalStatus(entry.status);
        if (terminal) {
          // ADR-003 F3: revoked only AFTER terminal=true has been served.
          entry.revoked = true;
          note.revokedAfterRead = true;
        }
        note.threadStatus = entry.status;
        return json(200, { status: entry.status, terminal });
      }),

    "/api/daemon/run-terminal": (req) =>
      daemonRoute(req, "run-terminal", (entry, body, note) => {
        const cause = body.cause;
        if (
          typeof body.runExternalId !== "string" ||
          body.runExternalId === "" ||
          typeof cause !== "string" ||
          !(TERMINAL_CAUSES as readonly string[]).includes(cause)
        ) {
          return json(400, { error: "Invalid body" });
        }
        note.cause = cause;
        note.detail = body.detail;
        if (generationRefused(entry, body.runExternalId)) {
          note.refused = "generation";
          return json(409, {
            error: "superseded",
            activeRunExternalId: entry.spec.activeRunExternalId,
          });
        }
        // markThreadTerminal: status `complete` + the typed cause, applied
        // only from a non-terminal status (idempotent).
        if (isTerminalStatus(entry.status)) {
          return json(200, { applied: false });
        }
        entry.status = "complete";
        entry.terminalCause = cause as TerminalCause;
        return json(200, { applied: true });
      }),

    "/api/daemon/run-staleness": (req) =>
      daemonRoute(req, "run-staleness", (entry) => {
        // hasNewerRun: a later dispatch for the same PR key.
        const mine = Date.parse(entry.spec.createdAt);
        const stale =
          entry.spec.prKey !== undefined &&
          deps.store
            .all()
            .some(
              (o) =>
                o !== entry &&
                o.spec.prKey === entry.spec.prKey &&
                Date.parse(o.spec.createdAt) > mine,
            );
        return json(200, { stale });
      }),

    "/api/daemon/egress-event": (req) =>
      // Body is { events } only: the run identity comes from the token.
      daemonRoute(
        req,
        "egress-event",
        (_entry, body, note) => {
          const events = body.events;
          if (
            !Array.isArray(events) ||
            events.length === 0 ||
            events.length > 100
          ) {
            return json(400, { error: "Invalid body" });
          }
          note.events = events;
          return json(200, { inserted: events.length });
        },
        { binding: false },
      ),

    "/api/daemon/run-credential-source": (req) =>
      daemonRoute(req, "run-credential-source", (entry, body, note) => {
        if (
          body.source !== "user-credential" &&
          body.source !== "built-in-credits" &&
          body.source !== "box-key"
        ) {
          return json(400, { error: "Invalid body" });
        }
        if (generationRefused(entry, req.headers["x-run-external-id"])) {
          note.refused = "generation";
          return json(409, { error: "superseded" });
        }
        note.source = body.source;
        return json(200, { recorded: true });
      }),

    "/api/self-heal/audit-checks": (req) =>
      selfHealRoute(req, "audit-checks", "x-self-heal-check-token"),
    "/api/self-heal/fix-check": (req) =>
      selfHealRoute(req, "fix-check", "x-self-heal-gate-token"),
  };

  const selfHealRoute = (
    req: StubRequest,
    route: "audit-checks" | "fix-check",
    header: string,
  ): StubResponse => {
    const token = req.headers[header];
    deps.store.refresh();
    const entry = token ? deps.store.bySelfHealToken(token) : undefined;
    if (!entry) {
      deps.record({ route, status: 401, auth: token ? "unknown" : "missing" });
      return json(401, { error: "Unauthorized" });
    }
    const body = parseJson(req.body);
    if (!body) {
      deps.record({ route, status: 400, threadId: entry.spec.threadId });
      return json(400, { error: "Invalid body" });
    }
    // First write wins; a retry with the same token is a duplicate.
    const recorded = !entry.selfHealReported.has(route);
    entry.selfHealReported.add(route);
    deps.record({
      route,
      status: 200,
      threadId: entry.spec.threadId,
      recorded,
      report: body,
    });
    return json(200, { recorded });
  };

  return (req) => {
    try {
      if (req.method === "GET" && req.path === CANARY_HEALTH_PATH) {
        return json(200, {
          canary: CANARY_HEALTH_MARKER,
          at: now().toISOString(),
        });
      }
      if (req.path.startsWith("/api/proxy/")) {
        // Only the credits path routes model traffic through www's proxy
        // (ANTHROPIC_BASE_URL=<callback>/api/proxy/anthropic, set by the daemon
        // when useCredits). The canary delivers an owner credential, so with
        // WORKER_BOX_TRUST=owner this is never called; reaching it means the
        // worker forced credits — a configuration error, made loud here.
        deps.record({ route: "proxy", path: req.path, status: 501 });
        return json(501, {
          error:
            "canary stub has no model proxy: run the worker with WORKER_BOX_TRUST=owner",
        });
      }
      const route = routes[req.path];
      if (!route) {
        deps.record({ route: "unknown", path: req.path, status: 404 });
        return json(404, { error: "Not found" });
      }
      if (req.method !== "POST") {
        deps.record({ route: req.path, method: req.method, status: 405 });
        return json(405, { error: "Method not allowed" });
      }
      return route(req);
    } catch (err) {
      deps.record({
        route: req.path,
        status: 500,
        error: err instanceof Error ? err.message : String(err),
      });
      return json(500, { error: "Internal error" });
    }
  };
}
