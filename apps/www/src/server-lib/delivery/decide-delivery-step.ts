import { DELIVERY_FIX_CAP } from "@terragon/shared/model/delivery-loop-settings";
import type {
  DeliveryFixCycleState,
  DeliveryFixTrigger,
  DeliveryPhase,
  DeliveryPullRequestRow,
} from "@terragon/shared/model/delivery-loop";

import type { DeliveryHeadCi } from "./head-ci";

/**
 * The delivery loop's decision core (#509): given the enrolled row and a
 * fresh GitHub snapshot, the ONE next step. Pure, so every edge of the state
 * machine is a table test. The evaluator applies the step with a CAS on
 * (phase, head_sha) and decides again on the updated row, so a head change
 * and the step it unlocks can land in one evaluation.
 *
 * A head is decided once:
 * - draft: when its CI is terminal (no review is expected on a draft);
 * - ready: when its CI is terminal AND the bot reviewed this head, or
 *   REVIEW_WAIT_MS after the head (or the ready transition) without one.
 * So one fix cycle carries both the review findings and the failing checks.
 */

/** How long a ready head waits for the bot's review before deciding on CI. */
export const DELIVERY_REVIEW_WAIT_MS = 45 * 60_000;

export interface DeliveryPrSnapshot {
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headSha: string;
  /** The PR author is a Bot account (the remote-task-pr App fallback). */
  authorIsBot: boolean;
  ci: DeliveryHeadCi;
  /** The bot's latest review whose commit_id is this head, if any. */
  botReviewAtHead: {
    id: number;
    state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  } | null;
  /** Some non-bot reviewer's latest review requests changes. */
  humanChangesRequested: boolean;
}

/** The latest fix cycle of the PR, as the decision needs it. */
export interface DeliveryLatestCycle {
  state: DeliveryFixCycleState;
  triggerHeadSha: string;
}

export type DeliveryNeedsHumanReason =
  | "app_authored_pr"
  | "fix_cap_reached"
  | "cycle_pushed_nothing"
  | "no_bot_review"
  | "human_changes_requested";

export type DeliveryStep =
  | { kind: "noop"; reason: string }
  /** The PR closed: terminal. */
  | { kind: "close"; phase: "merged" | "closed" }
  /** A new head: record it and the phase it waits in. */
  | {
      kind: "observe_head";
      headSha: string;
      phase: "awaiting_ci" | "awaiting_review";
    }
  /** A person flipped the draft state the loop expects; follow them. */
  | {
      kind: "set_phase";
      phase: "awaiting_ci" | "awaiting_review" | "paused";
      reason: string;
    }
  /** Draft head is green: mark ready (one review follows). */
  | { kind: "mark_ready"; noCi: boolean }
  | {
      kind: "start_cycle";
      trigger: DeliveryFixTrigger;
      reviewId: number | null;
      failingChecks: string[];
    }
  /** Approved at the head and green: one comment with the merge command. */
  | { kind: "merge_ready"; reviewId: number }
  | { kind: "needs_human"; reason: DeliveryNeedsHumanReason };

type Row = Pick<
  DeliveryPullRequestRow,
  | "phase"
  | "headSha"
  | "headSeenAt"
  | "cyclesUsed"
  | "readyMarkedHeadSha"
  | "readyMarkedAt"
  | "mergeReadyHeadSha"
>;

const SETTLED_PHASES: readonly DeliveryPhase[] = ["needs_human", "paused"];

export function decideDeliveryStep({
  row,
  pr,
  latestCycle,
  now,
}: {
  row: Row;
  pr: DeliveryPrSnapshot;
  latestCycle: DeliveryLatestCycle | null;
  now: Date;
}): DeliveryStep {
  if (row.phase === "merged" || row.phase === "closed") {
    return { kind: "noop", reason: "terminal" };
  }
  if (pr.state === "closed") {
    return { kind: "close", phase: pr.merged ? "merged" : "closed" };
  }
  // A new head (the cycle pushed, or a person did) resumes the loop from any
  // phase, needs_human and paused included.
  if (pr.headSha !== row.headSha) {
    return {
      kind: "observe_head",
      headSha: pr.headSha,
      phase: pr.draft ? "awaiting_ci" : "awaiting_review",
    };
  }
  if (SETTLED_PHASES.includes(row.phase)) {
    return { kind: "noop", reason: `${row.phase} until a new head` };
  }
  // The bot cannot approve or request changes on a PR its own App opened.
  if (pr.authorIsBot) {
    return { kind: "needs_human", reason: "app_authored_pr" };
  }

  switch (row.phase) {
    case "fixing":
      return decideFixing(latestCycle, pr.headSha);
    case "merge_ready":
      return { kind: "noop", reason: "merge-ready at this head" };
    case "awaiting_ci":
      if (!pr.draft) {
        return {
          kind: "set_phase",
          phase: "awaiting_review",
          reason: "marked ready by a person",
        };
      }
      return decideDraft(row, pr);
    case "awaiting_review":
      if (pr.draft) {
        // Back to draft after the loop marked this head ready: a person took
        // it. A draft the loop never marked waits for CI again.
        return row.readyMarkedHeadSha === pr.headSha
          ? { kind: "set_phase", phase: "paused", reason: "converted to draft" }
          : {
              kind: "set_phase",
              phase: "awaiting_ci",
              reason: "converted to draft",
            };
      }
      return decideReady(row, pr, now);
    default:
      return { kind: "noop", reason: `unhandled phase ${row.phase}` };
  }
}

