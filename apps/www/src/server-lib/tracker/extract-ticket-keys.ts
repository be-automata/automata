import { ISSUE_KEY_SOURCE } from "./youtrack-client";

/**
 * Server-side ticket-key extraction for the post-merge audit (ADR-008).
 *
 * Runs on the control plane, over GitHub's own PR fields — at intake to decide
 * which tickets to prefetch, and AGAIN at finish to decide which tickets may be
 * written to. The agent's emitted intent is never the authority for which
 * ticket gets a comment or a stage change: a prompt-injected PR body could
 * otherwise steer writes at an arbitrary issue.
 */

/** A PR that delivers more tickets than this is an epic-style hub; triage by hand. */
export const MAX_TICKET_KEYS = 3;

/**
 * Prefixes that look like ticket keys but are standards / identifiers. Only
 * consulted when no project list is configured (generic matching).
 */
const GENERIC_KEY_REJECTS: ReadonlySet<string> = new Set([
  "HTTP",
  "UTF",
  "IPV",
  "OAUTH",
  "SHA",
  "ISO",
  "RFC",
  "TLS",
  "SSL",
  "CVE",
  "UTC",
  "GMT",
  "ES",
  "X",
]);

const PROJECT_NAME_RE = /^[A-Z][A-Z0-9_]{1,9}$/;

export interface TicketKeyExtraction {
  /**
   * The ticket the PR is about: first key in the title, else the head branch,
   * else a closing keyword, else the body when it names exactly one key.
   */
  primary: string | null;
  /** Keys named by a closing keyword (`Closes|Fixes|Resolves KEY`). */
  closingKeys: string[];
  /**
   * The tickets this PR DELIVERS — the primary plus every closing key, capped
   * at MAX_TICKET_KEYS. Only these are audited, commented on, or moved.
   */
  auditKeys: string[];
  /**
   * Tickets the PR merely mentions (`Refs`, `Related`, "deferred to …").
   * Context for the audit and a line on the PR comment — never audited, never
   * written to: measuring a ticket against a PR that is not about it produces
   * a list of "misses" that are simply someone else's work.
   */
  referencedKeys: string[];
  /** True when the PR delivers more tickets than the audit cap allows. */
  truncated: boolean;
}

/** Mentioned-only tickets listed for context. */
const MAX_REFERENCED_KEYS = 10;

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Trimmed, upper-cased tracker project short names; malformed ones dropped. */
export function normalizeProjects(projects: readonly string[]): string[] {
  return projects
    .map((project) => project.trim().toUpperCase())
    .filter((project) => PROJECT_NAME_RE.test(project));
}

interface KeyPattern {
  source: string;
  /** No project list: any upper-case KEY-123, minus the reject list. */
  generic: boolean;
}

function buildKeyPattern(projects: readonly string[]): KeyPattern {
  if (projects.length === 0) {
    return { source: ISSUE_KEY_SOURCE, generic: true };
  }
  return {
    source: `(?:${projects.map(escapeRegExp).join("|")})-\\d+`,
    generic: false,
  };
}

function findKeys(text: string, pattern: KeyPattern): string[] {
  // Configured projects match case-insensitively (branch names are usually
  // lowercase: `acme-812-foo`). Generic matching stays case-sensitive — an
  // upper-case prefix is the only thing separating a key from ordinary prose.
  const re = new RegExp(
    `(?<![A-Za-z0-9_])(${pattern.source})(?![A-Za-z0-9_])`,
    pattern.generic ? "g" : "gi",
  );
  const found: string[] = [];
  for (const match of text.matchAll(re)) {
    const key = match[1]?.toUpperCase();
    if (!key) continue;
    if (
      pattern.generic &&
      GENERIC_KEY_REJECTS.has(key.slice(0, key.lastIndexOf("-")))
    ) {
      continue;
    }
    found.push(key);
  }
  return found;
}

export function extractTicketKeys({
  title,
  body,
  headBranch,
  projects,
}: {
  title: string | null | undefined;
  body: string | null | undefined;
  headBranch: string | null | undefined;
  /** Tracker project short names (e.g. `["ACME"]`). Empty = generic matching. */
  projects: readonly string[];
}): TicketKeyExtraction {
  const pattern = buildKeyPattern(normalizeProjects(projects));
  const titleText = title ?? "";
  const bodyText = body ?? "";

  const titleKeys = findKeys(titleText, pattern);
  const bodyKeys = findKeys(bodyText, pattern);
  const branchKeys = findKeys(headBranch ?? "", pattern);

  // Closing keywords are only meaningful in prose (title/body), never a branch.
  // `\s*(?::\s*)?` rather than `\s*:?\s*`: two adjacent whitespace runs
  // backtrack quadratically on a long run of spaces in author-controlled text.
  const closingRe = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b\\s*(?::\\s*)?((?:${pattern.source})(?:\\s*(?:,|and)\\s*(?:${pattern.source}))*)(?![A-Za-z0-9_])`,
    "gi",
  );
  const closingAll = [
    ...new Set(
      [...`${titleText}\n${bodyText}`.matchAll(closingRe)].flatMap((match) =>
        findKeys(match[1] ?? "", pattern),
      ),
    ),
  ];

  // The primary is the ticket this PR is ABOUT: named in the title, else in
  // the head branch, else by a closing keyword. A bare mention in the body is
  // usually a pointer to some OTHER ticket ("AC-3 deferred to ACME-901"), so it
  // becomes the primary only when it is the single key the PR names at all.
  const distinctBodyKeys = [...new Set(bodyKeys)];
  const primary =
    titleKeys[0] ??
    branchKeys[0] ??
    closingAll[0] ??
    (distinctBodyKeys.length === 1 ? distinctBodyKeys[0] : undefined) ??
    null;
  const primaryFirst = primary ? [primary] : [];

  const delivered = [...new Set([...primaryFirst, ...closingAll])];
  const auditKeys = delivered.slice(0, MAX_TICKET_KEYS);
  const referencedKeys = [
    ...new Set([...titleKeys, ...bodyKeys, ...branchKeys]),
  ]
    .filter((key) => !delivered.includes(key))
    .slice(0, MAX_REFERENCED_KEYS);

  return {
    primary,
    closingKeys: closingAll.filter((key) => auditKeys.includes(key)),
    auditKeys,
    referencedKeys,
    truncated: delivered.length > MAX_TICKET_KEYS,
  };
}
