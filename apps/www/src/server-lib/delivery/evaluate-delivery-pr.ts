import type { Octokit } from "octokit";

import type { DB } from "@terragon/shared/db";
import type { DeliveryLoopMode } from "@terragon/shared/model/delivery-loop-settings";
import {
  acquireDeliveryLease,
  getDeliveryPr,
  listDeliveryFixCycles,
  recordShadowFixCycle,
  releaseDeliveryLease,
  touchDeliveryEvaluated,
  transitionDeliveryPr,
  type DeliveryPrPatch,
  type DeliveryPullRequestRow,
} from "@terragon/shared/model/delivery-loop";

import { db as defaultDb } from "@/lib/db";
import { getOctokitForApp } from "@/lib/github";
import { resolveBotLogin } from "@/server-lib/review/bot-login";

import {
  decideDeliveryStep,
  type DeliveryLatestCycle,
  type DeliveryPrSnapshot,
  type DeliveryStep,
} from "./decide-delivery-step";
import {
  markDeliveryPrReady,
  postDeliveryComment,
  renderMergeReady,
  renderNeedsHuman,
  renderNoCi,
} from "./delivery-effects";
import { loadDeliveryLoopMode } from "./delivery-mode";
import { readDeliveryHeadCi } from "./head-ci";

/**
 * The delivery loop's single evaluator (#509). Every trigger (enrollment, CI
 * completion, the bot's review, PR lifecycle, the sweep) calls it. It takes
 * the row's lease, re-reads the PR from GitHub (a webhook payload is never
 * trusted), decides one step, applies it with a compare-and-set on
 * (phase, head_sha) and decides again on the updated row, at most
 * MAX_STEPS times. Never throws.
 *
 * Effects: phase changes are written in every mode. GitHub writes (mark
 * ready, the merge-ready, no-CI and stop comments) happen in mode "on" only;
 * in shadow they are recorded as `last_reason`. A GitHub write ends the
 * evaluation: the snapshot no longer describes the PR, and the webhook the
 * write causes (ready_for_review, a review) evaluates it afresh. Fix cycles
 * are still recorded only (a shadow cycle row) in this revision.
 */

const MAX_STEPS = 4;
const GITHUB_READ_TIMEOUT_MS = 10_000;

export type DeliveryEvaluationOutcome =
  | { status: "evaluated"; steps: DeliveryStep[] }
  | { status: "skipped"; reason: "missing" | "leased" | "mode_off" }
  | { status: "failed"; reason: string };

export interface EvaluateDeliveryDeps {
  db: DB;
  octokitFor: (args: { owner: string; repo: string }) => Promise<Octokit>;
  loadMode: typeof loadDeliveryLoopMode;
  readHeadCi: typeof readDeliveryHeadCi;
  botLogin: () => string;
  now: () => Date;
}

const DEFAULT_DEPS: EvaluateDeliveryDeps = {
  db: defaultDb,
  octokitFor: getOctokitForApp,
  loadMode: loadDeliveryLoopMode,
  readHeadCi: readDeliveryHeadCi,
  botLogin: resolveBotLogin,
  now: () => new Date(),
};

export async function evaluateDeliveryPr({
  deliveryPrId,
  deps: overrides = {},
}: {
  deliveryPrId: string;
  deps?: Partial<EvaluateDeliveryDeps>;
}): Promise<DeliveryEvaluationOutcome> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const { db } = deps;
  try {
    const initial = await getDeliveryPr(db, deliveryPrId);
    if (!initial) return { status: "skipped", reason: "missing" };
    const mode = await deps.loadMode({
      db,
      organizationId: initial.organizationId,
      repoFullName: initial.repoFullName,
    });
    if (mode === "off") {
      // Back of the sweep queue, or off rows would starve enabled ones.
      await touchDeliveryEvaluated(db, deliveryPrId, deps.now());
      return { status: "skipped", reason: "mode_off" };
    }
    if (!(await acquireDeliveryLease(db, deliveryPrId, deps.now()))) {
      return { status: "skipped", reason: "leased" };
    }
    try {
      return await evaluateLeased({ deps, row: initial, mode });
    } finally {
      await releaseDeliveryLease(db, deliveryPrId, deps.now());
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[delivery-loop] evaluation failed", {
      deliveryPrId,
      reason,
    });
    return { status: "failed", reason };
  }
}

