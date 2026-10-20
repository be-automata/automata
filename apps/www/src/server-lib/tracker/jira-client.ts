/**
 * Minimal Jira Cloud REST client for the post-merge audit (ADR-008).
 *
 * Control-plane only: the API token it carries never reaches an agent.
 * Fetch-only (no fs, no node builtins) so it bundles for the Workers runtime.
 *
 *   GET  /rest/api/3/issue/{key}?fields=…
 *   GET  /rest/api/3/issue/{key}/transitions
 *   POST /rest/api/3/issue/{key}/transitions {transition:{id}}
 *   POST /rest/api/2/issue/{key}/comment     {body}   (v2: plain/wiki text)
 *
 * Jira moves an issue through workflow TRANSITIONS, not by naming a status:
 * `setStage` picks the transition whose destination status matches the
 * requested name, and writes nothing when none does.
 */

import {
  assertIssueKey,
  normalizeTrackerBaseUrl,
  type TrackerClient,
  type TrackerComment,
  type TrackerIssue,
  type TrackerLink,
  type TrackerLinkDirection,
  type TrackerLinkedIssue,
  TrackerRequestError,
  TrackerTransitionError,
} from "./youtrack-client";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const ISSUE_FIELDS =
  "summary,description,status,issuelinks,subtasks,comment" as const;

/** Canonical link-type name the audit policy reads for Jira sub-tasks. */
export const JIRA_SUBTASK_LINK = "Subtask";

/** ADF nesting is bounded so a hostile document cannot blow the stack. */
const MAX_ADF_DEPTH = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function attrsOf(node: Record<string, unknown>): Record<string, unknown> {
  return isRecord(node.attrs) ? node.attrs : {};
}

// ---------------------------------------------------------------------------
// Atlassian Document Format → plain text
// ---------------------------------------------------------------------------

function renderInline(nodes: unknown[], depth: number): string {
  return nodes.map((node) => renderInlineNode(node, depth)).join("");
}

function renderInlineNode(node: unknown, depth: number): string {
  if (!isRecord(node) || depth > MAX_ADF_DEPTH) return "";
  const attrs = attrsOf(node);
  switch (node.type) {
    case "text":
      return asString(node.text);
    case "hardBreak":
      return "\n";
    case "mention":
      return asString(attrs.text) || "@user";
    case "emoji":
      return asString(attrs.text) || asString(attrs.shortName);
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return asString(attrs.url);
    case "status":
      return asString(attrs.text);
    case "date":
      return asString(attrs.timestamp);
    default:
      return renderInline(asArray(node.content), depth + 1);
  }
}

/** Continuation lines of a list item line up under its text. */
function indentContinuation(text: string, marker: string): string {
  const pad = " ".repeat(marker.length);
  return `${marker}${text.split("\n").join(`\n${pad}`)}`;
}

function renderListItem(item: unknown, depth: number): string {
  if (!isRecord(item)) return "";
  return renderBlocks(asArray(item.content), depth + 1).join("\n");
}

