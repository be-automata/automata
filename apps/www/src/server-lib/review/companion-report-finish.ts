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
import type { ReviewLogger } from "@terragon/review/state/review-github-client";
import { effectiveShadow } from "@/lib/github-side-effects";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import { getPostHogServer } from "@/lib/posthog-server";
import { getPrHeadState } from "./octokit-review-client";
import { isBotAuthor } from "./bot-login";
import { findLastLeadAgentText } from "./lead-text";
import { COMPANION_REPORT_KIND, isCompanionLaneStamp } from "./review-skill";
import {
  buildTaggedFence,
  parseTaggedJsonBlock,
  type ParseTaggedJsonResult,
} from "./tagged-fence";
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
 *     `<!-- automata:companion-report pr=<n> skill=<name> sha=<sha> at=<ms> -->`,
 *     and a later run EDITS that comment instead of posting another.
 *   - The body names the head sha the run reported on.
 *   - Newest run wins: `at` is when the run's thread was created (the PR head
 *     is read at that moment), so a run that finishes late never overwrites
 *     a report from a run started after it, nor the report about the PR's
 *     current head.
 *   - Two runs that finish together converge on one comment: after writing,
 *     the writer re-reads, keeps the newest run's comment and deletes the
 *     other marked copies (the review-notice lane's dedupe, same posture).
 *   - No parseable block → a short notice in the same comment, never silence.
 * Only the App's own comments count: anyone can type the marker.
 */

export const COMPANION_MARKER_PREFIX = "<!-- automata:companion-report";

/** What a report comment describes: the stamped PR head and the run's start. */
export interface CompanionReportRun {
  stamp: CompanionLaneStamp;
  /** The run's thread creation time, epoch ms: orders two runs' reports. */
  requestedAt: number;
}

/** The hidden marker of a (PR, skill) report about `stamp.headSha`. */
export function companionReportMarker({
  stamp,
  requestedAt,
}: CompanionReportRun): string {
  return `${companionMarkerKey(stamp)} sha=${stamp.headSha} at=${requestedAt} -->`;
}

/** The marker up to (not including) the sha: matched as a prefix. */
function companionMarkerKey(
  stamp: Pick<CompanionLaneStamp, "prNumber" | "skillName">,
): string {
  return `${COMPANION_MARKER_PREFIX} pr=${stamp.prNumber} skill=${stamp.skillName}`;
}

const MARKER_TAIL = /^([0-9a-f]{7,64}) at=(\d{1,16}) -->/;

/** The commit and run time a report comment names, or null when it is not ours. */
export function parseCompanionMarker(
  body: string,
  stamp: Pick<CompanionLaneStamp, "prNumber" | "skillName">,
): { sha: string; at: number } | null {
  const key = `${companionMarkerKey(stamp)} sha=`;
  if (!body.startsWith(key)) return null;
  const match = MARKER_TAIL.exec(body.slice(key.length));
  return match ? { sha: match[1]!, at: Number(match[2]) } : null;
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

export type ParseCompanionReportResult = ParseTaggedJsonResult<CompanionReport>;

/**
 * Parse the agent's terminal text. The LAST tagged `json companion-report`
 * block decides; without one, the last plain ```json block naming the kind.
 */
export function parseCompanionReport(text: string): ParseCompanionReportResult {
  return parseTaggedJsonBlock(
    text,
    COMPANION_REPORT_FENCE,
    companionReportSchema,
  );
}

/**
 * GitHub caps a comment body at 65536 characters; the cut leaves room for
 * the truncation note.
 */
const COMMENT_BODY_LIMIT = 60_000;

/**
 * Agent text is derived from untrusted PR content: it must not be able to
 * forge our marker (or any other hidden automata marker) inside the body.
 */
function neutralise(text: string): string {
  return text.replaceAll("<!--", "&lt;!--");
}

/** `text` cut to `limit` UTF-16 units without splitting a surrogate pair. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const code = text.charCodeAt(limit - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
  return `${text.slice(0, end)}\n\n_(truncated)_`;
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

/** The opening lines every companion comment shares: marker, title, head. */
function renderHeader(
  run: CompanionReportRun,
  currentHeadSha: string | null,
): string[] {
  const { stamp } = run;
  const lines = [
    companionReportMarker(run),
    `### PR companion: \`${stamp.skillName}\``,
    `Advisory notes for commit \`${stamp.headSha}\`. This is not a review ` +
      `and carries no verdict; the review of this PR is posted separately.`,
  ];
  if (currentHeadSha && currentHeadSha !== stamp.headSha) {
    lines.push(
      `> The PR head has moved to \`${shortSha(currentHeadSha)}\` since this ` +
        `run started; these notes describe \`${shortSha(stamp.headSha)}\`.`,
    );
  }
  return lines;
}

/** The comment for a parsed report: header, summary, findings, checks. */
export function renderCompanionReport(
  report: CompanionReport,
  run: CompanionReportRun,
  currentHeadSha: string | null,
): string {
  const parts = [
    ...renderHeader(run, currentHeadSha),
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
  return truncate(parts.join("\n\n"), COMMENT_BODY_LIMIT);
}

/** The comment when the run produced no usable report. */
export function renderCompanionNotice(
  run: CompanionReportRun,
  currentHeadSha: string | null,
): string {
  return [
    ...renderHeader(run, currentHeadSha),
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
  /** False when the comment is gone (a person deleted it); throws otherwise. */
  updateIssueComment(commentId: number, body: string): Promise<boolean>;
  deleteIssueComment(commentId: number): Promise<void>;
}

export type CompanionReportOutcome =
  | { outcome: "created" | "updated"; report: "parsed" | "notice" }
  | { outcome: "skipped_unchanged" }
  | { outcome: "skipped_newer_head"; existingSha: string }
  | { outcome: "post_failed"; failureReason: string };

interface MarkedComment {
  id: number;
  body: string;
  sha: string;
  at: number;
}

/** Our marked comments for this (PR, skill). */
async function listMarked(
  github: CompanionReportGitHub,
  stamp: CompanionLaneStamp,
): Promise<MarkedComment[]> {
  const comments = await github.listBotIssueComments(stamp.prNumber);
  return comments.flatMap((comment) => {
    const marker = parseCompanionMarker(comment.body, stamp);
    return marker ? [{ ...comment, ...marker }] : [];
  });
}

/** The comment that stands: the newest run's, the later comment on a tie. */
function newestOf(comments: MarkedComment[]): MarkedComment | null {
  let best: MarkedComment | null = null;
  for (const comment of comments) {
    if (
      best === null ||
      comment.at > best.at ||
      (comment.at === best.at && comment.id > best.id)
    ) {
      best = comment;
    }
  }
  return best;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The pure core: decide and write. `currentHeadSha` is the PR head now, or
 * null when it could not be read (no current-head check then).
 */
export async function executeCompanionReport({
  github,
  run,
  terminalText,
  currentHeadSha,
  logger,
}: {
  github: CompanionReportGitHub;
  run: CompanionReportRun;
  terminalText: string;
  currentHeadSha: string | null;
  logger?: ReviewLogger;
}): Promise<CompanionReportOutcome> {
  const { stamp, requestedAt } = run;
  const meta = {
    repoFullName: stamp.repoFullName,
    prNumber: stamp.prNumber,
    skill: stamp.skillName,
    headSha: stamp.headSha,
  };

  // A failed lookup posts a fresh comment: a rare duplicate (which the next
  // run's convergence removes) beats a lost report.
  let existing: MarkedComment | null = null;
  try {
    existing = newestOf(await listMarked(github, stamp));
  } catch (error) {
    logger?.warn("companion: comment lookup failed; posting a new one", {
      ...meta,
      error: errorMessage(error),
    });
  }

  // Newest run wins: a run started after this one already reported, or the
  // comment is about the commit the PR is at now while this run is not.
  if (
    existing !== null &&
    (existing.at > requestedAt ||
      (currentHeadSha !== null &&
        stamp.headSha !== currentHeadSha &&
        existing.sha === currentHeadSha))
  ) {
    logger?.info("companion: a newer report exists; skipping", {
      ...meta,
      existingSha: existing.sha,
      currentHeadSha,
    });
    return { outcome: "skipped_newer_head", existingSha: existing.sha };
  }

  const parsed = parseCompanionReport(terminalText);
  const body = parsed.ok
    ? renderCompanionReport(parsed.value, run, currentHeadSha)
    : renderCompanionNotice(run, currentHeadSha);
  if (existing !== null && existing.body === body) {
    logger?.info("companion: report unchanged; skipping", meta);
    return { outcome: "skipped_unchanged" };
  }
  let outcome: "created" | "updated";
  try {
    // A comment a person deleted since the lookup is replaced, not lost.
    if (
      existing !== null &&
      (await github.updateIssueComment(existing.id, body))
    ) {
      outcome = "updated";
    } else {
      await github.createIssueComment(stamp.prNumber, body);
      outcome = "created";
    }
  } catch (error) {
    const failureReason = errorMessage(error);
    logger?.error("companion: write failed", { ...meta, failureReason });
    return { outcome: "post_failed", failureReason };
  }
  if (!parsed.ok) {
    logger?.error("companion: no usable block — wrote the notice", {
      ...meta,
      reason: parsed.reason,
    });
  }
  await convergeOnOneComment({ github, run, body, logger, meta });
  return { outcome, report: parsed.ok ? "parsed" : "notice" };
}

/**
 * Two runs that finished together may each have posted, and a run started
 * earlier may have edited the comment after this one: re-read once, keep the
 * newest run's comment (restoring this run's body if an older run wrote over
 * it) and delete every other marked copy. Best-effort: a duplicate left
 * behind is noise the next run removes, never a lost report.
 */
async function convergeOnOneComment({
  github,
  run,
  body,
  logger,
  meta,
}: {
  github: CompanionReportGitHub;
  run: CompanionReportRun;
  body: string;
  logger?: ReviewLogger;
  meta: Record<string, unknown>;
}): Promise<void> {
  try {
    const marked = await listMarked(github, run.stamp);
    const keep = newestOf(marked);
    if (keep === null) return;
    if (keep.at < run.requestedAt) {
      await github.updateIssueComment(keep.id, body);
    }
    for (const comment of marked) {
      if (comment.id !== keep.id) {
        await github.deleteIssueComment(comment.id);
      }
    }
  } catch (error) {
    logger?.warn("companion: convergence failed (a duplicate may remain)", {
      ...meta,
      error: errorMessage(error),
    });
  }
}

type Octokit = Awaited<ReturnType<typeof getOctokitForApp>>;

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404
  );
}

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
      // A Bot account with the App's login: a person whose login merely
      // equals the App's name (isBotAuthor compares without `[bot]`) never
      // counts, whatever they type.
      return comments
        .filter(
          (comment) =>
            comment.user?.type === "Bot" && isBotAuthor(comment.user.login),
        )
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
      try {
        await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: commentId,
          body,
        });
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
    async deleteIssueComment(commentId) {
      try {
        await octokit.rest.issues.deleteComment({
          owner,
          repo,
          comment_id: commentId,
        });
      } catch (error) {
        // Already gone (the other converging run deleted it first).
        if (!isNotFound(error)) throw error;
      }
    },
  };
}

const logger: ReviewLogger = {
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
        error: errorMessage(error),
      });
    }
    const outcome = await executeCompanionReport({
      github: createOctokitCompanionReportClient(octokit, stamp.repoFullName),
      run: { stamp, requestedAt: new Date(thread.createdAt).getTime() },
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
      error: errorMessage(error),
    });
  }
}
