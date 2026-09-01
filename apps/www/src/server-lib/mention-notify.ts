import { eq } from "drizzle-orm";
import * as schema from "@terragon/shared/db/schema";
import { ThreadErrorType } from "@terragon/shared";
import { DB } from "@terragon/shared/db";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";

/**
 * #163: when a github-mention thread's boot fails, the person who mentioned
 * the bot sees nothing on GitHub — the thread just goes terminal in the DB.
 * This posts a reply naming the failure on the thread's source PR/issue so
 * the mention isn't silently swallowed.
 *
 * Scoped to BOOT failures because startAgentMessage's boot-catch `onError`
 * is the ONLY call site of this function — not because other
 * `withThreadChat` callers avoid `onError` in general (checkpoint-thread.ts
 * passes one too; it just doesn't call this). Keep it that way: wiring this
 * into any post-boot onError would notify on failures the mention author
 * never caused.
 *
 * Fire-and-forget: callers must register this with `waitUntil` and attach
 * their own `.catch` — a failed notification must never mask the original
 * boot-error handling.
 */
export async function notifyMentionSourceOfFailure({
  db,
  threadId,
  errorType,
}: {
  db: DB;
  threadId: string;
  errorType: ThreadErrorType;
}): Promise<void> {
  try {
    const [row] = await db
      .select({
        sourceType: schema.thread.sourceType,
        sourceMetadata: schema.thread.sourceMetadata,
      })
      .from(schema.thread)
      .where(eq(schema.thread.id, threadId))
      .limit(1);

    if (!row || row.sourceType !== "github-mention") {
      return;
    }
    const sourceMetadata = row.sourceMetadata;
    if (!sourceMetadata || sourceMetadata.type !== "github-mention") {
      return;
    }
    const { repoFullName, issueOrPrNumber, commentId } = sourceMetadata;

    const [owner, repo] = parseRepoFullName(repoFullName);
    const octokit = await getOctokitForApp({ owner, repo });
    const body = `⚠️ I couldn't start on this request (\`${errorType}\`). Mention me again to retry.`;

    if (commentId) {
      try {
        await octokit.rest.pulls.createReplyForReviewComment({
          owner,
          repo,
          pull_number: issueOrPrNumber,
          comment_id: commentId,
          body,
        });
        return;
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        // Only a definitive "not a review comment" client error justifies
        // falling back to a top-level comment. Any other failure (network,
        // 5xx, auth) is ambiguous about whether the reply actually posted,
        // so stop here rather than risk a double post.
        if (status !== 404 && status !== 422) {
          throw err;
        }
      }
    }

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueOrPrNumber,
      body,
    });
  } catch (error) {
    console.error("[mention-notify] failed", { threadId, error });
  }
}
