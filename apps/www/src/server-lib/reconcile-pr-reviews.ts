import { env } from "@terragon/env/apps-www";
import {
  reconcileReviews,
  type ReconcilableReview,
} from "@terragon/review/state/review-reconciler";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";

/**
 * Post-run review reconciler (ADR-036 INTERIM — see review-reconciler.ts). After a
 * review-producing thread reaches terminal, converge the PR's bot reviews to the
 * no-dup invariant: at most one non-dismissed bot review, reflecting the latest
 * verdict. The pure decision lives in packages/review; this is the control-plane
 * I/O half — it lists reviews and dismisses with APP credentials (dismiss rights
 * must stay on the control plane, never the customer box — ADR-002).
 *
 * FAIL-SOFT: any error is logged loudly but never thrown — a reconciler failure
 * must never fail the thread (the caller also waitUntil-wraps it).
 * IDEMPOTENT: re-running on the converged state dismisses nothing.
 */

/** The App bot's review author login (the GitHub `[bot]` login). */
function resolveBotLogin(): string {
  const explicit = env.GITHUB_BOT_LOGIN.trim();
  if (explicit) {
    return explicit;
  }
  return `${env.NEXT_PUBLIC_GITHUB_APP_NAME}[bot]`;
}

export async function reconcilePrReviews({
  repoFullName,
  prNumber,
}: {
  repoFullName: string;
  prNumber: number;
}): Promise<{ dupReconciled: number } | null> {
  // Defense-in-depth: never mutate GitHub when the deployment kill-switch is off.
  // (A shadow thread never boots the agent, so it can't reach thread-finish; this
  // guards the global switch regardless.)
  if (!env.GITHUB_SIDE_EFFECTS_ENABLED) {
    return null;
  }

  const botLogin = resolveBotLogin();
  if (!botLogin || botLogin === "[bot]") {
    console.warn("[review-reconciler] no bot login configured — skipping", {
      repoFullName,
      prNumber,
    });
    return null;
  }

  try {
    const [owner, repo] = parseRepoFullName(repoFullName);
    // APP octokit specifically: dismiss as the bot/app, never the operator's user
    // token (getOctokitForBackground would prefer the user) — control-plane creds.
    const octokit = await getOctokitForApp({ owner, repo });

    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    const mapped: ReconcilableReview[] = reviews.map((r) => ({
      id: r.id,
      login: r.user?.login ?? "",
      state: r.state,
      commitId: r.commit_id ?? "",
      submittedAt: r.submitted_at ?? "",
    }));

    const decision = reconcileReviews({ reviews: mapped, botLogin });

    if (decision.toDismiss.length === 0) {
      // Converged (or a single review) — nothing to do. Log only when there was a
      // COMMENTED bot review skipped, to keep the happy path quiet.
      if (decision.commentedSkipped > 0) {
        console.log("[review-reconciler] no dismissals; commented skipped", {
          repoFullName,
          prNumber,
          commentedSkipped: decision.commentedSkipped,
        });
      }
      return { dupReconciled: 0 };
    }

    let dismissed = 0;
    for (const target of decision.toDismiss) {
      try {
        await octokit.rest.pulls.dismissReview({
          owner,
          repo,
          pull_number: prNumber,
          review_id: target.id,
          message: target.reason,
        });
        dismissed++;
      } catch (err) {
        // A single dismiss failure (e.g. a race with a concurrent dismiss, or a
        // COMMENTED slipping through → 422) must not abort the rest.
        console.error("[review-reconciler] dismiss failed (continuing)", {
          repoFullName,
          prNumber,
          reviewId: target.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Telemetry: `dup_reconciled` is the number that prioritizes the durable
    // single-writer channel (ADR-036 phase-2). Loud + structured for the matrix.
    console.log("[review-reconciler] dup_reconciled", {
      repoFullName,
      prNumber,
      keepId: decision.keepId,
      dupReconciled: dismissed,
      actionableCount: decision.actionableCount,
      commentedSkipped: decision.commentedSkipped,
    });
    return { dupReconciled: dismissed };
  } catch (err) {
    // FAIL-SOFT: never let a reconciler error surface.
    console.error("[review-reconciler] failed (non-fatal)", {
      repoFullName,
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