function decideFixing(
  latestCycle: DeliveryLatestCycle | null,
  headSha: string,
): DeliveryStep {
  if (
    latestCycle === null ||
    latestCycle.state === "dispatching" ||
    latestCycle.state === "running"
  ) {
    return { kind: "noop", reason: "cycle in flight" };
  }
  // Finished, and the head is still the one it was triggered at (a push
  // would have been observed above): it changed nothing on the PR.
  if (latestCycle.triggerHeadSha === headSha) {
    return { kind: "needs_human", reason: "cycle_pushed_nothing" };
  }
  return { kind: "noop", reason: "cycle finished at an older head" };
}

function decideDraft(row: Row, pr: DeliveryPrSnapshot): DeliveryStep {
  const ci = pr.ci;
  switch (ci.state) {
    case "pending":
      return { kind: "noop", reason: "ci pending" };
    case "infra":
      return { kind: "noop", reason: "ci infra failure; waiting for a re-run" };
    case "success":
      return row.readyMarkedHeadSha === pr.headSha
        ? { kind: "noop", reason: "already marked ready" }
        : { kind: "mark_ready", noCi: ci.noCi };
    case "failure":
      return cycleOrCap(row, {
        trigger: "ci",
        reviewId: null,
        failingChecks: ci.failing,
      });
  }
}

function decideReady(
  row: Row,
  pr: DeliveryPrSnapshot,
  now: Date,
): DeliveryStep {
  const ci = pr.ci;
  if (ci.state === "pending") return { kind: "noop", reason: "ci pending" };
  const review = pr.botReviewAtHead;
  const failing = ci.state === "failure" ? ci.failing : [];

  if (review?.state === "CHANGES_REQUESTED") {
    return cycleOrCap(row, {
      trigger: failing.length > 0 ? "review+ci" : "review",
      reviewId: review.id,
      failingChecks: failing,
    });
  }
  if (ci.state === "infra") {
    return { kind: "noop", reason: "ci infra failure; waiting for a re-run" };
  }
  if (review?.state === "APPROVED") {
    if (ci.state === "failure") {
      return cycleOrCap(row, {
        trigger: "ci",
        reviewId: review.id,
        failingChecks: failing,
      });
    }
    if (pr.humanChangesRequested) {
      return { kind: "needs_human", reason: "human_changes_requested" };
    }
    return row.mergeReadyHeadSha === pr.headSha
      ? { kind: "noop", reason: "merge-ready comment already posted" }
      : { kind: "merge_ready", reviewId: review.id };
  }

  // No formal verdict at this head (none yet, or a COMMENTED / no-verdict
  // notice): wait for the bot, then decide on CI alone.
  if (!reviewWaitExpired(row, pr.headSha, now)) {
    return { kind: "noop", reason: "waiting for the bot's review" };
  }
  if (ci.state === "failure") {
    return cycleOrCap(row, {
      trigger: "ci",
      reviewId: null,
      failingChecks: failing,
    });
  }
  return { kind: "needs_human", reason: "no_bot_review" };
}

/** The review clock starts at the later of the head and the ready mark. */
function reviewWaitExpired(row: Row, headSha: string, now: Date): boolean {
  const since = Math.max(
    row.headSeenAt?.getTime() ?? 0,
    row.readyMarkedHeadSha === headSha
      ? (row.readyMarkedAt?.getTime() ?? 0)
      : 0,
  );
  return now.getTime() - since >= DELIVERY_REVIEW_WAIT_MS;
}

function cycleOrCap(
  row: Row,
  cycle: {
    trigger: DeliveryFixTrigger;
    reviewId: number | null;
    failingChecks: string[];
  },
): DeliveryStep {
  if (row.cyclesUsed >= DELIVERY_FIX_CAP) {
    return { kind: "needs_human", reason: "fix_cap_reached" };
  }
  return { kind: "start_cycle", ...cycle };
}
