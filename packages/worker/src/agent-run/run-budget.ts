import type { Duration } from "@hatchet-dev/typescript-sdk";
import {
  REGISTERED_EXECUTION_TIMEOUT,
  TASK_LANE_EXECUTION_TIMEOUT,
} from "@terragon/types/cell";
import { isCellEligibleLane } from "@terragon/utils/run-lane";

import type { AgentRunWireInput } from "./run-secrets";

/**
 * #742: the task lane's run budget. The task is registered with a 30-minute
 * `executionTimeout` (definition.ts) shared by every lane; a task-lane,
 * non-self-heal run extends its OWN timeout once, at start, with
 * `ctx.refreshTimeout(TASK_LANE_REFRESH)`.
 *
 * `TASK_LANE_REFRESH` follows the engine semantics MEASURED by
 * refresh-timeout.integration.test.ts on hatchet-lite v0.94.10 (recorded in
 * docs/uat/hatchet-lite-v0.94.10-observed.md section 7). Additive means the
 * refresh adds the interval to the run's current deadline, so 30m on top of the
 * registered 30m gives the 60m budget; reset-from-now would need "60m". The IT
 * fails if this constant and the engine disagree.
 */
export const TASK_LANE_BUDGET: Duration = "60m";
export const TASK_LANE_REFRESH: Duration = "30m";

/** The refresh is a control-plane call; it must never hold the run up. */
export const REFRESH_DEADLINE_MS = 10_000;

/** The slice of the run ctx the budget needs. */
export interface BudgetCtx {
  log: (message: string) => void;
  refreshTimeout?: (incrementBy: Duration) => Promise<void>;
}

/**
 * A task-lane, non-self-heal run marked for a CELL: the one run shape that gets
 * the 60-minute budget. Box runs keep 30 minutes for now: their git/gh brokers
 * push with the installation token minted at dispatch, which GitHub expires
 * after about an hour, so a 60-minute box run (and its timeout salvage push)
 * would outlive its credential. A cell's broker mints a token per request.
 * The `cell` marker is the worker's only cell switch (run-executor.ts): a
 * marked run runs in a cell or is refused, never on the box.
 */
export function refreshesRunBudget(wire: AgentRunWireInput): boolean {
  // isCellEligibleLane is the run shape selectRunExecutor admits to a cell
  // (#757): one predicate, so the budget cannot disagree with the executor.
  return wire.cell !== undefined && isCellEligibleLane(wire);
}

/** An error's class name when it is a plain identifier, else `unknown`. */
function errorClassOf(error: unknown): string {
  return error instanceof Error && /^[A-Za-z_$][\w$]{0,63}$/.test(error.name)
    ? error.name
    : "unknown";
}

/**
 * The refresh raced against its bound: "ok" when it resolved in time, else why
 * not. On "timeout" the refresh is still in flight and the engine may yet apply
 * it, so it is handed back to the caller (`late`).
 */
async function boundedRefresh(
  ctx: BudgetCtx,
): Promise<
  { outcome: "ok" | "no context" } | { outcome: "timeout"; late: Promise<void> }
> {
  if (!ctx.refreshTimeout) return { outcome: "no context" };
  const call = ctx.refreshTimeout(TASK_LANE_REFRESH);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), REFRESH_DEADLINE_MS);
  });
  try {
    const won = await Promise.race([call.then(() => "ok" as const), deadline]);
    return won === "ok"
      ? { outcome: "ok" }
      : { outcome: "timeout", late: call };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extend a task-lane run to its budget and return the EFFECTIVE budget in ms:
 * the task lane's 60 minutes once the refresh resolved, else the registered 30
 * (a timeout, a rejection or a missing context). Fails open with one log line
 * naming the cause class (`timeout`, `no context`, `rejected: <ErrorName>`),
 * never the error's message; a failed refresh never fails the run.
 *
 * A refresh that resolves AFTER the bound was still applied by the engine:
 * `onLateRefresh` is called so the caller can raise its recorded budget to the
 * task lane's (the abnormal-end classifier and copy must follow what the
 * engine enforces). A late rejection changes nothing.
 */
export async function applyRunBudget(
  wire: AgentRunWireInput,
  ctx: BudgetCtx,
  onLateRefresh?: (budgetMs: number) => void,
): Promise<number> {
  if (!refreshesRunBudget(wire)) return REGISTERED_EXECUTION_TIMEOUT;
  const tag = `[agent-run ${wire.threadId}]`;
  let cause: string;
  try {
    const result = await boundedRefresh(ctx);
    if (result.outcome === "ok") {
      ctx.log(`${tag} run budget: ${TASK_LANE_BUDGET} (refreshed)`);
      return TASK_LANE_EXECUTION_TIMEOUT;
    }
    if (result.outcome === "timeout") {
      result.late.then(
        () => {
          ctx.log(`${tag} run budget: ${TASK_LANE_BUDGET} (refreshed late)`);
          onLateRefresh?.(TASK_LANE_EXECUTION_TIMEOUT);
        },
        () => {
          // Rejected after the bound: the run keeps the registered budget.
        },
      );
    }
    cause = result.outcome;
  } catch (error: unknown) {
    cause = `rejected: ${errorClassOf(error)}`;
  }
  ctx.log(`${tag} run budget: refresh failed (${cause}), staying at 30m`);
  return REGISTERED_EXECUTION_TIMEOUT;
}
