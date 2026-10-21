import { z } from "zod";
import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import type { CompanionLaneStamp } from "@terragon/shared";
import {
  getThreadChat,
  getThreadMinimal,
} from "@terragon/shared/model/threads";
import { getOrganizationInstallationMode } from "@terragon/shared/model/github-installation";
import { isAbandonedTerminalCause } from "@terragon/shared/model/terminal-cause";
import { effectiveShadow } from "@/lib/github-side-effects";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import { getPostHogServer } from "@/lib/posthog-server";
import { getPrHeadState } from "./octokit-review-client";
import { isBotAuthor } from "./bot-login";
import { findLastLeadAgentText } from "./lead-text";
import { COMPANION_REPORT_KIND, isCompanionLaneStamp } from "./review-skill";
import { buildTaggedFence } from "./tagged-fence";
import { maybePromoteSkillLastKnownGood } from "./review-single-writer-finish";

/**
 * The PR companion lane's terminal writer (emit-only, like the review and
 * mention lanes). The agent never posts: its final message ends with one
 *
 *   ```json companion-report
 *   { "kind": "companion-report", "summary": "…", "findings": [ … ], "checks"?: [ … ] }
 *   ```
 *
 * block, and at finish the control plane writes ONE PR conversation comment
 * as the App. The comment is advisory and is never a review: the classic
 * review keeps sole ownership of the verdict (ADR-009).
 *   - One comment per (PR, skill): it starts with the hidden marker
 *     `<!-- automata:companion-report pr=<n> skill=<name> sha=<sha> -->`, and a
 *     later run EDITS that comment instead of posting another.
 *   - The body names the head sha the run reported on.
 *   - Newest head wins: a run for an older commit never overwrites the report
 *     about the PR's current head.
 *   - No parseable block → a short notice in the same comment, never silence.
 * Only the App's own comments count: anyone can type the marker.
 */

export const COMPANION_MARKER_PREFIX = "<!-- automata:companion-report";

/** The hidden marker of a (PR, skill) report about `sha`. */
export function companionReportMarker(
  stamp: Pick<CompanionLaneStamp, "prNumber" | "skillName" | "headSha">,
): string {
  return `${companionMarkerKey(stamp)} sha=${stamp.headSha} -->`;
}

/** The marker up to (not including) the sha: matched as a prefix. */
function companionMarkerKey(
  stamp: Pick<CompanionLaneStamp, "prNumber" | "skillName">,
): string {
  return `${COMPANION_MARKER_PREFIX} pr=${stamp.prNumber} skill=${stamp.skillName}`;
}

/** The sha a report comment names, or null when it is not one of ours. */
export function parseCompanionMarkerSha(
  body: string,
  stamp: Pick<CompanionLaneStamp, "prNumber" | "skillName">,
): string | null {
  const key = `${companionMarkerKey(stamp)} sha=`;
  if (!body.startsWith(key)) return null;
  const match = /^([0-9a-f]{7,64}) -->/.exec(body.slice(key.length));
  return match?.[1] ?? null;
}

const COMPANION_REPORT_FENCE = buildTaggedFence(COMPANION_REPORT_KIND);

export const COMPANION_SEVERITIES = [
  "critical",
  "error",
  "warning",
  "info",
] as const;

const findingSchema = z.object({
  severity: z.enum(COMPANION_SEVERITIES),
  body: z.string().trim().min(1).max(4000),
  path: z.string().trim().min(1).max(500).optional(),
  line: z.number().int().positive().optional(),
  /** Where the finding came from: a skill name or a tool (`dart analyze`). */
  source: z.string().trim().min(1).max(100).optional(),
});

const checkSchema = z.object({
  name: z.string().trim().min(1).max(200),
  outcome: z.enum(["passed", "failed", "not_available", "skipped"]),
  detail: z.string().trim().max(2000).optional(),
});

const companionReportSchema = z.object({
  kind: z.literal(COMPANION_REPORT_KIND),
  summary: z.string().trim().min(1).max(20_000),
  findings: z.array(findingSchema).max(50),
  checks: z.array(checkSchema).max(20).optional(),
});

