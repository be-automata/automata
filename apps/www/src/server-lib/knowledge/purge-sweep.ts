import { db } from "@/lib/db";
import { triggerWorkflow } from "@/agent/hatchet/transport";
import { resolveHatchetConfig } from "@/agent/hatchet/tenant-resolver";
import type { HatchetTriggerConfig } from "@/agent/hatchet/transport";
import { KNOWLEDGE_MIRROR_PURGE_WORKFLOW } from "@terragon/knowledge/reconcile-wire";
import {
  listKnowledgeOrgsDueForPurge,
  listKnowledgeRepoNamesForPurge,
  purgeKnowledgeData,
  type KnowledgePurgeCounts,
} from "@terragon/shared/model/knowledge-purge";

import {
  postKnowledgeMirrorPurgeFailedAlert,
  type KnowledgeMirrorPurgeFailedAlert,
} from "./ops-alert";

/**
 * OPS-04: purge knowledge data of orgs offboarded 7+ days ago. Runs LAST in the
 * hourly cron, bounded in time, never throws. Logs ids and integer counts only.
 * This file is the only allowed importer of knowledge-purge (12-05 static guard).
 */

export const KNOWLEDGE_PURGE_BUDGET = {
  totalMs: 20_000,
  perOrgMs: 10_000,
  limit: 10,
} as const;

export interface KnowledgePurgeSweepDeps {
  listDue(now: Date, limit: number): Promise<string[]>;
  purge(organizationId: string, now: Date): Promise<KnowledgePurgeCounts>;
  /** Repos with a cursor, read before the purge deletes them (D-11). */
  listRepos?(organizationId: string): Promise<string[]>;
  /** Engine routing for one repo (repo row, org '*' row, env). */
  resolveConfig?(
    organizationId: string,
    repoFullName: string,
  ): Promise<HatchetTriggerConfig>;
  /** Trigger knowledge-mirror-purge on one tenant. Needs no reconcile secret (PD-20). */
  triggerMirrorPurge?(
    config: HatchetTriggerConfig,
    organizationId: string,
  ): Promise<void>;
  alertMirrorPurgeFailed?(
    alert: KnowledgeMirrorPurgeFailedAlert,
  ): Promise<unknown>;
  log: Pick<Console, "log" | "error">;
  budget?: { totalMs: number; perOrgMs: number; limit: number };
}

export interface KnowledgePurgeSweepResult {
  purged: number;
  failed: number;
  timedOut: number;
}

function defaultDeps(): KnowledgePurgeSweepDeps {
  return {
    listDue: (now, limit) => listKnowledgeOrgsDueForPurge({ db, now, limit }),
    purge: (organizationId, now) =>
      purgeKnowledgeData({ db, organizationId, now }),
    listRepos: (organizationId) =>
      listKnowledgeRepoNamesForPurge({ db, organizationId }),
    resolveConfig: (organizationId, repoFullName) =>
      resolveHatchetConfig({ db, organizationId, repoFullName }),
    triggerMirrorPurge: async (config, organizationId) => {
      await triggerWorkflow(
        KNOWLEDGE_MIRROR_PURGE_WORKFLOW,
        { organizationId },
        config,
        {
          additionalMetadata: { orgId: organizationId, lane: "knowledge" },
          signal: AbortSignal.timeout(5_000),
        },
      );
    },
    alertMirrorPurgeFailed: (alert) =>
      postKnowledgeMirrorPurgeFailedAlert(alert),
    log: console,
  };
}

type Outcome =
  | { status: "done"; counts: KnowledgePurgeCounts }
  | { status: "timeout" }
  | { status: "error"; name: string };

/**
 * Race the work against its slot. A timeout cannot cancel the purge
 * transaction (it commits or rolls back on its own), so `onLate` receives the
 * outcome it settles with after the slot ended.
 */
