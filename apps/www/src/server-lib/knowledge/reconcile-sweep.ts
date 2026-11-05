import { db } from "@/lib/db";
import { triggerWorkflow } from "@/agent/hatchet/transport";
import { resolveHatchetConfig } from "@/agent/hatchet/tenant-resolver";
import {
  claimDueKnowledgeIntents,
  failKnowledgeIntent,
  KNOWLEDGE_HEAD_CHECK_SLOTS,
  listKnowledgeHeadCheckCandidates,
  recoverKnowledgeHeadIntent,
  requeueExpiredKnowledgeIntents,
  type ClaimedKnowledgeIntent,
  type FailKnowledgeIntentResult,
  type KnowledgeHeadCheckCandidate,
  type RecoverKnowledgeHeadOutcome,
  type RequeuedKnowledgeIntent,
} from "@terragon/shared/model/knowledge-intent";
import {
  KNOWLEDGE_RECONCILE_WORKFLOW,
  type KnowledgeReconcileInput,
  type ReconcileErrorCode,
} from "@terragon/knowledge/reconcile-wire";
import { env } from "@terragon/env/apps-www";

import { readDefaultBranchHead, type DefaultBranchHead } from "./github-head";
import {
  postKnowledgeIntentFailedAlert,
  type KnowledgeIntentFailedAlert,
} from "./ops-alert";

/**
 * D-12: the every-minute reconcile sweep. The webhook only records an intent;
 * this requeues expired leases, claims due intents of engine-On orgs and
 * dispatches the reference-only worker task. Never throws; logs ids, enum codes
 * and integers only. This file is the only allowed importer of knowledge-intent
 * besides the internal fail route (static guard 7).
 *
 * D-03 / PD-19: after dispatch, a rate-limited default-branch head check
 * recovers a push whose intent write was swallowed (a DB failure in the push
 * handler). It runs last so it never delays dispatch, only while enough of the
 * budget remains, and never throws. GitHub cost bound: 3 calls per checked
 * repo (5 on the 404 fallback), at most 5 repos per tick, each repo at most
 * once per 15 minutes (stateless hash slot); a repo whose head intent is
 * failed answers failed_exists and costs up to 12 calls per hour until an
 * admin Retry.
 */

export const KNOWLEDGE_RECONCILE_BUDGET = {
  totalMs: 20_000,
  claimLimit: 10,
  triggerTimeoutMs: 5_000,
  headCheck: { minRemainingMs: 8_000, stopBelowMs: 4_000, perTick: 5 },
} as const;

/** Upper bound of one repo's overall head-check deadline. */
const HEAD_CHECK_REPO_MAX_MS = 9_000;

export interface KnowledgeReconcileSweepDeps {
  secret(): string;
  requeueExpired(now: Date): Promise<RequeuedKnowledgeIntent[]>;
  claimDue(now: Date, limit: number): Promise<ClaimedKnowledgeIntent[]>;
  fail(
    intentId: string,
    code: ReconcileErrorCode,
    now: Date,
  ): Promise<FailKnowledgeIntentResult>;
  trigger(row: ClaimedKnowledgeIntent): Promise<void>;
  alert(alert: KnowledgeIntentFailedAlert): Promise<unknown>;
  log: Pick<Console, "log" | "error">;
  listHeadCandidates(
    now: Date,
    slot: number,
    limit: number,
  ): Promise<KnowledgeHeadCheckCandidate[]>;
  readHead(
    row: KnowledgeHeadCheckCandidate,
    signal: AbortSignal,
  ): Promise<DefaultBranchHead>;
  recoverHead(
    row: KnowledgeHeadCheckCandidate,
    sha: string,
    defaultBranch: string,
    now: Date,
  ): Promise<{ outcome: RecoverKnowledgeHeadOutcome }>;
  budget?: {
    totalMs: number;
    claimLimit: number;
    triggerTimeoutMs: number;
    headCheck?: {
      minRemainingMs: number;
      stopBelowMs: number;
      perTick: number;
    };
  };
}

