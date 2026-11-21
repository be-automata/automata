import type { Duration } from "@hatchet-dev/typescript-sdk";

import { resolveRunLane } from "./run-lane";
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

/** Mirror of definition.ts `executionTimeout: "30m"` (pinned by a test). */
export const REGISTERED_EXECUTION_TIMEOUT_MS = 30 * 60_000;
/** Mirror of `TASK_LANE_BUDGET`; CELL_RUN_TTL_MS is this plus 15 minutes. */
export const TASK_LANE_EXECUTION_TIMEOUT_MS = 60 * 60_000;
/** The refresh is a control-plane call; it must never hold the run up. */
export const REFRESH_DEADLINE_MS = 10_000;

/** The slice of the run ctx the budget needs. */
export interface BudgetCtx {
  log: (message: string) => void;
  refreshTimeout?: (incrementBy: Duration) => Promise<void>;
}

/** Task lane, not self-heal: the one run shape that gets the 60-minute budget. */
export function refreshesRunBudget(wire: AgentRunWireInput): boolean {
  return resolveRunLane(wire) === "task" && wire.selfHeal === undefined;
}

/** The execution budget a run is entitled to, before any refresh failure. */
export function runExecutionBudgetMs(wire: AgentRunWireInput): number {
  return refreshesRunBudget(wire)
    ? TASK_LANE_EXECUTION_TIMEOUT_MS
    : REGISTERED_EXECUTION_TIMEOUT_MS;
}

async function boundedRefresh(ctx: BudgetCtx): Promise<void> {
  if (!ctx.refreshTimeout) throw new Error("no refreshTimeout on the context");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("refresh timed out")),
      REFRESH_DEADLINE_MS,
    );
  });
  try {
    await Promise.race([ctx.refreshTimeout(TASK_LANE_REFRESH), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extend a task-lane run to its budget and return the EFFECTIVE budget in ms:
 * the task lane's 60 minutes once the refresh resolved, else the registered 30
 * (a timeout, a rejection or a missing context). Fails open with one log line;
 * a failed refresh never fails the run.
 */
export async function applyRunBudget(
  wire: AgentRunWireInput,
  ctx: BudgetCtx,
): Promise<number> {
  if (!refreshesRunBudget(wire)) return REGISTERED_EXECUTION_TIMEOUT_MS;
  const tag = `[agent-run ${wire.threadId}]`;
  try {
    await boundedRefresh(ctx);
    ctx.log(`${tag} run budget: ${TASK_LANE_BUDGET} (refreshed)`);
    return TASK_LANE_EXECUTION_TIMEOUT_MS;
  } catch {
    ctx.log(`${tag} run budget: refresh failed, staying at 30m`);
    return REGISTERED_EXECUTION_TIMEOUT_MS;
  }
}
