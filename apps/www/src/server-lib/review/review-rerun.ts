import { eq } from "drizzle-orm";
import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import type { DBMessage } from "@terragon/shared/db/db-message";
import { thread as threadTable } from "@terragon/shared/db/schema";
import {
  claimDueReviewReruns,
  expireStaleReviewRerunClaims,
  markReviewRerunDispatched,
  planReviewRerun,
  settleReviewRerun,
  type ReviewRerunDecision,
  type ReviewRerunRow,
} from "@terragon/shared/model/review-rerun";
import { buildPrKey } from "@terragon/shared/model/supersede-recheck";
import { findAnyBotReviewAtCommit } from "@terragon/review/state/head-review-guard";
import { redactSecrets } from "@terragon/utils/redact";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import { resolveBotLogin } from "./bot-login";
import { isNotAVerdict, snapshotOf } from "./execute-review-from-intent";
import { createOctokitReviewClient } from "./octokit-review-client";

/**
 * #107: a review run that FAILED before it produced a verdict is re-run for
 * the same PR and head, up to twice with backoff, before the PR gets the
 * no-verdict notice (ADR-009). Three pieces:
 *
 *  1. `classifyRunFailure` — pure. Says whether the run failed for an infra
 *     reason, from the stored messages alone. Narrow on purpose: a run whose
 *     agent ANSWERED (any lead agent message after which no run error was
 *     recorded) is never re-run, because a skill that emits a malformed
 *     verdict would fail identically every time. A provider refusal is not
 *     handled here either: #441 names it on the notice and it does not reset
 *     within a re-run's backoff.
 *  2. `createRerunPlanner` — the hook the single writer calls from its
 *     no-verdict path (finish hook and hourly sweep alike). It schedules a
 *     ledger row and tells the writer to defer the notice, or says the
 *     budget is spent.
 *  3. `runReviewRerunDispatcher` — the every-minute cron. It claims due rows,
 *     re-checks the PR (open, head unchanged, still no verdict) and
 *     re-dispatches through the normal PR automation path with a distinct
 *     delivery id, so the engine neither dedupes it nor treats it as older
 *     than anything at that head.
 */

/** The run's recorded failure, when the run failed for an infra reason. */
export interface RunFailure {
  /** The run's own error text (redacted), or null when it recorded none. */
  detail: string | null;
}

/**
 * Infra failure ⇔ the run recorded an `error` message (the worker's
 * postRunFailed, a sandbox boot error) after its last lead agent message, OR
 * it has no lead agent message at all (it died before the agent spoke; the
 * stalled-thread watchdog reaps those without an error message when the
 * failure report itself could not be delivered).
 */
export function classifyRunFailure(
  messages: DBMessage[] | null | undefined,
): RunFailure | null {
  const list = messages ?? [];
  let lastLeadAgent = -1;
  let lastError = -1;
  for (let i = 0; i < list.length; i++) {
    const m = list[i]!;
    if (m.type === "agent" && m.parent_tool_use_id == null) lastLeadAgent = i;
    if (m.type === "error") lastError = i;
  }
  if (lastError > lastLeadAgent) {
    const info = list[lastError];
    const raw = info?.type === "error" ? (info.error_info ?? "") : "";
    const detail = redactSecrets(raw).trim();
    return { detail: detail.length > 0 ? detail : null };
  }
  if (lastLeadAgent === -1) return { detail: null };
  return null;
}

/** What the single writer's no-verdict path gets back from the planner. */
export type RerunPlan =
  | { defer: true; attempt: number; decision: ReviewRerunDecision["kind"] }
  | { defer: false; attempts: number; decision: ReviewRerunDecision["kind"] };

export type RerunPlanner = (headSha: string) => Promise<RerunPlan>;

/**
 * The planner for one failed review thread, or undefined when the thread
 * cannot be re-dispatched (no org → no per-PR key; no automation → nothing to
 * re-run). One builder for the finish hook and the sweep, so the two paths
 * cannot diverge (the #213/#221/#224 lesson).
 */
