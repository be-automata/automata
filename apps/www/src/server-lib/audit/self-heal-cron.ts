import { db } from "@/lib/db";
import type { DB } from "@terragon/shared/db";
import { pruneSelfHealRows } from "@terragon/shared/model/self-heal-outbox";
import { redactSecrets } from "@terragon/utils/redact";

import { runAuditSweep, runOutboxDrain } from "./audit-sweep";

/**
 * The self-heal cron (CRON-01, RESILIENCE 6.6): a function of its own, called
 * LAST from runScheduledCron, so a slow GitHub call here can never delay or
 * skip the review sweep, the prunes or the stalled-thread stop. It is bounded
 * by a total deadline and per-item deadlines, and never throws.
 */

export const SELF_HEAL_CRON_BUDGET = {
  totalMs: 120_000,
  perItemMs: 20_000,
  limit: 20,
} as const;

/** The retention prune is one bounded DB transaction. */
const PRUNE_BUDGET_MS = 10_000;

export type SelfHealCronKind = "tick" | "hourly";

export interface SelfHealCronDeps {
  db: DB;
  now: () => Date;
  drain: typeof runOutboxDrain;
  sweep: typeof runAuditSweep;
  prune: typeof pruneSelfHealRows;
  budget: { totalMs: number; perItemMs: number; limit: number };
}

function defaultDeps(): SelfHealCronDeps {
  return {
    db,
    now: () => new Date(),
    drain: runOutboxDrain,
    sweep: runAuditSweep,
    prune: pruneSelfHealRows,
    budget: SELF_HEAL_CRON_BUDGET,
  };
}

function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** Resolves when `work` settles or `ms` elapses, whichever is first. Never rejects. */
async function withinBudget(
  name: string,
  ms: number,
  work: () => Promise<unknown>,
): Promise<"done" | "timeout" | "error"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(ms, 0));
  });
  const run = (async (): Promise<"done" | "error"> => {
    try {
      await work();
      return "done";
    } catch (error) {
      console.error(`[cron:self-heal] ${name} failed`, {
        error: errorText(error),
      });
      return "error";
    }
  })();
  try {
    const outcome = await Promise.race([run, timeout]);
    if (outcome === "timeout") {
      console.error(`[cron:self-heal] ${name} abandoned at its deadline`);
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runSelfHealCron(
  kind: SelfHealCronKind,
  deps: SelfHealCronDeps = defaultDeps(),
): Promise<void> {
  const startedAt = deps.now().getTime();
  const deadlineAt = new Date(startedAt + deps.budget.totalMs);
  const remaining = () => deadlineAt.getTime() - deps.now().getTime();
  const shared = {
    db: deps.db,
    deadlineAt,
    perItemMs: deps.budget.perItemMs,
    limit: deps.budget.limit,
  };

  await withinBudget("outbox drain", remaining(), async () => {
    const result = await deps.drain({ ...shared, now: deps.now() });
    console.log("[cron:self-heal] outbox drain", result);
  });
  await withinBudget("audit sweep", remaining(), async () => {
    const result = await deps.sweep({ ...shared, now: deps.now() });
    console.log("[cron:self-heal] audit sweep", result);
  });

  if (kind === "hourly") {
    // Retention runs even with the flag off (pending rows are never pruned).
    await withinBudget("retention prune", PRUNE_BUDGET_MS, async () => {
      const pruned = await deps.prune({ db: deps.db, now: deps.now() });
      console.log("[cron:self-heal] pruned", pruned);
    });
  }
}
