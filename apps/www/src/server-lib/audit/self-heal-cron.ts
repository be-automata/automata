import { db } from "@/lib/db";
import type { DB } from "@terragon/shared/db";
import { pruneSelfHealRows } from "@terragon/shared/model/self-heal-outbox";
import { redactSecrets } from "@terragon/utils/redact";

import { runAuditSweep, runOutboxDrain } from "./audit-sweep";
import { runStuckDraftSweep } from "./evaluate-fix-ci";
import { runFixDispatchReconcile } from "./fix-dispatch-reconcile";
import { runFixPrSettleSweep } from "./fix-pr-lifecycle";
import { runLoopBreakerEvaluation } from "./loop-breaker";
import { runFixPrOpenSweep } from "./open-fix-pr";
import { runSelfHealDispatcher } from "./self-heal-dispatcher";

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
  reconcile: typeof runFixDispatchReconcile;
  openPrs: typeof runFixPrOpenSweep;
  evaluateDrafts: typeof runStuckDraftSweep;
  settlePrs: typeof runFixPrSettleSweep;
  breakers: typeof runLoopBreakerEvaluation;
  dispatch: typeof runSelfHealDispatcher;
  budget: { totalMs: number; perItemMs: number; limit: number };
}

function defaultDeps(): SelfHealCronDeps {
  return {
    db,
    now: () => new Date(),
    drain: runOutboxDrain,
    sweep: runAuditSweep,
    prune: pruneSelfHealRows,
    reconcile: runFixDispatchReconcile,
    openPrs: runFixPrOpenSweep,
    evaluateDrafts: runStuckDraftSweep,
    settlePrs: runFixPrSettleSweep,
    breakers: runLoopBreakerEvaluation,
    dispatch: runSelfHealDispatcher,
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

  if (kind === "tick") {
    // RECON-01: settle lost dispatches and refund infra failures BEFORE the
    // dispatcher, so a refunded finding is claimable on this same tick and the
    // dispatcher's breaker reads include the events recorded here.
    await withinBudget("fix reconcile", remaining(), async () => {
      const result = await deps.reconcile({
        db: deps.db,
        now: deps.now(),
        deadlineAt,
        limit: deps.budget.limit,
      });
      console.log("[cron:self-heal] fix reconcile", result);
    });
    // RES-18 / GATE-01: resume draft-PR opens the route's waitUntil did not
    // finish (pending_open retries and reports nobody processed), before the
    // dispatcher so a slow GitHub cannot starve PR opens of a finished fix.
    await withinBudget("fix draft opens", remaining(), async () => {
      const result = await deps.openPrs({
        db: deps.db,
        now: deps.now(),
        deadlineAt,
        limit: deps.budget.limit,
      });
      console.log("[cron:self-heal] fix draft opens", result);
    });
    // GATE-01 steps 4-5: evaluate the repo CI on open drafts after the open
    // sweep (a draft opened above is seen on this tick). This is what moves a
    // draft whose CI completed without a later webhook (all-checks settle
    // window, no repo CI at all) and withdraws drafts stuck for an hour.
    await withinBudget("fix draft CI", remaining(), async () => {
      const result = await deps.evaluateDrafts({
        db: deps.db,
        now: deps.now(),
        deadlineAt,
        limit: deps.budget.limit,
      });
      console.log("[cron:self-heal] fix draft CI", result);
    });
    // R5: settle fix PRs GitHub already showed merged or closed when no
    // webhook did (an adopted PR, a draft the CI sweep saw a person close),
    // so the finding is not held by a finished attempt and the breakers
    // below see the pr_merged / pr_closed events.
    await withinBudget("fix PR settle", remaining(), async () => {
      const result = await deps.settlePrs({
        db: deps.db,
        now: deps.now(),
        deadlineAt,
        limit: deps.budget.limit,
      });
      console.log("[cron:self-heal] fix PR settle", result);
    });
    // BRK-01: the loop and plane breakers read the outcomes the reconcile,
    // the open sweep and the CI sweep just recorded, move expired opens to
    // half_open and resolve half-open probes, so the dispatcher below sees
    // the breaker state those outcomes imply.
    await withinBudget("breakers", remaining(), async () => {
      const result = await deps.breakers({
        db: deps.db,
        now: deps.now(),
        deadlineAt,
        limit: deps.budget.limit,
      });
      console.log("[cron:self-heal] breakers", result);
    });
    // BULK-01: the fix dispatcher runs LAST, so its admission sees the state
    // the drain and the sweep just settled, and it can only use what is left
    // of the shared budget.
    await withinBudget("fix dispatcher", remaining(), async () => {
      const result = await deps.dispatch({
        db: deps.db,
        now: deps.now(),
        deadlineAt,
      });
      console.log("[cron:self-heal] fix dispatcher", result);
    });
  }

  if (kind === "hourly") {
    // Retention runs even with the flag off (pending rows are never pruned).
    await withinBudget("retention prune", PRUNE_BUDGET_MS, async () => {
      const pruned = await deps.prune({ db: deps.db, now: deps.now() });
      console.log("[cron:self-heal] pruned", pruned);
    });
  }
}
