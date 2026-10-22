import type {
  ReviewGitHubClient,
  ReviewLogger,
} from "@terragon/review/state/review-github-client";
import { sanitizeInline } from "@/server-lib/tracker/merge-audit";
import {
  describeProviderUnavailable,
  providerUnavailableRetryWhen,
  type ProviderUnavailable,
} from "@/agent/msg/classify-provider-result";

/**
 * The no-verdict notice (ADR-009). A review run that produced NO verdict — the
 * intent could not be parsed, the agent reported it could not review, or the
 * agent left a bare note — must never appear on the PR as a REVIEW: a COMMENTED
 * review reads as "the bot reviewed this" to the author, to branch protection
 * tooling and to our own guards, and it is the one review state GitHub cannot
 * take back. The run's silence is reported as a marked comment in the PR
 * conversation instead, and the PR's review state stays truthfully empty.
 *
 * Invariants:
 *  - AT MOST ONE LIVE NOTICE PER PR, about the newest commit that got no
 *    verdict. A notice for a new commit replaces the previous one.
 *  - AT MOST ONE NOTICE PER COMMIT (#220's key, kept): a re-driven thread that
 *    re-reads the same silent run adds nothing.
 *  - A VERDICT RETIRES THE NOTICE: once a real review posts at HEAD the notice
 *    is deleted, so a PR never shows "no verdict" next to a verdict.
 *  - A PROVIDER CAUSE CORRECTS THE NOTICE IN PLACE (#441), ONE WAY ONLY: the
 *    notice at a commit is edited, never duplicated, when the cause being
 *    reported OUTRANKS the one it shows (`noticeRank`: generic < a usage
 *    limit with an unknown reset < a later reset < an indefinite cause). A
 *    lower or equal rank is a duplicate, so two threads at one commit (the
 *    hourly sweep re-reads every terminal one) converge on the highest rank
 *    instead of flipping the comment back and forth. Generic causes among
 *    themselves still dedupe on the commit alone (#220).
 */

export type NoVerdictCause =
  /** The control plane could not read a verdict out of the run's output. */
  | "unparseable"
  /** The agent emitted `unable_to_review` — it knows it could not review. */
  | "agent_unable"
  /**
   * The agent chose `comment` with no findings on a PR that is ready for
   * review. Under the skill contract that is "could not reach a verdict", and
   * it is enforced here so the guarantee does not depend on which skill body a
   * repo happens to run.
   */
  | "agent_comment_without_findings"
  /**
   * The provider refused the run (#441): the connected Claude subscription hit
   * a usage limit, its organization disabled Claude Code access, or the API
   * credit ran out. The classification travels as `provider`.
   */
  | "provider_unavailable"
  /**
   * #446: the queued review was retired at dequeue without running (its PR
   * closed while it waited, or it waited longer than the queue allows).
   */
  | "queue_retired"
  /**
   * #107: the run FAILED before the agent produced a verdict (an infra
   * failure: the worker reported an error, or the run died before the agent
   * spoke). Posted only once the automatic re-runs are spent; `reason` is the
   * run's own error text when it recorded one.
   */
  | "run_failed";

/** A comment in the PR conversation (the GitHub issue-comment surface). */
export interface PrConversationComment {
  id: number;
  user: { login: string } | null;
  body: string;
}

