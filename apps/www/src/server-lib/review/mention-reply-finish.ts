import { z } from "zod";
import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import type { MentionLaneStamp } from "@terragon/shared";
import {
  getThreadChat,
  getThreadMinimal,
} from "@terragon/shared/model/threads";
import { getOrganizationInstallationMode } from "@terragon/shared/model/github-installation";
import { isAbandonedTerminalCause } from "@terragon/shared/model/terminal-cause";
import { effectiveShadow } from "@/lib/github-side-effects";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import { getPostHogServer } from "@/lib/posthog-server";
import {
  createFileAtCommitReader,
  createOctokitReviewClient,
  createOctokitThreadClient,
  getPrHeadState,
} from "./octokit-review-client";
import { claimThreadResolution } from "./review-thread-resolutions";
import {
  executeReviewFromIntent,
  type ReviewFromIntentOutcome,
} from "./execute-review-from-intent";
import { isBotAuthor, isPrAuthoredByBot, resolveBotLogin } from "./bot-login";
import { findLastLeadAgentText } from "./lead-text";
import { resolveApproveFloor } from "./resolve-approve-floor";
import { isMentionLaneStamp, MENTION_REPLY_KIND } from "./review-skill";
import { buildTaggedFence } from "./tagged-fence";
import {
  mentionReplyMarker,
  reviewReplyTargetId,
} from "./mention-target-reply";
import { maybePromoteSkillLastKnownGood } from "./review-single-writer-finish";

/**
 * The org-owned mention lane's terminal writer (emit-only, like the review
 * lane). The agent never posts: its final message ends with one
 *
 *   ```json mention-reply
 *   { "kind": "mention-reply", "reply": "…", "commit"?: "<sha>", "review"?: {…} }
 *   ```
 *
 * block, and at finish the control plane posts AS THE APP:
 *   - review_comment → one reply in the same review thread;
 *   - issue          → one comment on the issue / PR conversation;
 *   - `review` (PRs only) → through executeReviewFromIntent, with the repo's
 *     tolerance floor and the verify-before-block reader, BEFORE the reply,
 *     so a crash between the two is finished by a redelivered run (the reply
 *     marker below makes the whole effect idempotent);
 *   - no parseable block → one short notice reply, never silence.
 * Every reply carries the hidden marker `<!-- automata:mention-reply
 * comment=<id> -->`; an App-authored comment already carrying it means this
 * mention was answered and nothing is posted again. Only the App's own
 * comments count: anyone can type the marker into a comment of their own.
 */

export const MENTION_REPLY_NOTICE =
  "I couldn't complete this; a human should take a look.";

export { mentionReplyMarker };

const MENTION_REPLY_FENCE = buildTaggedFence(MENTION_REPLY_KIND);

const mentionReplySchema = z.object({
  kind: z.literal(MENTION_REPLY_KIND),
  reply: z.string().trim().min(1).max(60_000),
  commit: z.string().trim().min(1).optional(),
  /** The review-intent shape (verdict/commit/summary/findings); parsed by the review executor. */
  review: z.record(z.string(), z.unknown()).optional(),
});

export type MentionReply = z.infer<typeof mentionReplySchema>;

export type ParseMentionReplyResult =
  | { ok: true; value: MentionReply }
  | { ok: false; reason: string };

/** Untagged ```json fences, the fallback when the agent dropped the tag. */
const PLAIN_JSON_FENCE = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

/**
 * Parse the agent's terminal text. The LAST tagged `json mention-reply` block
 * decides; without one, the last plain ```json block whose `kind` is
 * `mention-reply` (an agent that forgot the tag still gets its reply posted).
 */