async function evaluateLeased({
  deps,
  row: initial,
  mode,
}: {
  deps: EvaluateDeliveryDeps;
  row: DeliveryPullRequestRow;
  mode: Exclude<DeliveryLoopMode, "off">;
}): Promise<DeliveryEvaluationOutcome> {
  const { db } = deps;
  const [owner, repo] = initial.repoFullName.split("/");
  if (!owner || !repo) {
    return { status: "failed", reason: `bad repo ${initial.repoFullName}` };
  }
  const octokit = await deps.octokitFor({ owner, repo });
  const { pr, nodeId } = await readSnapshot({
    deps,
    octokit,
    owner,
    repo,
    row: initial,
  });
  const github: GithubTarget = {
    octokit,
    owner,
    repo,
    prNumber: initial.prNumber,
    nodeId,
  };
  const steps: DeliveryStep[] = [];
  let row = initial;
  for (let i = 0; i < MAX_STEPS; i++) {
    const latestCycle = await readLatestCycle(db, row.id);
    const step = decideDeliveryStep({
      row,
      pr,
      latestCycle,
      now: deps.now(),
    });
    steps.push(step);
    const next = await applyStep({ deps, github, row, pr, step, mode });
    console.log("[delivery-loop] step", {
      deliveryPrId: row.id,
      mode,
      phase: row.phase,
      step: step.kind,
      ...("reason" in step ? { reason: step.reason } : {}),
      applied: next !== null,
    });
    if (next === null) break;
    row = next;
  }
  return { status: "evaluated", steps };
}

/** One read of the PR, its CI at the head and its reviews. */
async function readSnapshot({
  deps,
  octokit,
  owner,
  repo,
  row,
}: {
  deps: EvaluateDeliveryDeps;
  octokit: Octokit;
  owner: string;
  repo: string;
  row: DeliveryPullRequestRow;
}): Promise<{ pr: DeliveryPrSnapshot; nodeId: string }> {
  const signal = AbortSignal.timeout(GITHUB_READ_TIMEOUT_MS);
  const { data: pull } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: row.prNumber,
    request: { signal },
  });
  const headSha = pull.head.sha;
  const now = deps.now();
  const [ci, { data: reviews }] = await Promise.all([
    deps.readHeadCi({
      octokit,
      owner,
      repo,
      sha: headSha,
      baseRef: pull.base.ref,
      // A head the row has not seen yet was pushed just now.
      pushedAt:
        row.headSha === headSha && row.headSeenAt ? row.headSeenAt : now,
      now,
      signal,
    }),
    octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: row.prNumber,
      per_page: 100,
      request: { signal },
    }),
  ]);
  return {
    nodeId: pull.node_id,
    pr: {
      state: pull.state === "closed" ? "closed" : "open",
      merged: pull.merged_at !== null && pull.merged_at !== undefined,
      draft: pull.draft === true,
      headSha,
      authorIsBot: pull.user?.type === "Bot",
      ci,
      ...summarizeReviews(reviews, headSha, deps.botLogin()),
    },
  };
}

/** Where a mode-"on" effect writes. */
interface GithubTarget {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  /** The PR's GraphQL node id (the ready mutation takes it). */
  nodeId: string;
}

interface ReviewLike {
  id: number;
  state: string;
  commit_id?: string | null;
  user?: { login?: string | null; type?: string | null } | null;
}

/**
 * The bot's latest formal review at this head, and whether any person's
 * latest review requests changes (reviews arrive oldest first). Exported for
 * the tests.
 */
export function summarizeReviews(
  reviews: readonly ReviewLike[],
  headSha: string,
  botLogin: string,
): Pick<DeliveryPrSnapshot, "botReviewAtHead" | "humanChangesRequested"> {
  const bot = botLogin.toLowerCase();
  let botReviewAtHead: DeliveryPrSnapshot["botReviewAtHead"] = null;
  const latestByPerson = new Map<string, string>();
  for (const review of reviews) {
    const login = review.user?.login?.toLowerCase();
    if (!login) continue;
    if (login === bot) {
      if (
        review.commit_id === headSha &&
        (review.state === "APPROVED" ||
          review.state === "CHANGES_REQUESTED" ||
          review.state === "COMMENTED")
      ) {
        botReviewAtHead = { id: review.id, state: review.state };
      }
      continue;
    }
    // A plain comment does not withdraw a person's request for changes.
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    latestByPerson.set(login, review.state);
  }
  return {
    botReviewAtHead,
    humanChangesRequested: [...latestByPerson.values()].includes(
      "CHANGES_REQUESTED",
    ),
  };
}