export interface KnowledgeReconcileSweepResult {
  disabled?: true;
  requeued: number;
  failed: number;
  dispatched: number;
  dispatchFailed: number;
  headChecked: number;
  headRecovered: number;
  headSkipped: number;
}

function defaultDeps(): KnowledgeReconcileSweepDeps {
  return {
    secret: () => env.KNOWLEDGE_RECONCILE_SECRET,
    requeueExpired: (now) => requeueExpiredKnowledgeIntents({ db, now }),
    claimDue: (now, limit) => claimDueKnowledgeIntents({ db, now, limit }),
    fail: (intentId, code, now) =>
      failKnowledgeIntent({ db, intentId, code, now }),
    trigger: async (row) => {
      const config = await resolveHatchetConfig({
        db,
        organizationId: row.organizationId,
        repoFullName: row.repoFullName,
      });
      const input: KnowledgeReconcileInput = {
        intentId: row.id,
        organizationId: row.organizationId,
        repoFullName: row.repoFullName,
        targetSha: row.targetSha,
      };
      await triggerWorkflow(
        KNOWLEDGE_RECONCILE_WORKFLOW,
        { ...input },
        config,
        {
          additionalMetadata: {
            orgId: row.organizationId,
            repoFullName: row.repoFullName,
            lane: "knowledge",
          },
          signal: AbortSignal.timeout(
            KNOWLEDGE_RECONCILE_BUDGET.triggerTimeoutMs,
          ),
        },
      );
    },
    alert: (alert) => postKnowledgeIntentFailedAlert(alert),
    listHeadCandidates: (now, slot, limit) =>
      listKnowledgeHeadCheckCandidates({ db, now, slot, limit }),
    readHead: (row, signal) =>
      readDefaultBranchHead({
        organizationId: row.organizationId,
        repoFullName: row.repoFullName,
        defaultBranch: row.defaultBranch,
        signal,
      }),
    recoverHead: (row, sha, defaultBranch, now) =>
      recoverKnowledgeHeadIntent({
        db,
        organizationId: row.organizationId,
        repoFullName: row.repoFullName,
        defaultBranch,
        headSha: sha,
        now,
      }),
    log: console,
  };
}

