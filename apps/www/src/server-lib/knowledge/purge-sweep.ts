import { db } from "@/lib/db";
import {
  listKnowledgeOrgsDueForPurge,
  purgeKnowledgeData,
  type KnowledgePurgeCounts,
} from "@terragon/shared/model/knowledge-purge";

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
    log: console,
  };
}

type Outcome =
  | { status: "done"; counts: KnowledgePurgeCounts }
  | { status: "timeout" }
  | { status: "error"; name: string };

async function withinBudget(
  ms: number,
  work: () => Promise<KnowledgePurgeCounts>,
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
    return await Promise.race([run, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
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
    const outcome = await withinBudget(slotMs, () =>
      deps.purge(organizationId, now),
    );
    if (outcome.status === "done") {
      result.purged += 1;
      deps.log.log("[cron:knowledge-purge]", {
        organizationId,
        ...outcome.counts,
      });
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