export type CompanionReport = z.infer<typeof companionReportSchema>;

export type ParseCompanionReportResult =
  | { ok: true; value: CompanionReport }
  | { ok: false; reason: string };

/** Untagged ```json fences, the fallback when the agent dropped the tag. */
const PLAIN_JSON_FENCE = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

/**
 * Parse the agent's terminal text. The LAST tagged `json companion-report`
 * block decides; without one, the last plain ```json block naming the kind.
 */
export function parseCompanionReport(text: string): ParseCompanionReportResult {
  let payload: string | null = null;
  const tagged = COMPANION_REPORT_FENCE.extractLast(text);
  if (tagged !== null) {
    if (!tagged.ok) return { ok: false, reason: tagged.reason };
    payload = tagged.payload;
  } else {
    for (const match of text.matchAll(PLAIN_JSON_FENCE)) {
      const candidate = match[1]?.trim() ?? "";
      if (candidate.includes(`"${COMPANION_REPORT_KIND}"`)) payload = candidate;
    }
  }
  if (payload === null) {
    return { ok: false, reason: "no companion-report block in agent output" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch (error) {
    return {
      ok: false,
      reason: `companion-report JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = companionReportSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `companion-report schema validation failed: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, value: parsed.data };
}

/** GitHub caps a comment body at 65536 characters. */
const COMMENT_BODY_LIMIT = 60_000;

/**
 * Agent text is derived from untrusted PR content: it must not be able to
 * forge our marker (or any other hidden automata marker) inside the body.
 */
function neutralise(text: string): string {
  return text.replaceAll("<!--", "&lt;!--");
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

const CHECK_LABELS: Record<
  NonNullable<CompanionReport["checks"]>[number]["outcome"],
  string
> = {
  passed: "passed",
  failed: "failed",
  not_available: "not available on this runner",
  skipped: "skipped",
};

function renderStaleNote(
  stamp: CompanionLaneStamp,
  currentHeadSha: string | null,
): string[] {
  if (!currentHeadSha || currentHeadSha === stamp.headSha) return [];
  return [
    `> The PR head has moved to \`${shortSha(currentHeadSha)}\` since this ` +
      `run started; these notes describe \`${shortSha(stamp.headSha)}\`.`,
  ];
}

function renderHeader(stamp: CompanionLaneStamp): string[] {
  return [
    companionReportMarker(stamp),
    `### PR companion: \`${stamp.skillName}\``,
    `Advisory notes for commit \`${stamp.headSha}\`. This is not a review ` +
      `and carries no verdict; the review of this PR is posted separately.`,
  ];
}

/** The comment for a parsed report: header, summary, findings, checks. */
export function renderCompanionReport(
  report: CompanionReport,
  stamp: CompanionLaneStamp,
  currentHeadSha: string | null,
): string {
  const parts = [
    ...renderHeader(stamp),
    ...renderStaleNote(stamp, currentHeadSha),
    neutralise(report.summary),
  ];
  const findings = [...report.findings].sort(
    (a, b) =>
      COMPANION_SEVERITIES.indexOf(a.severity) -
      COMPANION_SEVERITIES.indexOf(b.severity),
  );
  if (findings.length === 0) {
    parts.push("**Findings:** none.");
  } else {
    const lines = findings.map((finding) => {
      const where = finding.path
        ? ` \`${neutralise(finding.path)}${finding.line ? `:${finding.line}` : ""}\``
        : "";
      const source = finding.source ? ` _(${neutralise(finding.source)})_` : "";
      return `- **${finding.severity}**${where}${source}: ${neutralise(finding.body)}`;
    });
    parts.push(`**Findings (${findings.length}):**\n\n${lines.join("\n")}`);
  }
  if (report.checks && report.checks.length > 0) {
    const lines = report.checks.map(
      (check) =>
        `- \`${neutralise(check.name)}\`: ${CHECK_LABELS[check.outcome]}` +
        (check.detail ? `. ${neutralise(check.detail)}` : ""),
    );
    parts.push(`**Checks:**\n\n${lines.join("\n")}`);
  }
  const body = parts.join("\n\n");
  return body.length > COMMENT_BODY_LIMIT
    ? `${body.slice(0, COMMENT_BODY_LIMIT)}\n\n_(truncated)_`
    : body;
}

/** The comment when the run produced no usable report. */
export function renderCompanionNotice(
  stamp: CompanionLaneStamp,
  currentHeadSha: string | null,
): string {
  return [
    ...renderHeader(stamp),
    ...renderStaleNote(stamp, currentHeadSha),
    "The companion run finished without a usable report for this commit, " +
      "so there are no notes this time. The review of this PR is not affected.",
  ].join("\n\n");
}

/** The GitHub surface the writer needs, App-scoped. */
export interface CompanionReportGitHub {
  /** The App's own PR conversation comments. */
  listBotIssueComments(
    prNumber: number,
  ): Promise<Array<{ id: number; body: string }>>;
  createIssueComment(prNumber: number, body: string): Promise<void>;
  updateIssueComment(commentId: number, body: string): Promise<void>;
}

export type CompanionReportOutcome =
  | { outcome: "created" | "updated"; report: "parsed" | "notice" }
  | { outcome: "skipped_unchanged" }
  | { outcome: "skipped_newer_head"; existingSha: string }
  | { outcome: "post_failed"; failureReason: string };

interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * The pure core: decide and write. `currentHeadSha` is the PR head now, or
 * null when it could not be read (no newest-head check then).
 */
export async function executeCompanionReport({
  github,
  stamp,
  terminalText,
  currentHeadSha,
  logger,
}: {
  github: CompanionReportGitHub;
  stamp: CompanionLaneStamp;
  terminalText: string;
  currentHeadSha: string | null;
  logger?: Logger;
}): Promise<CompanionReportOutcome> {
  const meta = {
    repoFullName: stamp.repoFullName,
    prNumber: stamp.prNumber,
    skill: stamp.skillName,
    headSha: stamp.headSha,
  };

  // The newest of our marked comments for this (PR, skill). A failed lookup
  // posts a fresh comment: a rare duplicate beats a lost report.
  let existing: { id: number; body: string; sha: string } | null = null;
  try {
    for (const comment of await github.listBotIssueComments(stamp.prNumber)) {
      const sha = parseCompanionMarkerSha(comment.body, stamp);
      if (sha !== null && (existing === null || comment.id > existing.id)) {
        existing = { ...comment, sha };
      }
    }
  } catch (error) {
    logger?.warn("companion: comment lookup failed; posting a new one", {
      ...meta,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Newest head wins: a run for an older commit never replaces the report
  // about the commit the PR is at now.
  if (
    existing !== null &&
    currentHeadSha !== null &&
    stamp.headSha !== currentHeadSha &&
    existing.sha === currentHeadSha
  ) {
    logger?.info("companion: a report for the current head exists; skipping", {
      ...meta,
      currentHeadSha,
    });
    return { outcome: "skipped_newer_head", existingSha: existing.sha };
  }

  const parsed = parseCompanionReport(terminalText);
  const body = parsed.ok
    ? renderCompanionReport(parsed.value, stamp, currentHeadSha)
    : renderCompanionNotice(stamp, currentHeadSha);
  if (existing !== null && existing.body === body) {
    logger?.info("companion: report unchanged; skipping", meta);
    return { outcome: "skipped_unchanged" };
  }
  try {
    if (existing !== null) {
      await github.updateIssueComment(existing.id, body);
    } else {
      await github.createIssueComment(stamp.prNumber, body);
    }
  } catch (error) {
    const failureReason =
      error instanceof Error ? error.message : String(error);
    logger?.error("companion: write failed", { ...meta, failureReason });
    return { outcome: "post_failed", failureReason };
  }
  if (!parsed.ok) {
    logger?.error("companion: no usable block — wrote the notice", {
      ...meta,
      reason: parsed.reason,
    });
  }
  return {
    outcome: existing !== null ? "updated" : "created",
    report: parsed.ok ? "parsed" : "notice",
  };
}

type Octokit = Awaited<ReturnType<typeof getOctokitForApp>>;

export function createOctokitCompanionReportClient(
  octokit: Octokit,
  repoFullName: string,
): CompanionReportGitHub {
  const [owner, repo] = parseRepoFullName(repoFullName);
  return {
    async listBotIssueComments(prNumber) {
      const comments = await octokit.paginate(
        octokit.rest.issues.listComments,
        { owner, repo, issue_number: prNumber, per_page: 100 },
      );
      return comments
        .filter((comment) => isBotAuthor(comment.user?.login))
        .map((comment) => ({ id: comment.id, body: comment.body ?? "" }));
    },
    async createIssueComment(prNumber, body) {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
    },
    async updateIssueComment(commentId, body) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body,
      });
    },
  };
}

const logger: Logger = {
  info: (message, meta) => console.log(`[companion-report] ${message}`, meta),
  warn: (message, meta) => console.warn(`[companion-report] ${message}`, meta),
  error: (message, meta) =>
    console.error(`[companion-report] ${message}`, meta),
};

/**
 * The finish-hook entry: a no-op for every thread a companion automation did
 * not start. Shadow mode and GITHUB_SIDE_EFFECTS_ENABLED write nothing.
 * Never throws.
 */
export async function handleCompanionReportAtFinish({
  db,
  userId,
  threadId,
  threadChatId,
}: {
  db: DB;
  userId: string;
  threadId: string;
  threadChatId: string;
}): Promise<void> {
  try {
    if (!env.GITHUB_SIDE_EFFECTS_ENABLED) return;
    const thread = await getThreadMinimal({ db, userId, threadId });
    const stampMetadata = thread?.sourceMetadata;
    if (!thread || !isCompanionLaneStamp(stampMetadata)) return;
    const stamp = stampMetadata.companion;
    if (isAbandonedTerminalCause(thread.terminalCause ?? null)) {
      logger.info("abandoned run — no report", { threadId });
      return;
    }
    const mode = await getOrganizationInstallationMode({
      db,
      organizationId: thread.organizationId ?? null,
    });
    if (effectiveShadow(mode)) {
      logger.info("[shadow] report suppressed", { threadId });
      return;
    }
    const threadChat = await getThreadChat({
      db,
      threadId,
      threadChatId,
      userId,
    });
    const terminalText =
      findLastLeadAgentText(threadChat?.messages ?? null, (text) =>
        text.includes(COMPANION_REPORT_KIND),
      ) ??
      findLastLeadAgentText(threadChat?.messages ?? null, () => true) ??
      "";
    const [owner, repo] = parseRepoFullName(stamp.repoFullName);
    const octokit = await getOctokitForApp({ owner, repo });
    let currentHeadSha: string | null = null;
    try {
      currentHeadSha = (
        await getPrHeadState(octokit, stamp.repoFullName, stamp.prNumber)
      ).headSha;
    } catch (error) {
      logger.warn("PR head read failed — writing without the head check", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const outcome = await executeCompanionReport({
      github: createOctokitCompanionReportClient(octokit, stamp.repoFullName),
      stamp,
      terminalText,
      currentHeadSha,
      logger,
    });
    getPostHogServer().capture({
      distinctId: userId,
      event: "companion_report_outcome",
      properties: {
        threadId,
        repoFullName: stamp.repoFullName,
        prNumber: stamp.prNumber,
        skill: stamp.skillName,
        ...outcome,
      },
    });
    // A parsed report is the health signal for the skill body.
    await maybePromoteSkillLastKnownGood({
      db,
      organizationId: thread.organizationId ?? null,
      repoFullName: stamp.repoFullName,
      sourceMetadata: stampMetadata,
      outcome:
        "report" in outcome && outcome.report === "parsed"
          ? "posted"
          : "no_health_signal",
    });
  } catch (error) {
    console.error("[companion-report] finish hook failed (non-fatal)", {
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