export async function runKnowledgeReconcileSweep(
  deps: KnowledgeReconcileSweepDeps = defaultDeps(),
  now: Date = new Date(),
): Promise<KnowledgeReconcileSweepResult> {
  const result: KnowledgeReconcileSweepResult = {
    requeued: 0,
    failed: 0,
    dispatched: 0,
    dispatchFailed: 0,
    headChecked: 0,
    headRecovered: 0,
    headSkipped: 0,
  };
  // Ship gate (PD-10): without the shared secret the worker cannot call back.
  if (deps.secret() === "") return { ...result, disabled: true };

  const budget = deps.budget ?? KNOWLEDGE_RECONCILE_BUDGET;
  const startedAt = Date.now();

  const reportFailed = async (f: {
    id: string;
    organizationId: string;
    repoFullName: string;
    code: string;
    attempts: number;
  }) => {
    result.failed += 1;
    deps.log.error("[cron:knowledge-reconcile] intent failed", {
      intentId: f.id,
      organizationId: f.organizationId,
      code: f.code,
      attempts: f.attempts,
    });
    try {
      await deps.alert({
        organizationId: f.organizationId,
        repoFullName: f.repoFullName,
        code: f.code,
        attempts: f.attempts,
      });
    } catch (error) {
      deps.log.error("[cron:knowledge-reconcile] alert failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  };

  try {
    const requeued = await deps.requeueExpired(now);
    result.requeued = requeued.length;
    for (const r of requeued) {
      if (r.becameFailed) await reportFailed(r);
    }
  } catch (error) {
    deps.log.error("[cron:knowledge-reconcile] requeue failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }

  let claimed: ClaimedKnowledgeIntent[];
  try {
    claimed = await deps.claimDue(now, budget.claimLimit);
  } catch (error) {
    deps.log.error("[cron:knowledge-reconcile] claim failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return result;
  }

  for (const row of claimed) {
    // Unprocessed rows stay `processing`; their lease expiry requeues them.
    if (Date.now() - startedAt >= budget.totalMs) break;
    try {
      await deps.trigger(row);
      result.dispatched += 1;
    } catch (error) {
      result.dispatchFailed += 1;
      deps.log.error("[cron:knowledge-reconcile] dispatch failed", {
        intentId: row.id,
        organizationId: row.organizationId,
        error: error instanceof Error ? error.name : "unknown",
      });
      try {
        const outcome = await deps.fail(row.id, "dispatch_failed", now);
        if (outcome.result === "recorded" && outcome.becameFailed) {
          await reportFailed({
            id: row.id,
            organizationId: outcome.organizationId,
            repoFullName: outcome.repoFullName,
            code: outcome.code,
            attempts: outcome.attempts,
          });
        }
      } catch (failError) {
        deps.log.error("[cron:knowledge-reconcile] fail record failed", {
          intentId: row.id,
          error: failError instanceof Error ? failError.name : "unknown",
        });
      }
    }
  }
  await runHeadCheck(deps, budget, startedAt, now, result);
  return result;
}

/**
 * D-03 / PD-19 head check. Runs after dispatch, only while at least
 * `minRemainingMs` of the sweep budget remain, and stops starting repos under
 * `stopBelowMs`. Each repo gets one overall deadline of
 * min(remaining - stopBelowMs, 9 s) passed into the GitHub read, so a slow
 * repo cannot overrun the sweep. Never throws; logs ids, enum outcomes and
 * integers only.
 */
async function runHeadCheck(
  deps: KnowledgeReconcileSweepDeps,
  budget: NonNullable<KnowledgeReconcileSweepDeps["budget"]>,
  startedAt: number,
  now: Date,
  result: KnowledgeReconcileSweepResult,
): Promise<void> {
  const cfg = budget.headCheck ?? KNOWLEDGE_RECONCILE_BUDGET.headCheck;
  const remaining = () => budget.totalMs - (Date.now() - startedAt);
  if (remaining() < cfg.minRemainingMs) {
    deps.log.log("[cron:knowledge-reconcile] head check skipped", {
      remainingMs: Math.max(0, Math.round(remaining())),
    });
    return;
  }
  const slot = Math.floor(now.getTime() / 60_000) % KNOWLEDGE_HEAD_CHECK_SLOTS;
  let candidates: KnowledgeHeadCheckCandidate[];
  try {
    candidates = await deps.listHeadCandidates(now, slot, cfg.perTick);
  } catch (error) {
    deps.log.error("[cron:knowledge-reconcile] head candidates failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return;
  }
  for (const row of candidates) {
    const left = remaining();
    if (left < cfg.stopBelowMs) break;
    const deadlineMs = Math.min(left - cfg.stopBelowMs, HEAD_CHECK_REPO_MAX_MS);
    if (deadlineMs <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const head = await deps.readHead(row, controller.signal);
      if (head.kind !== "ok") {
        result.headSkipped += 1;
        continue;
      }
      result.headChecked += 1;
      const recovered = await deps.recoverHead(
        row,
        head.sha,
        head.defaultBranch,
        now,
      );
      if (
        recovered.outcome === "inserted" ||
        recovered.outcome === "reopened"
      ) {
        result.headRecovered += 1;
        deps.log.log("[cron:knowledge-reconcile] head recovered", {
          organizationId: row.organizationId,
          outcome: recovered.outcome,
        });
      } else if (recovered.outcome !== "in_sync") {
        result.headSkipped += 1;
      }
    } catch (error) {
      result.headSkipped += 1;
      deps.log.error("[cron:knowledge-reconcile] head check failed", {
        organizationId: row.organizationId,
        error: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