export function createRerunPlanner({
  db,
  threadId,
  organizationId,
  automationId,
  repoFullName,
  prNumber,
  now,
}: {
  db: DB;
  threadId: string;
  organizationId: string | null;
  automationId: string | null;
  repoFullName: string;
  prNumber: number;
  now?: () => Date;
}): RerunPlanner | undefined {
  if (!organizationId || !automationId) return undefined;
  const prKey = buildPrKey({ orgId: organizationId, repoFullName, prNumber });
  return async (headSha) => {
    const decision = await planReviewRerun({
      db,
      prKey,
      headSha,
      failedThreadId: threadId,
      now: now?.(),
    });
    if (decision.kind === "scheduled") {
      console.log("[review-rerun] scheduled a re-run of a failed review", {
        threadId,
        prKey,
        headSha,
        attempt: decision.attempt,
        dueAt: decision.dueAt.toISOString(),
      });
    }
    return decision.defer
      ? { defer: true, attempt: decision.attempt, decision: decision.kind }
      : { defer: false, attempts: decision.attempts, decision: decision.kind };
  };
}

/** The PR facts a due re-run is checked against just before it dispatches. */
export interface RerunPrState {
  open: boolean;
  headSha: string;
  /** A bot verdict (not a legacy degraded comment) already sits at HEAD. */
  verdictAtHead: boolean;
}

export interface RerunDispatchArgs {
  userId: string;
  automationId: string;
  repoFullName: string;
  prNumber: number;
  deliveryId: string;
  expectedHeadSha: string;
}

export interface ReviewRerunDispatcherDeps {
  db: DB;
  now?: () => Date;
  readPr?: (repoFullName: string, prNumber: number) => Promise<RerunPrState>;
  dispatch?: (args: RerunDispatchArgs) => Promise<boolean>;
}

export type RerunDispatchOutcome =
  | { result: "dispatched" }
  | { result: "skipped" | "failed"; reason: string };

/** The engine idempotency id of one re-run: distinct per (PR, head, attempt). */
export function rerunDeliveryId(
  row: Pick<ReviewRerunRow, "prKey" | "headSha" | "attempt">,
): string {
  return `rerun:${row.prKey}:${row.headSha}:${row.attempt}`;
}

async function dispatchOne(
  row: ReviewRerunRow,
  deps: Required<Omit<ReviewRerunDispatcherDeps, "now">>,
): Promise<RerunDispatchOutcome> {
  const [failed] = await deps.db
    .select({
      userId: threadTable.userId,
      automationId: threadTable.automationId,
      repoFullName: threadTable.githubRepoFullName,
      prNumber: threadTable.githubPRNumber,
    })
    .from(threadTable)
    .where(eq(threadTable.id, row.failedThreadId))
    .limit(1);
  if (!failed?.automationId || failed.prNumber === null) {
    return { result: "failed", reason: "thread_unavailable" };
  }
  const pr = await deps.readPr(failed.repoFullName, failed.prNumber);
  if (!pr.open) return { result: "skipped", reason: "pr_closed" };
  if (pr.headSha !== row.headSha) {
    return { result: "skipped", reason: "head_moved" };
  }
  if (pr.verdictAtHead) return { result: "skipped", reason: "verdict_exists" };
  const started = await deps.dispatch({
    userId: failed.userId,
    automationId: failed.automationId,
    repoFullName: failed.repoFullName,
    prNumber: failed.prNumber,
    deliveryId: rerunDeliveryId(row),
    expectedHeadSha: row.headSha,
  });
  return started
    ? { result: "dispatched" }
    : { result: "failed", reason: "dispatch_refused" };
}

