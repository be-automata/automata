import type { MentionLaneStamp } from "@terragon/shared";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";

/**
 * Where the org-owned mention lane answers a mention, shared by intake (short
 * replies), the boot-failure notifier and the finish writer. Kept free of the
 * finish writer's imports so the boot-error path stays small.
 */

/** The hidden idempotency marker of the reply to comment `commentId`. */
export function mentionReplyMarker(commentId: number): string {
  return `<!-- automata:mention-reply comment=${commentId} -->`;
}

/**
 * The comment a review-thread reply attaches to: GitHub accepts replies to a
 * thread's top-level comment only, so a mention that is itself a reply
 * answers its thread's first comment.
 */
export function reviewReplyTargetId(
  stamp: Pick<MentionLaneStamp, "commentId" | "inReplyToId">,
): number {
  return stamp.inReplyToId ?? stamp.commentId;
}

type AppOctokit = Awaited<ReturnType<typeof getOctokitForApp>>;

/**
 * Post `body` where the mention was made, as the App: in the same review
 * thread for an inline review comment, one issue / PR conversation comment
 * otherwise. Throws on a GitHub error; callers decide whether that is fatal.
 */
export async function replyToMention({
  octokit,
  stamp,
  body,
}: {
  octokit: AppOctokit;
  stamp: MentionLaneStamp;
  body: string;
}): Promise<void> {
  const [owner, repo] = parseRepoFullName(stamp.repoFullName);
  if (stamp.commentKind === "review_comment") {
    await octokit.rest.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: stamp.issueOrPrNumber,
      comment_id: reviewReplyTargetId(stamp),
      body,
    });
    return;
  }
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: stamp.issueOrPrNumber,
    body,
  });
}
