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
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  type TrackerClient,
  type TrackerIssue,
  type TrackerLink,
  type TrackerLinkDirection,
  type TrackerLinkedIssue,
  TrackerRequestError,
  asArray,
  asString,
  assertIssueKey,
  createTrackerRequest,
  isRecord,
  normalizeTrackerBaseUrl,
} from "./tracker-types";

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

  const request = createTrackerRequest({
    base: `${origin}/api`,
    authorization: `Bearer ${token}`,
    timeoutMs,
    fetchImpl,
  });

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

    async listStageTargets() {
      // Any stage name is a valid command; the read-back judges the result.
      return null;
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
