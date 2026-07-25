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
 * prompt (ADR-036), MODE-AGNOSTICALLY: this function never reads
 * `REVIEW_SINGLE_WRITER`. The directive is pure prompt guidance — it tells the
 * agent which verdict its findings imply under the repo's floor, independent of
 * WHO posts the review — so it applies to every review thread (a pull_request
 * automation) regardless of REVIEW_SINGLE_WRITER. Extracting it here keeps the
 * mode-agnostic property structurally guaranteed and unit-testable.
 *
 * LATENT-UNDER-FALSE (honest caveat): with REVIEW_SINGLE_WRITER=false the review
 * *posting* path is currently unwired — the deployed review skill is emit-only
 * (it cannot `gh` post) and the flag-off finish hook runs only reconcilePrReviews
 * (a dedup of already-posted reviews), which never parses the emitted intent. So
 * under `false` the agent CHOOSES the tolerance-correct verdict (this directive
 * works) but that verdict never reaches GitHub until false-mode posting is wired.
 * The directive is therefore correct-but-latent under `false`, fully functional
 * under `true` (prod). It is injected in both modes so the tolerance is correct
 * the day the flag is dialed — do NOT describe it as "posts under false".
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
   * its ownership check) so the always-on directive adds ZERO extra reads. When
   * omitted, the helper fetches it itself.
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
