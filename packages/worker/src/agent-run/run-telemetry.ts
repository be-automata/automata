/**
 * Run telemetry (spike 032): every run container exports Claude Code's native
 * OpenTelemetry to a collector on the box, and the daemon may stop a run whose
 * tool calls keep failing (#546). Both are box settings the worker owns; the
 * agent never chooses where its telemetry goes.
 *
 * Why the shape is what it is (each point measured in the spike):
 *   - The OTel config goes into the run's user-level settings `env`, not the
 *     process env: a settings `env` block beats the process environment, so
 *     an env-only config is silently overridden by any settings file.
 *   - Prompts and tool details are pinned OFF: with them off no prompt text,
 *     file content or command argument leaves the run (`<REDACTED>`).
 *   - Account identity (`user.email` and friends) is exported anyway; the box
 *     collector deletes it before storage (deploy/linux/otel-collector.yaml).
 *   - Short-lived `claude -p` processes flush at exit, so `docker run --rm`
 *     loses nothing; the intervals below keep the tail small.
 *
 * The container reaches the collector through a socket bridge like the egress
 * proxy (`--network none`), at `http://127.0.0.1:${RUN_TELEMETRY_BRIDGE_PORT}`.
 */

/** The in-container loopback port the entry bridges `otel-collector.sock` to. */
export const RUN_TELEMETRY_BRIDGE_PORT = 4318;

/** The daemon env key that switches the tool-failure streak to enforce mode (#546). */
export const TOOL_FAILURE_STREAK_LIMIT_KEY = "TOOL_FAILURE_STREAK_LIMIT";

export interface RunTelemetryConfig {
  /** The box collector's OTLP/HTTP base URL on the host (loopback), or null when off. */
  otlpUrl: string | null;
  /** Consecutive failed tool calls that stop a run; 0 = observe only. */
  toolFailureStreakLimit: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * `WORKER_RUN_OTLP_URL`: unset = telemetry off. Only a plain-HTTP loopback
 * URL with a port and no credentials, path, query or fragment: the collector
 * runs on the box, and nothing secret ever rides in this value.
 */
export function parseRunOtlpUrl(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error(`WORKER_RUN_OTLP_URL is not a URL: ${JSON.stringify(v)}`);
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `WORKER_RUN_OTLP_URL must be http://127.0.0.1:<port> (the box collector, loopback, no credentials or path), got ${JSON.stringify(v)}`,
    );
  }
  return `http://${url.hostname}:${url.port}`;
}

/** `WORKER_TOOL_FAILURE_STREAK_LIMIT`: unset or 0 = observe only; else an integer in [3, 100]. */
export function parseToolFailureStreakLimit(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  if (!v || v === "0") {
    return 0;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 3 || n > 100) {
    throw new Error(
      `WORKER_TOOL_FAILURE_STREAK_LIMIT must be 0 (observe only) or an integer from 3 to 100, got ${JSON.stringify(v)}`,
    );
  }
  return n;
}

export function parseRunTelemetryConfig(
  env: NodeJS.ProcessEnv,
): RunTelemetryConfig {
  return {
    otlpUrl: parseRunOtlpUrl(env.WORKER_RUN_OTLP_URL),
    toolFailureStreakLimit: parseToolFailureStreakLimit(
      env.WORKER_TOOL_FAILURE_STREAK_LIMIT,
    ),
  };
}

export interface RunTelemetryIdentity {
  lane: string;
  orgId: string;
  threadId: string;
  threadChatId: string;
}

/**
 * The placeholder threadChatId every review (and pre-chat thread) carries
 * (`LEGACY_THREAD_CHAT_ID` in @terragon/shared, which the worker does not
 * depend on). It names no run, so the run id falls back to the thread id.
 */
const LEGACY_THREAD_CHAT_ID = "legacy-thread-chat-id";

/** The id that names one run in telemetry: the chat, or the thread when the chat is the shared placeholder. */
export function telemetryRunId(identity: RunTelemetryIdentity): string {
  return identity.threadChatId &&
    identity.threadChatId !== LEGACY_THREAD_CHAT_ID
    ? identity.threadChatId
    : identity.threadId;
}

/** OTEL_RESOURCE_ATTRIBUTES values are percent-encoded (`,` and `=` are separators). */
function resourceValue(value: string): string {
  return encodeURIComponent(value);
}

/**
 * The `env` block of the run's user-level Claude settings. Prompts and tool
 * details are pinned off here, after everything else, so no other layer can
 * turn them on for a run.
 */
export function runTelemetrySettingsEnv(
  identity: RunTelemetryIdentity,
): Record<string, string> {
  const attributes = [
    ["automata.run_id", telemetryRunId(identity)],
    ["automata.thread_id", identity.threadId],
    ["automata.lane", identity.lane],
    ["automata.org", identity.orgId],
  ]
    .map(([k, v]) => `${k}=${resourceValue(v ?? "")}`)
    .join(",");
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${RUN_TELEMETRY_BRIDGE_PORT}`,
    OTEL_EXPORTER_OTLP_HEADERS: "",
    OTEL_METRIC_EXPORT_INTERVAL: "10000",
    OTEL_LOGS_EXPORT_INTERVAL: "5000",
    OTEL_TRACES_EXPORT_INTERVAL: "5000",
    OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "false",
    OTEL_SERVICE_NAME: "automata-agent-run",
    OTEL_RESOURCE_ATTRIBUTES: attributes,
    OTEL_LOG_USER_PROMPTS: "0",
    OTEL_LOG_TOOL_DETAILS: "0",
  };
}