async function withinBudget(
  ms: number,
  work: () => Promise<KnowledgePurgeCounts>,
  onLate: (outcome: Outcome) => void,
): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), Math.max(ms, 0));
  });
  const run = (async (): Promise<Outcome> => {
    try {
      return { status: "done", counts: await work() };
    } catch (error) {
      return {
        status: "error",
        name: error instanceof Error ? error.name : "unknown",
      };
    }
  })();
  try {
    const outcome = await Promise.race([run, timeout]);
    if (outcome.status === "timeout") {
      void (async () => onLate(await run))();
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * D-11 / PD-4: delete the worker-disk mirrors of a purged org, once per
 * distinct engine tenant serving its repos. PD-20: no secret gate, and the
 * tenants come only from per-repo routing. Every failure is recorded (one log
 * line and one alert per reason); never throws.
 */
async function dispatchMirrorPurge(
  deps: KnowledgePurgeSweepDeps,
  organizationId: string,
  repos: string[] | null,
): Promise<void> {
  if (!deps.resolveConfig || !deps.triggerMirrorPurge) return;
  const failures: Record<KnowledgeMirrorPurgeFailedAlert["reason"], number> = {
    routing_unresolved: 0,
    trigger_failed: 0,
  };
  if (repos === null) {
    failures.routing_unresolved += 1;
  } else {
    const tenants = new Map<string, HatchetTriggerConfig>();
    for (const repo of repos) {
      try {
        const config = await deps.resolveConfig(organizationId, repo);
        tenants.set(`${config.apiUrl}|${config.tenantId}`, config);
      } catch {
        failures.routing_unresolved += 1;
      }
    }
    for (const config of tenants.values()) {
      try {
        await deps.triggerMirrorPurge(config, organizationId);
      } catch {
        failures.trigger_failed += 1;
      }
    }
  }
  for (const reason of ["routing_unresolved", "trigger_failed"] as const) {
    const count = failures[reason];
    if (count === 0) continue;
    deps.log.error("[cron:knowledge-purge] mirror purge dispatch failed", {
      organizationId,
      reason,
      count,
    });
    try {
      await deps.alertMirrorPurgeFailed?.({ organizationId, reason, count });
    } catch {
      // The alert sender never throws by contract; a fake that does must not
      // break the sweep.
    }
  }
}

async function readRepos(
  deps: KnowledgePurgeSweepDeps,
  organizationId: string,
): Promise<string[] | null> {
  if (!deps.listRepos) return [];
  try {
    return await deps.listRepos(organizationId);
  } catch {
    return null;
  }
}

export async function runKnowledgePurgeSweep(
  deps: KnowledgePurgeSweepDeps = defaultDeps(),
  now: Date = new Date(),
): Promise<KnowledgePurgeSweepResult> {
  const result: KnowledgePurgeSweepResult = {
    purged: 0,
    failed: 0,
    timedOut: 0,
  };
  const budget = deps.budget ?? KNOWLEDGE_PURGE_BUDGET;
  const startedAt = Date.now();
  let due: string[];
  try {
    due = await deps.listDue(now, budget.limit);
  } catch (error) {
    deps.log.error("[cron:knowledge-purge] listing failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return result;
  }
  for (const organizationId of due) {
    const remaining = budget.totalMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    const slotMs = Math.min(budget.perOrgMs, remaining);
    // Cursors are deleted by the purge: read the repos first.
    const repos = await readRepos(deps, organizationId);
    const outcome = await withinBudget(
      slotMs,
      () => deps.purge(organizationId, now),
      (late) => {
        if (late.status === "done") {
          deps.log.log("[cron:knowledge-purge] finished after timeout", {
            organizationId,
            ...late.counts,
          });
          void dispatchMirrorPurge(deps, organizationId, repos);
        } else if (late.status === "error") {
          deps.log.error("[cron:knowledge-purge] failed after timeout", {
            organizationId,
            error: late.name,
          });
        }
      },
    );
    if (outcome.status === "done") {
      result.purged += 1;
      deps.log.log("[cron:knowledge-purge]", {
        organizationId,
        ...outcome.counts,
      });
      await dispatchMirrorPurge(deps, organizationId, repos);
    } else if (outcome.status === "timeout") {
      result.timedOut += 1;
      deps.log.error("[cron:knowledge-purge]", {
        organizationId,
        error: "timeout",
      });
      // A slot cut to the remaining total budget that timed out spent it. Stop
      // here rather than trust the clock: a timer can fire a ms early.
      if (slotMs === remaining) break;
    } else {
      result.failed += 1;
      deps.log.error("[cron:knowledge-purge]", {
        organizationId,
        error: outcome.name,
      });
    }
  }
  return result;
}