/**
 * Dispatch the re-runs that are due. Never throws: it rides the every-minute
 * cron next to scheduled-thread processing. A row that fails to dispatch is
 * settled `failed`, which makes the failed run's next no-verdict pass (the
 * hourly sweep) post the notice instead of deferring forever. So is a claim
 * whose claimant died before it dispatched (lease lapsed): it is expired to
 * `failed` at the start of every tick, never re-dispatched.
 */
export async function runReviewRerunDispatcher(
  deps: ReviewRerunDispatcherDeps,
): Promise<{
  dispatched: number;
  skipped: number;
  failed: number;
  expired: number;
}> {
  const counts = { dispatched: 0, skipped: 0, failed: 0, expired: 0 };
  if (!env.GITHUB_SIDE_EFFECTS_ENABLED) return counts;
  const full = {
    db: deps.db,
    readPr: deps.readPr ?? readPrStateForRerun,
    dispatch: deps.dispatch ?? dispatchRerunThroughAutomation,
  };
  const now = deps.now?.() ?? new Date();
  const expired = await expireStaleReviewRerunClaims({ db: deps.db, now });
  counts.expired = expired.length;
  for (const row of expired) {
    console.warn("[review-rerun] re-run claim expired before dispatch", {
      rerunId: row.id,
      failedThreadId: row.failedThreadId,
      prKey: row.prKey,
      headSha: row.headSha,
      attempt: row.attempt,
    });
  }
  const claimed = await claimDueReviewReruns({ db: deps.db, now });
  for (const row of claimed) {
    let outcome: RerunDispatchOutcome;
    try {
      outcome = await dispatchOne(row, full);
    } catch (error) {
      outcome = {
        result: "failed",
        reason:
          `error: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            300,
          ),
      };
    }
    counts[outcome.result] += 1;
    const meta = {
      rerunId: row.id,
      failedThreadId: row.failedThreadId,
      prKey: row.prKey,
      headSha: row.headSha,
      attempt: row.attempt,
    };
    if (outcome.result === "dispatched") {
      console.log("[review-rerun] re-dispatched a failed review", meta);
      try {
        const marked = await markReviewRerunDispatched({
          db: deps.db,
          id: row.id,
        });
        if (!marked) {
          console.warn(
            "[review-rerun] re-run started but its claim was no longer held",
            meta,
          );
        }
      } catch (error) {
        // The run started; the claim lapses to failed and the notice may post
        // beside it — a verdict from the re-run then retires that notice.
        console.error("[review-rerun] could not mark a re-run dispatched", {
          ...meta,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    console.warn(`[review-rerun] re-run ${outcome.result}`, {
      ...meta,
      reason: outcome.reason,
    });
    try {
      await settleReviewRerun({
        db: deps.db,
        id: row.id,
        state: outcome.result,
        reason: outcome.reason,
      });
    } catch (error) {
      console.error("[review-rerun] could not settle a re-run row", {
        ...meta,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return counts;
}

async function readPrStateForRerun(
  repoFullName: string,
  prNumber: number,
): Promise<RerunPrState> {
  const [owner, repo] = parseRepoFullName(repoFullName);
  const octokit = await getOctokitForApp({ owner, repo });
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  const headSha = data.head.sha;
  const reviews = await createOctokitReviewClient(octokit).listReviews(
    repoFullName,
    prNumber,
  );
  const verdict = await findAnyBotReviewAtCommit({
    github: snapshotOf(reviews.filter((r) => !isNotAVerdict(r))),
    repo: repoFullName,
    prNumber,
    headSha,
    botLogin: resolveBotLogin(),
  });
  return { open: data.state === "open", headSha, verdictAtHead: !!verdict };
}

async function dispatchRerunThroughAutomation(
  args: RerunDispatchArgs,
): Promise<boolean> {
  // Dynamic import: automations.ts drags the thread-creation graph in; this
  // module rides the cron path that must stay light (as supersede-recheck).
  const { runPullRequestAutomation } = await import("@/server-lib/automations");
  return await runPullRequestAutomation({
    ...args,
    prEventAction: "synchronize",
    source: "automated",
  });
}