export function parseMentionReply(text: string): ParseMentionReplyResult {
  let payload: string | null = null;
  const tagged = MENTION_REPLY_FENCE.extractLast(text);
  if (tagged !== null) {
    if (!tagged.ok) return { ok: false, reason: tagged.reason };
    payload = tagged.payload;
  } else {
    for (const match of text.matchAll(PLAIN_JSON_FENCE)) {
      const candidate = match[1]?.trim() ?? "";
      if (candidate.includes(`"${MENTION_REPLY_KIND}"`)) payload = candidate;
    }
  }
  if (payload === null) {
    return { ok: false, reason: "no mention-reply block in agent output" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch (error) {
    return {
      ok: false,
      reason: `mention-reply JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = mentionReplySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `mention-reply schema validation failed: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, value: parsed.data };
}

/** The GitHub surface the writer needs, App-scoped. */
export interface MentionReplyGitHub {
  /** Bodies of the App's own issue / PR conversation comments. */
  listIssueCommentBodies(issueNumber: number): Promise<string[]>;
  createIssueComment(issueNumber: number, body: string): Promise<void>;
  /**
   * Bodies of the App's own comments in the review thread containing
   * `commentId`, or null when the thread is not found.
   */
  listReviewThreadBodies(
    prNumber: number,
    commentId: number,
  ): Promise<string[] | null>;
  replyToReviewComment(
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<void>;
}

export type MentionReplyOutcome =
  | { outcome: "posted"; review?: ReviewFromIntentOutcome["outcome"] }
  | { outcome: "notice_posted"; reason: string }
  | { outcome: "skipped_existing" }
  | { outcome: "post_failed"; failureReason: string };

interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** The reply as posted: the agent's text, the pushed commit, the marker. */
export function renderMentionReply(
  reply: MentionReply,
  commentId: number,
): string {
  const parts = [reply.reply.trim()];
  if (reply.commit && !reply.reply.includes(reply.commit.slice(0, 7))) {
    parts.push(`_Pushed \`${reply.commit}\`._`);
  }
  parts.push(mentionReplyMarker(commentId));
  return parts.join("\n\n");
}

/**
 * The pure core: decide and post. `runReview` executes an emitted review on
 * the PR (absent = the target is not a PR, the review is ignored).
 */
export async function executeMentionReply({
  github,
  stamp,
  terminalText,
  runReview,
  logger,
}: {
  github: MentionReplyGitHub;
  stamp: MentionLaneStamp;
  terminalText: string;
  runReview?: (reviewIntentText: string) => Promise<ReviewFromIntentOutcome>;
  logger?: Logger;
}): Promise<MentionReplyOutcome> {
  const marker = mentionReplyMarker(stamp.commentId);
  const meta = {
    repoFullName: stamp.repoFullName,
    number: stamp.issueOrPrNumber,
    commentId: stamp.commentId,
    kind: stamp.commentKind,
  };
  const inThread = stamp.commentKind === "review_comment";

  // Idempotency: a reply carrying this comment's marker means it was answered.
  // A failed lookup posts anyway — a rare duplicate reply is recoverable by a
  // reader, a mention left on silence is not.
  try {
    const bodies = inThread
      ? await github.listReviewThreadBodies(
          stamp.issueOrPrNumber,
          stamp.commentId,
        )
      : await github.listIssueCommentBodies(stamp.issueOrPrNumber);
    if (bodies?.some((body) => body.includes(marker))) {
      logger?.info("mention-reply: already answered; skipping", meta);
      return { outcome: "skipped_existing" };
    }
  } catch (error) {
    logger?.warn("mention-reply: marker lookup failed; posting anyway", {
      ...meta,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const parsed = parseMentionReply(terminalText);
  let reviewOutcome: ReviewFromIntentOutcome["outcome"] | undefined;
  if (parsed.ok && parsed.value.review) {
    if (stamp.isPullRequest && runReview) {
      try {
        const reviewText = `\`\`\`json\n${JSON.stringify(parsed.value.review)}\n\`\`\``;
        reviewOutcome = (await runReview(reviewText)).outcome;
      } catch (error) {
        logger?.error("mention-reply: review execution threw", {
          ...meta,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      logger?.warn(
        "mention-reply: review ignored — the mention is not on a pull request",
        meta,
      );
    }
  }

  const body = parsed.ok
    ? renderMentionReply(parsed.value, stamp.commentId)
    : `${MENTION_REPLY_NOTICE}\n\n${marker}`;
  try {
    if (inThread) {
      await github.replyToReviewComment(
        stamp.issueOrPrNumber,
        reviewReplyTargetId(stamp),
        body,
      );
    } else {
      await github.createIssueComment(stamp.issueOrPrNumber, body);
    }
  } catch (error) {
    const failureReason =
      error instanceof Error ? error.message : String(error);
    logger?.error("mention-reply: post failed", { ...meta, failureReason });
    return { outcome: "post_failed", failureReason };
  }
  if (!parsed.ok) {
    logger?.error("mention-reply: no usable block — posted the notice", {
      ...meta,
      reason: parsed.reason,
    });
    return { outcome: "notice_posted", reason: parsed.reason };
  }
  return {
    outcome: "posted",
    ...(reviewOutcome ? { review: reviewOutcome } : {}),
  };
}

type Octokit = Awaited<ReturnType<typeof getOctokitForApp>>;

/** The App-scoped implementation of {@link MentionReplyGitHub}. */
export function createOctokitMentionReplyClient(
  octokit: Octokit,
  repoFullName: string,
): MentionReplyGitHub {
  const [owner, repo] = parseRepoFullName(repoFullName);
  const threads = createOctokitThreadClient(octokit, repoFullName);
  return {
    async listIssueCommentBodies(issueNumber) {
      const comments = await octokit.paginate(
        octokit.rest.issues.listComments,
        { owner, repo, issue_number: issueNumber, per_page: 100 },
      );
      return comments
        .filter((comment) => isBotAuthor(comment.user?.login))
        .map((comment) => comment.body ?? "");
    },
    async createIssueComment(issueNumber, body) {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
    },
    async listReviewThreadBodies(prNumber, commentId) {
      const thread = await threads.findThreadByCommentId(prNumber, commentId);
      return thread
        ? thread.comments
            .filter((comment) => isBotAuthor(comment.authorLogin))
            .map((comment) => comment.body)
        : null;
    },
    replyToReviewComment: (prNumber, commentId, body) =>
      threads.replyToReviewComment(prNumber, commentId, body),
  };
}

const logger: Logger = {
  info: (message, meta) => console.log(`[mention-reply] ${message}`, meta),
  warn: (message, meta) => console.warn(`[mention-reply] ${message}`, meta),
  error: (message, meta) => console.error(`[mention-reply] ${message}`, meta),
};

/**
 * The finish-hook entry: a no-op for every thread that is not stamped by the
 * mention lane. Never throws.
 */
export async function handleMentionReplyAtFinish({
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
    if (!thread || !isMentionLaneStamp(stampMetadata)) return;
    const stamp = stampMetadata.mention;
    if (isAbandonedTerminalCause(thread.terminalCause ?? null)) {
      logger.info("abandoned run — no reply", { threadId });
      return;
    }
    const mode = await getOrganizationInstallationMode({
      db,
      organizationId: thread.organizationId ?? null,
    });
    if (effectiveShadow(mode)) {
      logger.info("[shadow] reply suppressed", { threadId });
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
        text.includes(MENTION_REPLY_KIND),
      ) ??
      findLastLeadAgentText(threadChat?.messages ?? null, () => true) ??
      "";
    const [owner, repo] = parseRepoFullName(stamp.repoFullName);
    const octokit = await getOctokitForApp({ owner, repo });
    const outcome = await executeMentionReply({
      github: createOctokitMentionReplyClient(octokit, stamp.repoFullName),
      stamp,
      terminalText,
      runReview: stamp.isPullRequest
        ? (reviewIntentText) =>
            runMentionReview({
              db,
              octokit,
              threadId,
              organizationId: thread.organizationId ?? null,
              stamp,
              reviewIntentText,
            })
        : undefined,
      logger,
    });
    getPostHogServer().capture({
      distinctId: userId,
      event: "mention_reply_outcome",
      properties: {
        threadId,
        repoFullName: stamp.repoFullName,
        number: stamp.issueOrPrNumber,
        kind: stamp.commentKind,
        ...outcome,
      },
    });
    await maybePromoteSkillLastKnownGood({
      db,
      organizationId: thread.organizationId ?? null,
      repoFullName: stamp.repoFullName,
      sourceMetadata: stampMetadata,
      outcome: outcome.outcome,
    });
  } catch (error) {
    console.error("[mention-reply] finish hook failed (non-fatal)", {
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The review a mention emitted, posted exactly as the review lane posts one. */
async function runMentionReview({
  db,
  octokit,
  threadId,
  organizationId,
  stamp,
  reviewIntentText,
}: {
  db: DB;
  octokit: Octokit;
  threadId: string;
  organizationId: string | null;
  stamp: MentionLaneStamp;
  reviewIntentText: string;
}): Promise<ReviewFromIntentOutcome> {
  const { repoFullName, issueOrPrNumber: prNumber } = stamp;
  const [
    { headSha: currentHeadSha, isDraft, authorLogin },
    approveFloorPolicy,
  ] = await Promise.all([
    getPrHeadState(octokit, repoFullName, prNumber),
    resolveApproveFloor({ db, organizationId, repoFullName }),
  ]);
  const botLogin = resolveBotLogin();
  return await executeReviewFromIntent({
    github: createOctokitReviewClient(octokit),
    repoFullName,
    prNumber,
    botLogin,
    currentHeadSha,
    terminalText: reviewIntentText,
    approveFloorPolicy,
    isDraft,
    prAuthoredByBot: isPrAuthoredByBot(authorLogin, botLogin),
    readFileAtCommit: createFileAtCommitReader(octokit, repoFullName),
    threadResolutions: {
      client: createOctokitThreadClient(octokit, repoFullName),
      claim: (commit) => claimThreadResolution(threadId, commit),
    },
    logger: {
      info: (message, meta) => logger.info(`review: ${message}`, meta),
      warn: (message, meta) => logger.warn(`review: ${message}`, meta),
      error: (message, meta) => logger.error(`review: ${message}`, meta),
    },
  });
}
