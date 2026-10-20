/**
 * Tracker-neutral contract for the post-merge audit (ADR-008): the issue
 * shape every client returns, the client interface, the typed errors, input
 * validation and the one HTTP path every client takes. Fetch-only (no fs, no
 * node builtins) so it bundles for the Workers runtime.
 */

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Shape of a readable issue id (`ACME-812`), shared with key extraction. */
export const ISSUE_KEY_SOURCE = "[A-Z][A-Z0-9_]{1,9}-\\d+";
const ISSUE_KEY_RE = new RegExp(`^${ISSUE_KEY_SOURCE}$`);

export type TrackerLinkDirection = "OUTWARD" | "INWARD" | "BOTH";

export interface TrackerLinkedIssue {
  key: string;
  summary: string;
  stage: string | null;
  resolved: boolean;
}

export interface TrackerLink {
  direction: TrackerLinkDirection;
  /** Canonical link-type name (`Depend`, `Subtask`, `Relates`, `Duplicate`). */
  typeName: string;
  /** The verb as read from THIS issue's side (`is required for`, `depends on`). */
  verb: string;
  issues: TrackerLinkedIssue[];
}

export interface TrackerComment {
  id: string;
  text: string;
}

export interface TrackerIssue extends TrackerLinkedIssue {
  description: string;
  links: TrackerLink[];
  comments: TrackerComment[];
}

export interface TrackerClient {
  getIssue(key: string): Promise<TrackerIssue>;
  /** The issue's current board stage only — the cheap read-back after a write. */
  getStage(key: string): Promise<string | null>;
  /** Ask the tracker to move the issue to a board stage. */
  setStage(key: string, stage: string): Promise<void>;
  addComment(key: string, text: string): Promise<void>;
  /** Browser URL of an issue, for links in comments. */
  issueUrl(key: string): string;
  /**
   * The stages the issue can move to right now, for a tracker whose workflow
   * is a set of named transitions (Jira). `null` for a tracker that accepts
   * any stage name as a command (YouTrack): the requested stage is sent as is.
   */
  listStageTargets(key: string): Promise<string[] | null>;
}

export class TrackerRequestError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number,
  ) {
    super(`tracker ${operation} failed with HTTP ${status}`);
    this.name = "TrackerRequestError";
  }
}

/**
 * The tracker offers no transition into the requested stage, so nothing was
 * written. `stage` is a policy-chosen name, never tracker- or user-supplied.
 */
export class TrackerTransitionError extends Error {
  constructor(public readonly stage: string) {
    super(`no transition to ${stage}`);
    this.name = "TrackerTransitionError";
  }
}

export class TrackerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackerConfigError";
  }
}

/**
 * What may be said about a tracker failure in a log line or a comment: the
 * operation and status, or the error's class name. Never `error.message` — it
 * can carry a URL — and never a response body.
 */
export function describeTrackerError(error: unknown): string {
  if (error instanceof TrackerRequestError) {
    return `${error.operation} failed (HTTP ${error.status})`;
  }
  if (error instanceof TrackerTransitionError) {
    return `no transition to ${error.stage} is available`;
  }
  return error instanceof Error ? error.name : "unexpected error";
}

/**
 * Validate the operator-supplied base URL. The control plane sends a bearer
 * token to this host, so it must be an https origin with a real hostname —
 * never a plain-http endpoint, an IP literal, or a loopback/internal name.
 *
 * This is a string-level check. It cannot see what a public-looking name
 * resolves to; the value is set by the org owner in their own environment, so
 * the residual risk is an owner pointing their own token at their own host.
 */
export function normalizeTrackerBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new TrackerConfigError("tracker base URL is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new TrackerConfigError("tracker base URL must use https");
  }
  if (url.username || url.password) {
    throw new TrackerConfigError("tracker base URL must not carry credentials");
  }
  // A trailing dot is the same host to DNS but would slip past the suffix
  // checks below (`localhost.`, `box.internal.`).
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  const isIpLiteral = /^[0-9.]+$/.test(host) || host.includes(":");
  if (
    isIpLiteral ||
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new TrackerConfigError(
      "tracker base URL must be a public hostname, not an IP or internal name",
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function assertIssueKey(key: string): void {
  if (!ISSUE_KEY_RE.test(key)) {
    throw new TrackerConfigError(`not a valid issue key: ${key.slice(0, 32)}`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Stage names compare trimmed and case-insensitively. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The one HTTP path every tracker client takes: JSON in and out, a per-request
 * timeout, and errors typed by operation and status only — the response body
 * can echo request details and is never logged or surfaced.
 */
export function createTrackerRequest({
  base,
  authorization,
  timeoutMs,
  fetchImpl,
}: {
  /** Origin plus API prefix; request paths are appended to it. */
  base: string;
  authorization: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}) {
  return async function request(
    operation: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      // Never follow a redirect: the credential must not travel to another
      // host. "manual", not "error" — the Workers runtime rejects "error"
      // outright (only "follow" | "manual" are valid there), and a 3xx then
      // fails the `ok` check below like any other non-2xx.
      redirect: "manual",
    });
    if (!response.ok) {
      throw new TrackerRequestError(operation, response.status);
    }
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new TrackerRequestError(`${operation} parse`, 502);
    }
  };
}
