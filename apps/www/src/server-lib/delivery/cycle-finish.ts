import type { Octokit } from "octokit";

import type { DB } from "@terragon/shared/db";
import {
  abandonDeliveryFixCycle,
  findDeliveryFixCycleAtHead,
  getDeliveryPr,
  listStaleDeliveryFixCycles,
  settleDeliveryFixCycle,
  type DeliveryFixCycleRow,
} from "@terragon/shared/model/delivery-loop";
import { getThread } from "@terragon/shared/model/threads";

import { db as defaultDb } from "@/lib/db";
import { getOctokitForApp } from "@/lib/github";

import { evaluateDeliveryPr } from "./evaluate-delivery-pr";

/**
 * Settling a delivery fix cycle (#509): when its thread finishes, compare the
 * PR's head with the head the cycle was triggered at. A moved head is
 * `pushed`, an unchanged one `no_push`; then the PR is evaluated, which
 * observes the new head (and waits for its CI and review) or stops for a
 * person. The sweep runs the same settle for a cycle whose finish was missed.
 */

/** A cycle with no thread this long after its start never began. */
export const DELIVERY_DISPATCH_STALE_MS = 5 * 60_000;
/** Past the run's 30-minute hard cap with slack: its finish was missed. */
export const DELIVERY_RUN_STALE_MS = 45 * 60_000;

export interface DeliveryCycleFinishDeps {
  db: DB;
  octokitFor: (args: { owner: string; repo: string }) => Promise<Octokit>;
  evaluate: (args: { deliveryPrId: string }) => Promise<unknown>;
  now: () => Date;
}

const DEFAULT_DEPS: DeliveryCycleFinishDeps = {
  db: defaultDb,
  octokitFor: getOctokitForApp,
  evaluate: evaluateDeliveryPr,
  now: () => new Date(),
};

async function settleAndEvaluate(
  deps: DeliveryCycleFinishDeps,
  cycle: DeliveryFixCycleRow,
): Promise<"pushed" | "no_push" | "already_settled" | "missing_pr"> {
  const row = await getDeliveryPr(deps.db, cycle.deliveryPrId);
  if (!row) return "missing_pr";
  const [owner, repo] = row.repoFullName.split("/");
  if (!owner || !repo) return "missing_pr";
  const octokit = await deps.octokitFor({ owner, repo });
  const { data: pull } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: row.prNumber,
    request: { signal: AbortSignal.timeout(10_000) },
  });
  const state = pull.head.sha === cycle.triggerHeadSha ? "no_push" : "pushed";
  const settled = await settleDeliveryFixCycle(deps.db, {
    cycleId: cycle.id,
    state,
    resultHeadSha: state === "pushed" ? pull.head.sha : null,
    now: deps.now(),
  });
  await deps.evaluate({ deliveryPrId: row.id });
  return settled ? state : "already_settled";
}

/**
 * The daemon finish hook's sibling: a no-op for any thread that is not a
 * delivery fix cycle. Never throws.
 */
export async function handleDeliveryCycleFinish({
  userId,
  threadId,
  deps: overrides = {},
}: {
  userId: string;
  threadId: string;
  deps?: Partial<DeliveryCycleFinishDeps>;
}): Promise<void> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  try {
    const thread = await getThread({ db: deps.db, threadId, userId });
    const stamp = thread?.sourceMetadata;
    if (stamp?.type !== "automation-skill" || !stamp.delivery) return;
    const cycle = await findDeliveryFixCycleAtHead(deps.db, {
      deliveryPrId: stamp.delivery.deliveryPrId,
      headSha: stamp.delivery.headSha,
    });
    if (!cycle || cycle.threadId !== threadId) return;
    const outcome = await settleAndEvaluate(deps, cycle);
    console.log("[delivery-loop] cycle finished", {
      threadId,
      cycleId: cycle.id,
      outcome,
    });
  } catch (error: unknown) {
    console.error("[delivery-loop] cycle finish failed (non-fatal)", {
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The sweep's cycle reconcile: a cycle that never got a thread is abandoned
 * and refunded; a running one past the hard cap is settled from the PR head.
 */
export async function reconcileStaleDeliveryCycles(
  overrides: Partial<DeliveryCycleFinishDeps> = {},
): Promise<{ abandoned: number; settled: number }> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const now = deps.now();
  const stale = await listStaleDeliveryFixCycles(deps.db, {
    dispatchingBefore: new Date(now.getTime() - DELIVERY_DISPATCH_STALE_MS),
    runningBefore: new Date(now.getTime() - DELIVERY_RUN_STALE_MS),
    limit: 20,
  });
  let abandoned = 0;
  let settled = 0;
  for (const cycle of stale) {
    try {
      if (cycle.state === "dispatching" && cycle.threadId === null) {
        const row = await getDeliveryPr(deps.db, cycle.deliveryPrId);
        // The phase the cycle left: a ready PR waits for review, a draft for CI.
        const restorePhase =
          row?.readyMarkedHeadSha === cycle.triggerHeadSha
            ? "awaiting_review"
            : "awaiting_ci";
        if (
          await abandonDeliveryFixCycle(deps.db, {
            cycleId: cycle.id,
            restorePhase,
            reason: "cycle never started (no thread)",
            now,
          })
        ) {
          abandoned += 1;
        }
        continue;
      }
      const outcome = await settleAndEvaluate(deps, cycle);
      if (outcome === "pushed" || outcome === "no_push") settled += 1;
    } catch (error: unknown) {
      console.error("[delivery-loop] stale cycle reconcile failed", {
        cycleId: cycle.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { abandoned, settled };
}
