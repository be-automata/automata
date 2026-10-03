import type {
  ReviewGitHubClient,
  ReviewLogger,
} from "@terragon/review/state/review-github-client";
import { sanitizeInline } from "@/server-lib/tracker/merge-audit";

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
  | "agent_comment_without_findings";

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
}

/** Everything the single writer may do on a PR: post reviews, keep the notice. */
export type ReviewWriterClient = ReviewGitHubClient & ReviewNoticeClient;

const NOTICE_MARKER_PATTERN = /^<!-- automata:review-notice sha=([\w.-]+) -->/;
const REASON_MAX_LENGTH = 600;

function reviewNoticeMarker(sha: string): string {
  return `<!-- automata:review-notice sha=${sha} -->`;
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
  }
}

export function renderReviewNotice(args: {
  sha: string;
  cause: NoVerdictCause;
  reason: string;
}): string {
  return [
    reviewNoticeMarker(args.sha),
    `⚠️ **Automata has no verdict for commit \`${args.sha.slice(0, 7)}\`.** Nothing was approved or blocked. This is not a pass.`,
    "",
    `**Why:** ${describeCause(args.cause, args.reason)}`,
    "",
    "**Next:** push a new commit to trigger a fresh review, or have a teammate review this commit.",
  ].join("\n");
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
): Promise<Array<{ id: number; sha: string }>> {
  try {
    const comments = await target.github.listConversationComments(
      target.repoFullName,
      target.prNumber,
    );
    return comments.flatMap((comment) => {
      const sha = reviewNoticeSha(comment, target.botLogin);
      return sha ? [{ id: comment.id, sha }] : [];
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
  notices: Array<{ id: number; sha: string }>,
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
  | { result: "duplicate_at_commit"; commentId: number }
  | { result: "post_failed"; failureReason: string };

/**
 * Put the no-verdict notice for `sha` on the PR. Never throws: the no-verdict
 * path it serves cannot be allowed to turn a missing verdict into an exception.
 */
export async function publishReviewNotice(
  args: NoticeTarget & { sha: string; cause: NoVerdictCause; reason: string },
): Promise<PublishReviewNoticeResult> {
  const existing = await listOwnNotices(args, "per-commit dedup");
  const atCommit = existing.find((notice) => notice.sha === args.sha);
  if (atCommit) {
    return { result: "duplicate_at_commit", commentId: atCommit.id };
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
