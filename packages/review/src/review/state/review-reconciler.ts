/**
 * Post-run review reconciler (ADR-036 — INTERIM verdict-aware idempotency).
 *
 * The durable ADR-036 guarantee is a single-writer effect channel: the agent
 * cannot post (no Bash), it emits a verdict, and exactly one executor posts once
 * after checking GitHub — so "posted twice" is structurally impossible. That
 * channel is review-package phase-2 (deferred). Until it lands, the agent posts
 * reviews directly via `gh`, with no idempotency — a retry / dual-path can leave
 * two non-dismissed bot reviews on a PR (parity S1). This reconciler runs AFTER
 * the agent's run terminates and converges GitHub state to the no-dup invariant:
 * at most one non-dismissed bot review, reflecting the latest verdict.
 *
 * Pure decision (GitHub-state in → dismiss-set out). GitHub I/O + dismissal live
 * in the control-plane caller (dismiss needs App creds, which must stay off the
 * customer box — ADR-002). Idempotent: re-running on the converged state is a
 * no-op (dismissed reviews report state `DISMISSED`, excluded from `actionable`).
 *
 * COMMENTED reviews are NEVER dismissed (GitHub 422s on dismissing them) — they
 * are counted and skipped.
 */

/** The minimal GitHub review shape the reconciler needs (maps from listReviews). */
export interface ReconcilableReview {
  id: number;
  /** review.user.login — the reconciler matches the bot by this. */
  login: string;
  /** review.state: APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING. */
  state: string;
  /** review.commit_id — the commit the verdict was rendered against. */
  commitId: string;
  /** review.submitted_at (ISO). Ordering key for earliest/latest. */
  submittedAt: string;
}

export interface ReviewDismissal {
  id: number;
  reason: string;
}

export interface ReviewReconciliation {
  /** The one review to keep (null when there is nothing actionable). */
  keepId: number | null;
  /** Reviews to dismiss (empty when already converged). */
  toDismiss: ReviewDismissal[];
  /** COMMENTED bot reviews skipped (can't be dismissed) — telemetry. */
  commentedSkipped: number;
  /** Non-dismissed bot APPROVED/CHANGES_REQUESTED reviews considered. */
  actionableCount: number;
}

const ACTIONABLE_STATES = new Set(["APPROVED", "CHANGES_REQUESTED"]);
const DUPLICATE_REASON = (keeperId: number) =>
  `Duplicate of review ${keeperId} — auto-reconciled`;
const SUPERSEDE_REASON = "Superseded — bot verdict updated for this commit.";

function bySubmittedAtAsc(
  a: ReconcilableReview,
  b: ReconcilableReview,
): number {
  return a.submittedAt < b.submittedAt
    ? -1
    : a.submittedAt > b.submittedAt
      ? 1
      : 0;
}

/**
 * Decide which of the bot's reviews to keep and which to dismiss.
 *
 * The KEEPER is the earliest review matching the (commit, verdict) of the NEWEST
 * bot decision — so the surviving review is the current verdict at the current
 * commit, and when the same (commit, verdict) was posted twice we keep the one
 * reviewers/branch-protection saw first. Everything else is dismissed: a same
 * (commit, verdict) extra as a DUPLICATE, a different verdict/older commit as
 * SUPERSEDED (ADR-036 supersede-dismiss).
 */
export function reconcileReviews({
  reviews,
  botLogin,
}: {
  reviews: ReconcilableReview[];
  botLogin: string;
}): ReviewReconciliation {
  const bot = reviews.filter((r) => r.login === botLogin);
  const commentedSkipped = bot.filter((r) => r.state === "COMMENTED").length;
  const actionable = bot.filter((r) => ACTIONABLE_STATES.has(r.state));

  if (actionable.length <= 1) {
    return {
      keepId: actionable[0]?.id ?? null,
      toDismiss: [],
      commentedSkipped,
      actionableCount: actionable.length,
    };
  }

  // Newest bot decision defines the surviving (commit, verdict).
  const newest = [...actionable].sort(bySubmittedAtAsc).at(-1)!;
  const keeper = actionable
    .filter((r) => r.commitId === newest.commitId && r.state === newest.state)
    .sort(bySubmittedAtAsc)[0]!;

  const toDismiss: ReviewDismissal[] = actionable
    .filter((r) => r.id !== keeper.id)
    .map((r) => ({
      id: r.id,
      reason:
        r.commitId === keeper.commitId && r.state === keeper.state
          ? DUPLICATE_REASON(keeper.id)
          : SUPERSEDE_REASON,
    }));

  return {
    keepId: keeper.id,
    toDismiss,
    commentedSkipped,
    actionableCount: actionable.length,
  };
}