async function readLatestCycle(
  db: DB,
  deliveryPrId: string,
): Promise<DeliveryLatestCycle | null> {
  const cycles = await listDeliveryFixCycles(db, deliveryPrId);
  const live = cycles.filter((c) => c.state !== "shadow");
  const last = live[live.length - 1];
  return last
    ? { state: last.state, triggerHeadSha: last.triggerHeadSha }
    : null;
}

/**
 * Applies one step. Returns the updated row when the loop may decide again,
 * null when this evaluation is done (a noop, a recorded effect, or a CAS
 * another evaluator won).
 */
async function applyStep({
  deps,
  github,
  row,
  pr,
  step,
  mode,
}: {
  deps: EvaluateDeliveryDeps;
  github: GithubTarget;
  row: DeliveryPullRequestRow;
  pr: DeliveryPrSnapshot;
  step: DeliveryStep;
  mode: Exclude<DeliveryLoopMode, "off">;
}): Promise<DeliveryPullRequestRow | null> {
  const now = deps.now();
  switch (step.kind) {
    case "noop":
      return null;
    case "close":
      return await move(deps.db, row, {
        phase: step.phase,
        lastReason: `pr ${step.phase}`,
      });
    case "observe_head":
      return await move(deps.db, row, {
        phase: step.phase,
        headSha: step.headSha,
        headSeenAt: now,
        lastReason: "new head",
      });
    case "set_phase":
      return await move(deps.db, row, {
        phase: step.phase,
        ...(step.recordReadyAt ? { readyMarkedAt: now } : {}),
        lastReason: step.reason,
      });
    case "needs_human": {
      if (mode !== "on") {
        return await move(deps.db, row, {
          phase: "needs_human",
          lastReason: step.reason,
        });
      }
      const stopCommentId = await postDeliveryComment(github, {
        kind: "needs-human",
        headSha: pr.headSha,
        body: renderNeedsHuman({
          reason: step.reason,
          headSha: pr.headSha,
          cyclesUsed: row.cyclesUsed,
        }),
      });
      await move(deps.db, row, {
        phase: "needs_human",
        stopCommentId,
        lastReason: step.reason,
      });
      return null;
    }
    case "start_cycle":
      await recordShadowFixCycle(deps.db, {
        deliveryPrId: row.id,
        headSha: pr.headSha,
        trigger: step.trigger,
        reviewId: step.reviewId,
        failingChecks: step.failingChecks,
      });
      await record(
        deps.db,
        row,
        `${mode}: would start a ${step.trigger} cycle`,
      );
      return null;
    case "mark_ready":
      if (mode !== "on") {
        await record(deps.db, row, `${mode}: would mark ready`);
        return null;
      }
      await markDeliveryPrReady(github.octokit, github.nodeId);
      if (step.noCi) {
        await postDeliveryComment(github, {
          kind: "no-ci",
          headSha: pr.headSha,
          body: renderNoCi(),
        });
      }
      await move(deps.db, row, {
        phase: "awaiting_review",
        readyMarkedHeadSha: pr.headSha,
        readyMarkedAt: now,
        lastReason: step.noCi ? "marked ready (no repo CI)" : "marked ready",
      });
      return null;
    case "merge_ready": {
      if (mode !== "on") {
        await record(deps.db, row, `${mode}: would post merge-ready`);
        return null;
      }
      const mergeReadyCommentId = await postDeliveryComment(github, {
        kind: "merge-ready",
        headSha: pr.headSha,
        body: renderMergeReady({
          prNumber: row.prNumber,
          headSha: pr.headSha,
          approver: deps.botLogin(),
        }),
      });
      await move(deps.db, row, {
        phase: "merge_ready",
        mergeReadyHeadSha: pr.headSha,
        mergeReadyCommentId,
        lastReason: "merge-ready comment posted",
      });
      return null;
    }
  }
}

async function move(
  db: DB,
  row: DeliveryPullRequestRow,
  patch: DeliveryPrPatch,
): Promise<DeliveryPullRequestRow | null> {
  const moved = await transitionDeliveryPr(db, {
    id: row.id,
    expectedPhase: row.phase,
    expectedHeadSha: row.headSha,
    patch,
  });
  return moved ? ((await getDeliveryPr(db, row.id)) ?? null) : null;
}

/** Records a step without moving the row (no CAS needed: reason only). */
async function record(
  db: DB,
  row: DeliveryPullRequestRow,
  reason: string,
): Promise<void> {
  if (row.lastReason === reason) return;
  await transitionDeliveryPr(db, {
    id: row.id,
    expectedPhase: row.phase,
    expectedHeadSha: row.headSha,
    patch: { lastReason: reason },
  });
}