function renderBlock(node: unknown, depth: number): string {
  if (!isRecord(node) || depth > MAX_ADF_DEPTH) return "";
  const attrs = attrsOf(node);
  const content = asArray(node.content);
  switch (node.type) {
    case "paragraph":
      return renderInline(content, depth + 1);
    case "heading": {
      const level = typeof attrs.level === "number" ? attrs.level : 2;
      const hashes = "#".repeat(Math.min(Math.max(level, 1), 6));
      return `${hashes} ${renderInline(content, depth + 1)}`;
    }
    case "bulletList":
      return content
        .map((item) => indentContinuation(renderListItem(item, depth), "- "))
        .join("\n");
    case "orderedList": {
      const start = typeof attrs.order === "number" ? attrs.order : 1;
      return content
        .map((item, index) =>
          indentContinuation(renderListItem(item, depth), `${start + index}. `),
        )
        .join("\n");
    }
    case "taskList":
      return content
        .map((item) => {
          const done = isRecord(item) && attrsOf(item).state === "DONE";
          const text = isRecord(item)
            ? renderInline(asArray(item.content), depth + 1)
            : "";
          return indentContinuation(text, done ? "- [x] " : "- [ ] ");
        })
        .join("\n");
    case "codeBlock": {
      const language = asString(attrs.language);
      return `\`\`\`${language}\n${renderInline(content, depth + 1)}\n\`\`\``;
    }
    case "blockquote":
      return renderBlocks(content, depth + 1)
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "rule":
      return "---";
    case "table":
      return content
        .map((row) =>
          isRecord(row)
            ? `| ${asArray(row.content)
                .map((cell) =>
                  isRecord(cell)
                    ? renderBlocks(asArray(cell.content), depth + 2)
                        .join(" ")
                        .replace(/\n/g, " ")
                    : "",
                )
                .join(" | ")} |`
            : "",
        )
        .join("\n");
    case "media":
    case "mediaGroup":
    case "mediaSingle":
      return "";
    default:
      // Panels, expands, layouts: containers of blocks. Anything else that
      // carries text is read as inline.
      return content.some(
        (child) => isRecord(child) && Array.isArray(child.content),
      )
        ? renderBlocks(content, depth + 1).join("\n\n")
        : renderInlineNode(node, depth);
  }
}

function renderBlocks(nodes: unknown[], depth: number): string[] {
  return nodes
    .map((node) => renderBlock(node, depth))
    .filter((text) => text.trim().length > 0);
}

/**
 * Plain text of an Atlassian Document Format value (v3 description and
 * comment bodies). A string is returned as is — the v2 API and older
 * instances send wiki text.
 */
export function flattenAdf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  return renderBlocks(asArray(value.content), 0).join("\n\n").trim();
}

// ---------------------------------------------------------------------------
// Issue parsing
// ---------------------------------------------------------------------------

interface JiraStatus {
  name: string | null;
  done: boolean;
}

function readStatus(fields: unknown): JiraStatus {
  if (!isRecord(fields) || !isRecord(fields.status)) {
    return { name: null, done: false };
  }
  const { status } = fields;
  const category = isRecord(status.statusCategory)
    ? asString(status.statusCategory.key)
    : "";
  return { name: asString(status.name) || null, done: category === "done" };
}

function parseJiraLinkedIssue(raw: unknown): TrackerLinkedIssue | null {
  if (!isRecord(raw)) return null;
  const key = asString(raw.key);
  if (!key) return null;
  const status = readStatus(raw.fields);
  return {
    key,
    summary: isRecord(raw.fields) ? asString(raw.fields.summary) : "",
    stage: status.name,
    resolved: status.done,
  };
}

/**
 * Jira returns one entry per linked issue; the audit reads links grouped by
 * type and direction, like YouTrack. An entry with an `outwardIssue` reads
 * "this issue <outward verb> that one" (`blocks`); `inwardIssue` reads
 * "<inward verb>" (`is blocked by`).
 */
function parseIssueLinks(raw: unknown): TrackerLink[] {
  const grouped = new Map<string, TrackerLink>();
  for (const entry of asArray(raw)) {
    if (!isRecord(entry) || !isRecord(entry.type)) continue;
    const typeName = asString(entry.type.name);
    const outward = parseJiraLinkedIssue(entry.outwardIssue);
    const inward = parseJiraLinkedIssue(entry.inwardIssue);
    const direction: TrackerLinkDirection | null = outward
      ? "OUTWARD"
      : inward
        ? "INWARD"
        : null;
    const linked = outward ?? inward;
    if (!typeName || direction === null || linked === null) continue;
    const groupKey = `${typeName}\u0000${direction}`;
    const existing = grouped.get(groupKey);
    if (existing) {
      existing.issues.push(linked);
      continue;
    }
    grouped.set(groupKey, {
      direction,
      typeName,
      verb:
        direction === "OUTWARD"
          ? asString(entry.type.outward)
          : asString(entry.type.inward),
      issues: [linked],
    });
  }
  return [...grouped.values()];
}

