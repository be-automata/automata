import { db } from "@/lib/db";
import { triggerWorkflow } from "@/agent/hatchet/transport";
import { resolveHatchetConfig } from "@/agent/hatchet/tenant-resolver";
import {
  claimDueKnowledgeIntents,
  failKnowledgeIntent,
  requeueExpiredKnowledgeIntents,
  type ClaimedKnowledgeIntent,
  type FailKnowledgeIntentResult,
  type RequeuedKnowledgeIntent,
} from "@terragon/shared/model/knowledge-intent";
import {
  KNOWLEDGE_RECONCILE_WORKFLOW,
  type KnowledgeReconcileInput,
  type ReconcileErrorCode,
} from "@terragon/knowledge/reconcile-wire";
import { env } from "@terragon/env/apps-www";

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
 */

export const KNOWLEDGE_RECONCILE_BUDGET = {
  totalMs: 20_000,
  claimLimit: 10,
  triggerTimeoutMs: 5_000,
} as const;

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
  budget?: { totalMs: number; claimLimit: number; triggerTimeoutMs: number };
}

export interface KnowledgeReconcileSweepResult {
  disabled?: true;
  requeued: number;
  failed: number;
  dispatched: number;
  dispatchFailed: number;
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
  return result;
}
