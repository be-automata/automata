/**
 * Minimal YouTrack REST client for the post-merge audit (ADR-008).
 *
 * Control-plane only: the token it carries never reaches an agent. Fetch-only
 * (no fs, no node builtins) so it bundles for the Workers runtime.
 *
 * The calls mirror what the operator-side `ytctl` wrapper sends, so a
 * behaviour seen from the terminal is the behaviour this client produces:
 *   GET  /api/issues/{id}?fields=…
 *   POST /api/commands            {query, issues:[{idReadable}]}
 *   POST /api/issues/{id}/comments {text}
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Shape of a readable issue id (`ACME-812`), shared with key extraction. */
export const ISSUE_KEY_SOURCE = "[A-Z][A-Z0-9_]{1,9}-\\d+";
const ISSUE_KEY_RE = new RegExp(`^${ISSUE_KEY_SOURCE}$`);

const STAGE_FIELDS = "customFields(name,value(name))";

const ISSUE_FIELDS =
  `idReadable,summary,description,resolved,${STAGE_FIELDS},` +
  "links(direction,linkType(name,sourceToTarget,targetToSource)," +
  `issues(idReadable,summary,resolved,${STAGE_FIELDS})),` +
  "comments(id,text)";

/**
 * The board field on the pilot instance is named `Stage`; a stock YouTrack
 * project names it `State`. Reads accept either, `Stage` first. Writes use
 * `Stage`: on a `State` board the command is rejected, the read-back shows no
 * change, and the audit reports the move as not applied.
 */
const STAGE_FIELD_NAMES = ["Stage", "State"] as const;

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

function assertIssueKey(key: string): void {
  if (!ISSUE_KEY_RE.test(key)) {
    throw new TrackerConfigError(`not a valid issue key: ${key.slice(0, 32)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readStage(customFields: unknown): string | null {
  const fields = asArray(customFields).filter(isRecord);
  for (const fieldName of STAGE_FIELD_NAMES) {
    const field = fields.find((candidate) => candidate.name === fieldName);
    if (field && isRecord(field.value)) {
      const name = asString(field.value.name);
      if (name) return name;
    }
  }
  return null;
}

function parseLinkedIssue(raw: unknown): TrackerLinkedIssue | null {
  if (!isRecord(raw)) return null;
  const key = asString(raw.idReadable);
  if (!key) return null;
  return {
    key,
    summary: asString(raw.summary),
    stage: readStage(raw.customFields),
    resolved: raw.resolved !== null && raw.resolved !== undefined,
  };
}

function parseLink(raw: unknown): TrackerLink | null {
  if (!isRecord(raw) || !isRecord(raw.linkType)) return null;
  const issues = asArray(raw.issues)
    .map(parseLinkedIssue)
    .filter((issue): issue is TrackerLinkedIssue => issue !== null);
  if (issues.length === 0) return null;
  const direction: TrackerLinkDirection =
    raw.direction === "OUTWARD" || raw.direction === "INWARD"
      ? raw.direction
      : "BOTH";
  const sourceToTarget = asString(raw.linkType.sourceToTarget);
  const targetToSource = asString(raw.linkType.targetToSource);
  return {
    direction,
    typeName: asString(raw.linkType.name),
    verb:
      direction === "INWARD"
        ? targetToSource || sourceToTarget
        : sourceToTarget,
    issues,
  };
}

export function parseTrackerIssue(raw: unknown): TrackerIssue {
  const base = parseLinkedIssue(raw);
  if (base === null || !isRecord(raw)) {
    throw new TrackerRequestError("issue parse", 502);
  }
  return {
    ...base,
    description: asString(raw.description),
    links: asArray(raw.links)
      .map(parseLink)
      .filter((link): link is TrackerLink => link !== null),
    comments: asArray(raw.comments)
      .filter(isRecord)
      .map((comment) => ({
        id: asString(comment.id),
        text: asString(comment.text),
      })),
  };
}

export function createYouTrackClient({
  baseUrl,
  token,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
}: {
  baseUrl: string;
  token: string;
  /** Per-request budget. The webhook path passes a tighter one. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): TrackerClient {
  const origin = normalizeTrackerBaseUrl(baseUrl);

  async function request(
    operation: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetchImpl(`${origin}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      // Never follow a redirect: the bearer must not travel to another host.
      // "manual", not "error" — the Workers runtime rejects "error" outright
      // (only "follow" | "manual" are valid there), and a 3xx then fails the
      // `ok` check below like any other non-2xx.
      redirect: "manual",
    });
    if (!response.ok) {
      // Status only. The response body can echo request details and is never
      // logged or surfaced.
      throw new TrackerRequestError(operation, response.status);
    }
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new TrackerRequestError(`${operation} parse`, 502);
    }
  }

  function issuePath(key: string, fields: string): string {
    assertIssueKey(key);
    return `/issues/${key}?fields=${encodeURIComponent(fields)}`;
  }

  return {
    async getIssue(key) {
      return parseTrackerIssue(
        await request("issue fetch", "GET", issuePath(key, ISSUE_FIELDS)),
      );
    },

    async getStage(key) {
      const raw = await request(
        "stage fetch",
        "GET",
        issuePath(key, STAGE_FIELDS),
      );
      return isRecord(raw) ? readStage(raw.customFields) : null;
    },

    async setStage(key, stage) {
      assertIssueKey(key);
      // The command text `ytctl update <id> stage <value>` sends.
      await request("command", "POST", "/commands", {
        query: `${STAGE_FIELD_NAMES[0]} ${stage}`,
        issues: [{ idReadable: key }],
      });
    },

    async addComment(key, text) {
      assertIssueKey(key);
      await request("comment", "POST", `/issues/${key}/comments?fields=id`, {
        text,
      });
    },

    issueUrl(key) {
      return `${origin}/issue/${key}`;
    },
  };
}