export function parseJiraIssue(raw: unknown): TrackerIssue {
  const base = parseJiraLinkedIssue(raw);
  if (base === null || !isRecord(raw) || !isRecord(raw.fields)) {
    throw new TrackerRequestError("issue parse", 502);
  }
  const { fields } = raw;
  const links = parseIssueLinks(fields.issuelinks);
  const subtasks = asArray(fields.subtasks)
    .map(parseJiraLinkedIssue)
    .filter((issue): issue is TrackerLinkedIssue => issue !== null);
  if (subtasks.length > 0) {
    links.push({
      direction: "OUTWARD",
      typeName: JIRA_SUBTASK_LINK,
      verb: "parent for",
      issues: subtasks,
    });
  }
  const comments: TrackerComment[] = (
    isRecord(fields.comment) ? asArray(fields.comment.comments) : []
  )
    .filter(isRecord)
    .map((comment) => ({
      id: asString(comment.id),
      text: flattenAdf(comment.body),
    }));
  return {
    ...base,
    description: flattenAdf(fields.description),
    links,
    comments,
  };
}

interface JiraTransition {
  id: string;
  to: string;
}

function parseTransitions(raw: unknown): JiraTransition[] {
  if (!isRecord(raw)) return [];
  return asArray(raw.transitions)
    .filter(isRecord)
    .map((transition) => ({
      id: asString(transition.id),
      to: isRecord(transition.to) ? asString(transition.to.name) : "",
    }))
    .filter((transition) => transition.id && transition.to);
}

/**
 * The audit's comment is written in Markdown. Jira's v2 comment body is wiki
 * text, where a link is `[label|url]`; only an unescaped `[label](https://…)`
 * is rewritten — ticket text reaches the comment with `[` already escaped.
 */
export function toJiraWikiText(text: string): string {
  return text.replace(
    /(^|[^\\])\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g,
    "$1[$2|$3]",
  );
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function createJiraClient({
  baseUrl,
  username,
  token,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
}: {
  baseUrl: string;
  /** The Atlassian account email the API token belongs to. */
  username: string;
  token: string;
  /** Per-request budget. The webhook path passes a tighter one. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): TrackerClient {
  const origin = normalizeTrackerBaseUrl(baseUrl);
  const authorization = `Basic ${btoa(
    String.fromCharCode(...new TextEncoder().encode(`${username}:${token}`)),
  )}`;

  async function request(
    operation: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetchImpl(`${origin}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      // Never follow a redirect: the credential must not travel to another
      // host. "manual" — the Workers runtime rejects "error" — so a 3xx fails
      // the `ok` check below like any other non-2xx.
      redirect: "manual",
    });
    if (!response.ok) {
      // Status only; the body can echo request details.
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

  function issuePath(key: string, suffix = ""): string {
    assertIssueKey(key);
    return `/rest/api/3/issue/${key}${suffix}`;
  }

  async function transitions(key: string): Promise<JiraTransition[]> {
    return parseTransitions(
      await request("transitions fetch", "GET", issuePath(key, "/transitions")),
    );
  }

  return {
    async getIssue(key) {
      return parseJiraIssue(
        await request(
          "issue fetch",
          "GET",
          issuePath(key, `?fields=${encodeURIComponent(ISSUE_FIELDS)}`),
        ),
      );
    },

    async getStage(key) {
      const raw = await request(
        "stage fetch",
        "GET",
        issuePath(key, "?fields=status"),
      );
      return isRecord(raw) ? readStatus(raw.fields).name : null;
    },

    async listStageTargets(key) {
      return [
        ...new Set((await transitions(key)).map((transition) => transition.to)),
      ];
    },

    async setStage(key, stage) {
      const transition = (await transitions(key)).find((candidate) =>
        sameName(candidate.to, stage),
      );
      if (!transition) {
        throw new TrackerTransitionError(stage);
      }
      await request("transition", "POST", issuePath(key, "/transitions"), {
        transition: { id: transition.id },
      });
    },

    async addComment(key, text) {
      assertIssueKey(key);
      await request("comment", "POST", `/rest/api/2/issue/${key}/comment`, {
        body: toJiraWikiText(text),
      });
    },

    issueUrl(key) {
      return `${origin}/browse/${key}`;
    },
  };
}
