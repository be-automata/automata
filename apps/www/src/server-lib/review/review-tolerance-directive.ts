import type { DB } from "@terragon/shared/db";
import { getThreadMinimal } from "@terragon/shared/model/threads";
import { buildReviewToleranceDirective } from "@terragon/review/severity-policy";
import { isReviewThread } from "./review-single-writer-finish";
import { resolveApproveFloor } from "./resolve-approve-floor";

/** The minimal thread fields this helper reads (a subset of getThreadMinimal). */
type ThreadForDirective = {
  automationId: string | null;
  organizationId: string | null;
  githubRepoFullName: string;
};

/**
 * Compute the per-repo review-tolerance directive to inject into a review agent's
 * prompt (ADR-036). The directive is pure prompt guidance — it tells the agent
 * which verdict its findings imply under the repo's floor, independent of the
 * (now unconditional) single-writer posting path — so it applies to every review
 * thread (a pull_request automation). Extracting it here keeps it unit-testable.
 *
 * FULLY FUNCTIONAL (the former latent-under-false gap is CLOSED): the review
 * channel is now unconditionally single-writer — the control plane parses the
 * emitted intent and posts it (with this tolerance floor applied) at thread-finish
 * for every review thread. The agent chooses the tolerance-correct verdict AND
 * that verdict reaches GitHub. See handleReviewEffectAtFinish (no longer gated on
 * the retired REVIEW_SINGLE_WRITER flag).
 *
 * Returns:
 *  - `directive`: the "\n\n---\n\n<directive>\n" block to append to the prompt,
 *    or "" when this is not a review thread (or the repo is unknown).
 *  - `isReview`: whether this is a review thread — the caller uses this to gate
 *    the SINGLE-WRITER-only concerns (permissionMode="review" + server floor).
 */
export async function computeReviewToleranceDirective({
  db,
  userId,
  threadId,
  thread: providedThread,
}: {
  db: DB;
  userId: string;
  threadId: string;
  /**
   * The already-fetched thread (getThreadMinimal result), passed by callers that
   * loaded it moments earlier (the /api/daemon/next-message route fetches it for
   * its ownership check) so this helper avoids a redundant thread read. It still
   * calls `resolveApproveFloor`, which adds one org-row PK lookup alongside the
   * existing repo-row read (both via `Promise.all`, so wall-clock stays ~flat).
   * When `thread` is omitted, the helper fetches it itself.
   */
  thread?: ThreadForDirective | null;
}): Promise<{ directive: string; isReview: boolean }> {
  const thread =
    providedThread !== undefined
      ? providedThread
      : await getThreadMinimal({ db, userId, threadId });
  const isReview = await isReviewThread({
    db,
    userId,
    automationId: thread?.automationId ?? null,
    organizationId: thread?.organizationId ?? null,
  });
  if (!isReview || !thread?.githubRepoFullName) {
    return { directive: "", isReview };
  }
  const policy = await resolveApproveFloor({
    db,
    organizationId: thread.organizationId ?? null,
    repoFullName: thread.githubRepoFullName,
  });
  return {
    directive: "\n\n---\n\n" + buildReviewToleranceDirective(policy) + "\n",
    isReview,
  };
}