/** The conversation-comment surface the notice needs, App-scoped like the rest. */
export interface ReviewNoticeClient {
  listConversationComments(
    repo: string,
    prNumber: number,
  ): Promise<PrConversationComment[]>;
  createConversationComment(
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<void>;
  deleteConversationComment(repo: string, commentId: number): Promise<void>;
  updateConversationComment(
    repo: string,
    commentId: number,
    body: string,
  ): Promise<void>;
}

/** Everything the single writer may do on a PR: post reviews, keep the notice. */
export type ReviewWriterClient = ReviewGitHubClient & ReviewNoticeClient;

const NOTICE_MARKER_PATTERN = /^<!-- automata:review-notice sha=([\w.-]+) -->/;
/**
 * A provider notice's SECOND line (#441). The first line stays the original
 * marker, byte for byte, so every notice already on a PR parses and a
 * rolled-back revision still dedupes and retires a provider notice.
 */
const PROVIDER_MARKER_PATTERN =
  /^<!-- automata:review-notice-cause provider_unavailable until=(\d+|unknown|never) -->$/;
const REASON_MAX_LENGTH = 600;
/** A provider notice whose classification did not travel: an unknown limit. */
const DEFAULT_PROVIDER: ProviderUnavailable = { kind: "usage_limit" };

function reviewNoticeMarker(sha: string): string {
  return `<!-- automata:review-notice sha=${sha} -->`;
}

/** When the provider cause ends: epoch ms, "unknown", or "never" on its own. */
function providerUntil(provider: ProviderUnavailable): string {
  if (provider.kind !== "usage_limit") return "never";
  return provider.resetsAt === undefined
    ? "unknown"
    : String(Math.trunc(provider.resetsAt));
}

function providerMarker(provider: ProviderUnavailable): string {
  return `<!-- automata:review-notice-cause provider_unavailable until=${providerUntil(provider)} -->`;
}

/**
 * The order a same-commit notice may be corrected in: only a strictly higher
 * rank edits. Monotonic, so concurrent or repeated writers converge.
 */
function rankOfUntil(until: string | undefined): number {
  if (until === undefined) return 0; // a generic notice
  if (until === "unknown") return 1;
  if (until === "never") return Number.POSITIVE_INFINITY;
  return Number(until);
}

function noticeRank(
  cause: NoVerdictCause,
  provider?: ProviderUnavailable,
): number {
  return cause === "provider_unavailable"
    ? rankOfUntil(providerUntil(provider ?? DEFAULT_PROVIDER))
    : 0;
}

/**
 * The commit a notice is about, or null when the comment is not one of ours.
 * The marker is matched as a PREFIX and the author is checked: anyone can paste
 * the marker into their own comment, and a quoted marker mid-body is not a
 * notice (the same two lessons `isDegradedComment` and the audit comment paid
 * for).
 */
export function reviewNoticeSha(
  comment: PrConversationComment,
  botLogin: string,
): string | null {
  if (comment.user?.login !== botLogin) return null;
  return NOTICE_MARKER_PATTERN.exec(comment.body)?.[1] ?? null;
}

function describeCause(cause: NoVerdictCause, reason: string): string {
  const detail = sanitizeInline(reason, REASON_MAX_LENGTH);
  switch (cause) {
    case "unparseable":
      return `the review run ended without a verdict that could be read (${detail}).`;
    case "agent_unable":
      return `the review agent reported that it could not review this commit: ${detail}`;
    case "agent_comment_without_findings":
      return `the review agent left a note instead of a verdict: ${detail}`;
    case "provider_unavailable":
      // Rendered by renderReviewNotice's own branch; kept for exhaustiveness.
      return "the Claude provider refused the run.";
    case "queue_retired":
      return `this review was retired from the queue without running: ${detail}`;
    case "run_failed":
      return detail.length > 0
        ? `the review run failed before the agent produced a verdict: ${detail}`
        : "the review run failed before the agent produced a verdict.";
  }
}

function describeReruns(reruns: number | undefined): string | null {
  if (!reruns || reruns <= 0) return null;
  return `Automata re-ran the review automatically ${reruns === 1 ? "once" : `${reruns} times`}; no run produced a verdict.`;
}

export function renderReviewNotice(args: {
  sha: string;
  cause: NoVerdictCause;
  reason: string;
  /** The classification, read only for `provider_unavailable`. */
  provider?: ProviderUnavailable;
  /** #107: how many automatic re-runs this commit already had. */
  reruns?: number;
  /**
   * #107: the run's thread id, the key that joins the notice to the worker
   * logs and the stored messages. Absent = no Run line (callers that predate it).
   */
  threadId?: string;
}): string {
  const runLine = args.threadId ? ["", `**Run:** \`${args.threadId}\``] : [];
  if (args.cause === "provider_unavailable") {
    // Never names the account (epic #440 decision 5): the text is built from
    // the classification alone, never from credential metadata.
    const provider = args.provider ?? DEFAULT_PROVIDER;
    return [
      reviewNoticeMarker(args.sha),
      providerMarker(provider),
      `⚠️ **Automata has no verdict for commit \`${args.sha.slice(0, 7)}\`.** ${describeProviderUnavailable(provider)} Nothing was approved or blocked.`,
      "",
      `**Next:** push a new commit ${providerUnavailableRetryWhen(provider)}, or have a teammate review.`,
      ...runLine,
    ].join("\n");
  }
  return [
    reviewNoticeMarker(args.sha),
    `⚠️ **Automata has no verdict for commit \`${args.sha.slice(0, 7)}\`.** Nothing was approved or blocked. This is not a pass.`,
    "",
    `**Why:** ${[describeCause(args.cause, args.reason), describeReruns(args.reruns)].filter((part) => part !== null).join(" ")}`,
    "",
    "**Next:** push a new commit to trigger a fresh review, or have a teammate review this commit.",
    ...runLine,
  ].join("\n");
}

interface OwnNotice {
  id: number;
  sha: string;
  /** `noticeRank` of what the comment shows (0 for a generic notice). */
  rank: number;
}

interface NoticeTarget {
  github: ReviewNoticeClient;
  repoFullName: string;
  prNumber: number;
  botLogin: string;
  logger?: ReviewLogger;
}

/**
 * Our notices on the PR. LOOKUP FAILED → EMPTY → callers proceed as if there
 * were none, the posture this lane takes everywhere: a duplicate notice is
 * recoverable by a reader, a lost one is not.
 */
async function listOwnNotices(
  target: NoticeTarget,
  purpose: string,
): Promise<OwnNotice[]> {
  try {
    const comments = await target.github.listConversationComments(
      target.repoFullName,
      target.prNumber,
    );
    return comments.flatMap((comment) => {
      const sha = reviewNoticeSha(comment, target.botLogin);
      if (!sha) return [];
      const until = PROVIDER_MARKER_PATTERN.exec(
        comment.body.split("\n", 2)[1] ?? "",
      )?.[1];
      return [{ id: comment.id, sha, rank: rankOfUntil(until) }];
    });
  } catch (err) {
    target.logger?.warn(`review-notice: comment lookup failed (${purpose})`, {
      repoFullName: target.repoFullName,
      prNumber: target.prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function deleteNotices(
  target: NoticeTarget,
  notices: OwnNotice[],
): Promise<void> {
  for (const notice of notices) {
    try {
      await target.github.deleteConversationComment(
        target.repoFullName,
        notice.id,
      );
    } catch (err) {
      // Best-effort: a notice left behind is noise, never a lost verdict.
      target.logger?.warn("review-notice: could not delete a notice", {
        repoFullName: target.repoFullName,
        prNumber: target.prNumber,
        commentId: notice.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export type PublishReviewNoticeResult =
  | { result: "posted" }
  | { result: "updated"; commentId: number }
  | { result: "duplicate_at_commit"; commentId: number }
  | { result: "post_failed"; failureReason: string };

/**
 * Put the no-verdict notice for `sha` on the PR. Never throws: the no-verdict
 * path it serves cannot be allowed to turn a missing verdict into an exception.
 */
export async function publishReviewNotice(
  args: NoticeTarget & {
    sha: string;
    cause: NoVerdictCause;
    reason: string;
    provider?: ProviderUnavailable;
    reruns?: number;
    threadId?: string;
  },
): Promise<PublishReviewNoticeResult> {
  const existing = await listOwnNotices(args, "per-commit dedup");
  const atCommit = existing.find((notice) => notice.sha === args.sha);
  if (atCommit) {
    // One notice per commit (#220): only a cause that outranks the one shown
    // corrects it, so writers never undo each other.
    if (noticeRank(args.cause, args.provider) <= atCommit.rank) {
      return { result: "duplicate_at_commit", commentId: atCommit.id };
    }
    try {
      await args.github.updateConversationComment(
        args.repoFullName,
        atCommit.id,
        renderReviewNotice(args),
      );
    } catch (err) {
      return {
        result: "post_failed",
        failureReason: err instanceof Error ? err.message : String(err),
      };
    }
    await deleteNotices(
      args,
      existing.filter((notice) => notice.id !== atCommit.id),
    );
    return { result: "updated", commentId: atCommit.id };
  }

  try {
    await args.github.createConversationComment(
      args.repoFullName,
      args.prNumber,
      renderReviewNotice(args),
    );
  } catch (err) {
    return {
      result: "post_failed",
      failureReason: err instanceof Error ? err.message : String(err),
    };
  }
  // Created FIRST, older ones removed AFTER: a failure in between leaves two
  // notices, never zero.
  await deleteNotices(args, existing);
  return { result: "posted" };
}

/** A verdict landed at HEAD: retire every notice on the PR. Never throws. */
export async function retireReviewNotices(target: NoticeTarget): Promise<void> {
  await deleteNotices(
    target,
    await listOwnNotices(target, "retiring after a verdict"),
  );
}
