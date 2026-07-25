import type { DB } from "@terragon/shared/db";
import { getThreadMinimal } from "@terragon/shared/model/threads";
import { buildReviewToleranceDirective } from "@terragon/review/severity-policy";
import { isReviewThread } from "./review-single-writer-finish";
import { resolveApproveFloor } from "./resolve-approve-floor";

/**
 * Compute the per-repo review-tolerance directive to inject into a review agent's
 * prompt (ADR-036), MODE-AGNOSTICALLY: this function never reads
 * `REVIEW_SINGLE_WRITER`. The directive is pure prompt guidance — it tells the
 * agent which verdict its findings imply under the repo's floor, independent of
 * WHO posts the review — so it applies to every review thread (a pull_request
 * automation) in both single-writer and direct-post modes. Extracting it here
 * keeps the mode-agnostic property structurally guaranteed and unit-testable.
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
}: {
  db: DB;
  userId: string;
  threadId: string;
}): Promise<{ directive: string; isReview: boolean }> {
  const thread = await getThreadMinimal({ db, userId, threadId });
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
