import { eq } from "drizzle-orm";
import type { Octokit } from "octokit";

import type { DB } from "@terragon/shared/db";
import { automations } from "@terragon/shared/db/schema";
import {
  abandonDeliveryFixCycle,
  bindDeliveryFixCycleThread,
  startDeliveryFixCycle,
  type DeliveryFixTrigger,
  type DeliveryPullRequestRow,
} from "@terragon/shared/model/delivery-loop";

import { runAutomation } from "@/server-lib/automations";

import {
  buildDeliveryFixTransform,
  type DeliveryFixCheck,
  type DeliveryFixReview,
} from "./delivery-fix-prompt";

/**
 * Starts one delivery fix cycle (#509) on the PR's head branch. The ledger
 * spends the cycle first (cap, one per head, CAS on phase and head); the
 * run is the issue-delivery automation itself, dispatched with the PR number
 * and the head ref as its branch, so the worker checks the head out and gets
 * no work branch, and the agent's `git push origin HEAD` updates the PR. The
 * thread never sets githubIssueNumber: a fix cycle is not a label run (#324).
 * A cycle whose thread never starts is abandoned and refunded.
 */

export type DeliveryCycleOutcome =
  | { status: "dispatched"; cycleId: string; threadId: string }
  | {
      status: "not_started";
      reason: "duplicate" | "cap_reached" | "stale" | "no_automation";
    }
  | { status: "abandoned"; reason: string };

export interface RunDeliveryCycleDeps {
  runAutomation: typeof runAutomation;
  now: () => Date;
}

const DEFAULT_DEPS: RunDeliveryCycleDeps = {
  runAutomation,
  now: () => new Date(),
};

const READ_TIMEOUT_MS = 10_000;

export async function runDeliveryFixCycle({
  db,
  octokit,
  row,
  headSha,
  trigger,
  reviewId,
  failingChecks,
  conflicting,
  deps: overrides = {},
}: {
  db: DB;
  octokit: Octokit;
  row: DeliveryPullRequestRow;
  headSha: string;
  trigger: DeliveryFixTrigger;
  reviewId: number | null;
  failingChecks: string[];
  conflicting: boolean;
  deps?: Partial<RunDeliveryCycleDeps>;
}): Promise<DeliveryCycleOutcome> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const [automation] = await db
    .select({ id: automations.id, userId: automations.userId })
    .from(automations)
    .where(eq(automations.id, row.automationId));
  if (!automation) return { status: "not_started", reason: "no_automation" };

  const started = await startDeliveryFixCycle(db, {
    deliveryPrId: row.id,
    expectedPhase: row.phase,
    headSha,
    trigger,
    reviewId,
    failingChecks,
  });
  if (started.kind !== "started") {
    return { status: "not_started", reason: started.kind };
  }
  const cycle = started.cycle;
  const abandon = async (reason: string): Promise<DeliveryCycleOutcome> => {
    await abandonDeliveryFixCycle(db, {
      cycleId: cycle.id,
      restorePhase: row.phase,
      reason: `cycle not started: ${reason}`,
      now: deps.now(),
    });
    return { status: "abandoned", reason };
  };

  try {
    const [owner, repo] = row.repoFullName.split("/");
    if (!owner || !repo) return await abandon(`bad repo ${row.repoFullName}`);
    const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
    const [review, checks] = await Promise.all([
      reviewId === null
        ? Promise.resolve(null)
        : readReview({
            octokit,
            owner,
            repo,
            prNumber: row.prNumber,
            reviewId,
            signal,
          }),
      readFailingChecks({
        octokit,
        owner,
        repo,
        sha: headSha,
        names: failingChecks,
        signal,
      }),
    ]);
    const transformMessage = buildDeliveryFixTransform({
      repoFullName: row.repoFullName,
      prNumber: row.prNumber,
      issueNumber: row.issueNumber,
      headRef: row.headRef,
      headSha,
      baseRef: row.baseRef,
      cycle: row.cyclesUsed + 1,
      trigger,
      review,
      failingChecks: checks,
      conflicting,
    });
    const thread = await deps.runAutomation({
      userId: automation.userId,
      automationId: automation.id,
      source: "automated",
      options: {
        branchName: row.headRef,
        prBaseBranchName: row.baseRef,
        prNumber: row.prNumber,
        // No headSha: runAutomation stamps it as reviewedSha, which the
        // review single writer reads. The cycle's head travels in its stamp.
        transformMessage,
        stampExtra: {
          delivery: {
            deliveryPrId: row.id,
            cycleNo: cycle.cycleNo,
            headSha,
            issueNumber: row.issueNumber,
          },
        },
      },
    });
    if (!thread) return await abandon("runAutomation created no thread");
    await bindDeliveryFixCycleThread(db, {
      cycleId: cycle.id,
      threadId: thread.threadId,
    });
    return {
      status: "dispatched",
      cycleId: cycle.id,
      threadId: thread.threadId,
    };
  } catch (error: unknown) {
    return await abandon(
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function readReview({
  octokit,
  owner,
  repo,
  prNumber,
  reviewId,
  signal,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  reviewId: number;
  signal: AbortSignal;
}): Promise<DeliveryFixReview> {
  const [{ data: review }, { data: comments }] = await Promise.all([
    octokit.rest.pulls.getReview({
      owner,
      repo,
      pull_number: prNumber,
      review_id: reviewId,
      request: { signal },
    }),
    octokit.rest.pulls.listCommentsForReview({
      owner,
      repo,
      pull_number: prNumber,
      review_id: reviewId,
      per_page: 100,
      request: { signal },
    }),
  ]);
  return {
    id: reviewId,
    body: review.body ?? "",
    inline: comments.map((c) => ({
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      body: c.body,
    })),
  };
}

async function readFailingChecks({
  octokit,
  owner,
  repo,
  sha,
  names,
  signal,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  sha: string;
  names: string[];
  signal: AbortSignal;
}): Promise<DeliveryFixCheck[]> {
  if (names.length === 0) return [];
  const { data } = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: sha,
    filter: "latest",
    per_page: 100,
    request: { signal },
  });
  const byName = new Map(data.check_runs.map((run) => [run.name, run]));
  // A failing commit status has no check run: it is listed by name only.
  return names.map((name) => {
    const run = byName.get(name);
    return {
      name,
      title: run?.output?.title ?? null,
      summary: run?.output?.summary ?? null,
    };
  });
}
