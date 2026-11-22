import { desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import type { MentionLaneStamp } from "@terragon/shared";
import {
  thread as threadTable,
  threadChat as threadChatTable,
} from "@terragon/shared/db/schema";
import {
  getThreadChat,
  getThreadMinimal,
} from "@terragon/shared/model/threads";
import { getOrganizationInstallationMode } from "@terragon/shared/model/github-installation";
import {
  isMentionSilentTerminalCause,
  isTerminalCause,
  type TerminalCause,
} from "@terragon/shared/model/terminal-cause";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import { assertNever } from "@terragon/shared/utils";
import type { ReviewLogger } from "@terragon/review/state/review-github-client";
import { effectiveShadow } from "@/lib/github-side-effects";
import {
  describeProviderUnavailable,
  providerUnavailableOfChat,
  providerUnavailableRetryWhen,
  type ProviderUnavailable,
} from "@/agent/msg/classify-provider-result";
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
import {
  buildTaggedFence,
  parseTaggedJsonBlock,
  type ParseTaggedJsonResult,
} from "./tagged-fence";
import {
  mentionReplyMarker,
  reviewReplyTargetId,
} from "./mention-target-reply";
import { maybePromoteSkillLastKnownGood } from "./review-single-writer-finish";
import { DELIVERY_LABEL } from "@/server-lib/delivery/delivery-effects";
import type { RemoteTaskPrOutcome } from "@/server-lib/task/remote-task-pr";
import type { MentionTerminalTarget } from "./mention-terminal-reply";

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
 *   - no parseable block → one short notice reply, never silence; a run the
 *     provider refused (#441/#472) names that cause instead, and so does a run
 *     that ended on a typed terminal cause (#668).
 * Every reply carries the hidden marker `<!-- automata:mention-reply
 * comment=<id> -->`; an App-authored comment already carrying it means this
 * mention was answered and nothing is posted again. Only the App's own
 * comments count: anyone can type the marker into a comment of their own.
 */

export const MENTION_REPLY_NOTICE =
  "I couldn't complete this; a human should take a look.";

/**
 * The reply for a run the provider refused (#472): the generic "couldn't
 * complete" would read as the agent failing at the task. Built from the
 * classification alone, so it never names the account (epic #440 decision 5).
 */
export function renderMentionProviderNotice(
  provider: ProviderUnavailable,
): string {
  return `Nothing was changed: ${describeProviderUnavailable(provider)} Mention me again ${providerUnavailableRetryWhen(provider)}.`;
}

/**
 * #668: the reply for a mention whose run ended on a typed terminal cause
 * (worker terminal, supersede sweep, stalled watchdog) instead of a daemon
 * finish. Says what happened in the commenter's terms; it never claims that
 * nothing was pushed, because a run that timed out may already have pushed.
 */
export function renderMentionTerminalNotice(
  cause: TerminalCause,
  options: { continuationLimitReached?: boolean } = {},
): string {
  // #743: the one automatic continuation per thread is spent, so say so
  // instead of letting the commenter wait for a run that will not come.
  const limit =
    cause === "timeout" && options.continuationLimitReached
      ? ", and the limit of one automatic continuation per thread was already used"
      : "";
  return `I couldn't finish this: ${describeMentionTerminal(cause)}${limit}. Mention me again to retry.`;
}

function describeMentionTerminal(cause: TerminalCause): string {
  switch (cause) {
    case "timeout":
      return "the run hit its time limit before it could answer";
    case "daemon-failed":
      return "the agent failed before it could answer";
    case "publish-failed":
      return "my answer could not be posted";
    case "plane-offline":
      return "the run never started on the execution plane";
    case "run-failed-unreported":
      return "the run failed before it could report back";
    case "out-of-memory":
      return "the run ran out of memory";
    case "superseded":
    case "discarded":
    case "stale-skipped":
    case "user-cancelled":
      return "the run was stopped";
    default:
      return assertNever(cause);
  }
}

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

export type ParseMentionReplyResult = ParseTaggedJsonResult<MentionReply>;

/**
 * Parse the agent's terminal text. The LAST tagged `json mention-reply` block
 * decides; without one, the last plain ```json block whose `kind` is
 * `mention-reply` (an agent that forgot the tag still gets its reply posted).
 */
export function parseMentionReply(text: string): ParseMentionReplyResult {
  return parseTaggedJsonBlock(text, MENTION_REPLY_FENCE, mentionReplySchema);
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

type Logger = ReviewLogger;

/** How long a reply waits for the pull request the same finish is opening. */
export const PR_OUTCOME_WAIT_MS = 20_000;

const DELIVERY_HINT = `For the full delivery pipeline (spec, gated implementation and the fix loop), add the \`${DELIVERY_LABEL}\` label to this issue.`;

/**
 * The line a reply carries about the pull request the finish opened for an
 * issue mention, or null when there is nothing to say (other skips, an error,
 * no outcome: those are logged). The URL is built from the stamp's repo.
 */
export function renderPullRequestLine(
  repoFullName: string,
  outcome: RemoteTaskPrOutcome | null | undefined,
): string | null {
  if (!outcome) return null;
  if (outcome.status === "skipped") {
    switch (outcome.reason) {
      case "auto_create_off":
        return "_No pull request was opened: automatic pull requests are turned off in the task owner's settings._";
      case "no_changes":
      case "no_branch":
        return "_No pull request was opened: no changes were pushed._";
      default:
        return null;
    }
  }
  const url = `https://github.com/${repoFullName}/pull/${outcome.prNumber}`;
  return outcome.status === "opened"
    ? `Opened a draft pull request: ${url}`
    : `Updated the open pull request: ${url}`;
}

/** The lines between the reply text and the marker; issue mentions only. */
export function mentionReplyExtras(
  stamp: MentionLaneStamp,
  pullRequest: RemoteTaskPrOutcome | null | undefined,
): string[] {
  if (stamp.isPullRequest) return [];
  return [
    renderPullRequestLine(stamp.repoFullName, pullRequest),
    stamp.asksForDelivery ? DELIVERY_HINT : null,
  ].filter((line): line is string => line !== null);
}

/**
 * The reply as posted: the agent's text, the pushed commit, then any extra
 * lines (the pull request outcome, the delivery hint), then the marker.
 */
export function renderMentionReply(
  reply: MentionReply,
  commentId: number,
  extras: readonly string[] = [],
): string {
  const parts = [reply.reply.trim()];
  if (reply.commit && !reply.reply.includes(reply.commit.slice(0, 7))) {
    parts.push(`_Pushed \`${reply.commit}\`._`);
  }
  return joinReply(parts, extras, commentId);
}

/** The one shape of every reply: text parts, extra lines, then the marker. */
function joinReply(
  parts: readonly string[],
  extras: readonly string[],
  commentId: number,
): string {
  return [...parts, ...extras, mentionReplyMarker(commentId)].join("\n\n");
}

/**
 * Waits for the finish's pull request outcome, never longer than `waitMs`.
 * The promise never rejects (handleThreadFinish guarantees it); a timeout
 * resolves null (no PR line) and logs `reason=pr_outcome_timeout`.
 */
export async function awaitPullRequestOutcome(
  promise: Promise<RemoteTaskPrOutcome | null>,
  meta: Record<string, unknown>,
  waitMs: number = PR_OUTCOME_WAIT_MS,
): Promise<RemoteTaskPrOutcome | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger.warn("pull request outcome not ready; replying without it", {
        ...meta,
        reason: "pr_outcome_timeout",
      });
      resolve(null);
    }, waitMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
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
  providerUnavailable,
  terminalCause,
  continuationLimitReached,
  pullRequest,
  logger,
}: {
  github: MentionReplyGitHub;
  stamp: MentionLaneStamp;
  terminalText: string;
  runReview?: (reviewIntentText: string) => Promise<ReviewFromIntentOutcome>;
  /**
   * The run's provider classification (`provider-unavailable`). Consulted
   * only when no reply parsed: a parsed reply is always posted as is.
   */
  providerUnavailable?: ProviderUnavailable | null;
  /**
   * #668: the cause a typed terminal wrote, when the run ended without a
   * daemon finish. Consulted only when no reply parsed and the provider did
   * not refuse the run.
   */
  terminalCause?: TerminalCause | null;
  /** #743: the timed-out run's one automatic continuation was already spent. */
  continuationLimitReached?: boolean;
  /**
   * An issue mention's finish opened (or skipped) a pull request: the reply
   * says which. Null or absent adds no line. Ignored on a PR mention.
   */
  pullRequest?: RemoteTaskPrOutcome | null;
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

  const provider = parsed.ok ? null : (providerUnavailable ?? null);
  const cause = parsed.ok || provider ? null : (terminalCause ?? null);
  const extras = mentionReplyExtras(stamp, pullRequest);
  const noticeText = provider
    ? renderMentionProviderNotice(provider)
    : cause
      ? renderMentionTerminalNotice(cause, { continuationLimitReached })
      : MENTION_REPLY_NOTICE;
  const body = parsed.ok
    ? renderMentionReply(parsed.value, stamp.commentId, extras)
    : joinReply([noticeText], extras, stamp.commentId);
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
    const reason = provider
      ? `provider_unavailable: ${provider.kind}`
      : cause
        ? `terminal: ${cause}`
        : parsed.reason;
    logger?.error("mention-reply: no usable block — posted the notice", {
      ...meta,
      reason,
    });
    return { outcome: "notice_posted", reason };
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
  remotePullRequest,
  continuationLimitReached,
}: {
  db: DB;
  userId: string;
  threadId: string;
  /**
   * The chat the daemon event named. Null from a typed-terminal path (#668),
   * which knows only the thread: the chat is resolved from the thread.
   */
  threadChatId: string | null;
  /**
   * The finish's pull request open, when one was attempted (never rejects).
   * An issue mention waits for it (bounded) so its reply can link the PR; a
   * PR mention and the typed-terminal entry pass none.
   */
  remotePullRequest?: Promise<RemoteTaskPrOutcome | null>;
  /** #743: the typed terminal found the continuation budget spent. */
  continuationLimitReached?: boolean;
}): Promise<void> {
  try {
    if (!env.GITHUB_SIDE_EFFECTS_ENABLED) return;
    const thread = await getThreadMinimal({ db, userId, threadId });
    const stampMetadata = thread?.sourceMetadata;
    if (!thread || !isMentionLaneStamp(stampMetadata)) return;
    const stamp = stampMetadata.mention;
    const rawCause = thread.terminalCause ?? null;
    if (isMentionSilentTerminalCause(rawCause)) {
      logger.info("stopped run — no reply", { threadId, cause: rawCause });
      return;
    }
    const terminalCause =
      rawCause !== null && isTerminalCause(rawCause) ? rawCause : null;
    const mode = await getOrganizationInstallationMode({
      db,
      organizationId: thread.organizationId ?? null,
    });
    if (effectiveShadow(mode)) {
      logger.info("[shadow] reply suppressed", { threadId });
      return;
    }
    const [owner, repo] = parseRepoFullName(stamp.repoFullName);
    // The chat read and the App client run first; the PR open is already in
    // flight, so only the bounded wait starts after them. A failure of either
    // then ends the reply before any wait (no stray timeout log).
    const [threadChat, octokit] = await Promise.all([
      readThreadChat({
        db,
        userId,
        threadId,
        version: thread.version,
        threadChatId,
      }),
      getOctokitForApp({ owner, repo }),
    ]);
    const pullRequest =
      remotePullRequest && !stamp.isPullRequest
        ? await awaitPullRequestOutcome(remotePullRequest, { threadId })
        : null;
    const terminalText =
      findLastLeadAgentText(threadChat?.messages ?? null, (text) =>
        text.includes(MENTION_REPLY_KIND),
      ) ??
      findLastLeadAgentText(threadChat?.messages ?? null, () => true) ??
      "";
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
      providerUnavailable: providerUnavailableOfChat(threadChat),
      terminalCause,
      continuationLimitReached,
      pullRequest,
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

/** The finished chat: the one the event named, else resolved from the thread. */
async function readThreadChat({
  db,
  userId,
  threadId,
  version,
  threadChatId,
}: {
  db: DB;
  userId: string;
  threadId: string;
  version: number;
  threadChatId: string | null;
}) {
  const chatId =
    threadChatId ?? (await resolveThreadChatId({ db, threadId, version }));
  return chatId === null
    ? undefined
    : await getThreadChat({ db, threadId, threadChatId: chatId, userId });
}

/**
 * The chat a typed-terminal path reads when its caller did not name one (the
 * sweeps know only the thread): a v0 thread keeps its chat on the thread row;
 * for a v1 thread, the chat the terminal moved — markThreadsTerminal stamps
 * its `terminalCause` mirror (#153) — and, failing that, the chat written
 * last. Null when a v1 thread has no chat row.
 */
async function resolveThreadChatId({
  db,
  threadId,
  version,
}: {
  db: DB;
  threadId: string;
  version: number;
}): Promise<string | null> {
  if (version === 0) return LEGACY_THREAD_CHAT_ID;
  const [first] = await db
    .select({ id: threadChatTable.id })
    .from(threadChatTable)
    .where(eq(threadChatTable.threadId, threadId))
    .orderBy(
      sql`${threadChatTable.terminalCause} IS NULL`,
      desc(threadChatTable.updatedAt),
    )
    .limit(1);
  return first?.id ?? null;
}

/**
 * #668: the typed-terminal entry. A thread ended by the worker's terminal
 * post, the supersede sweep or the stalled watchdog never reaches the daemon
 * finish, so its mention would stay unanswered forever. Callers pass ONLY the
 * ids their write actually moved; every non-mention thread is skipped here
 * with no GitHub call. Never throws (the finish entry never does).
 */
export async function handleMentionRepliesAtTerminal({
  db,
  targets,
}: {
  db: DB;
  targets: readonly MentionTerminalTarget[];
}): Promise<void> {
  if (targets.length === 0) return;
  const threadIds = targets.map((t) => t.threadId);
  let rows;
  try {
    rows = await db
      .select({
        id: threadTable.id,
        userId: threadTable.userId,
        sourceMetadata: threadTable.sourceMetadata,
      })
      .from(threadTable)
      .where(inArray(threadTable.id, threadIds));
  } catch (error) {
    logger.error("terminal: thread read failed", {
      threadIds,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  for (const row of rows) {
    if (!isMentionLaneStamp(row.sourceMetadata)) continue;
    const target = targets.find((t) => t.threadId === row.id);
    await handleMentionReplyAtFinish({
      db,
      userId: row.userId,
      threadId: row.id,
      threadChatId: target?.threadChatId ?? null,
      continuationLimitReached: target?.continuationLimitReached,
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
    // The draft state the mention's prompt stated (#504).
    draftAtDispatch: stamp.isDraft,
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
