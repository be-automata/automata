import type { Duration } from "@hatchet-dev/typescript-sdk";
import {
  REGISTERED_EXECUTION_TIMEOUT,
  TASK_LANE_EXECUTION_TIMEOUT,
} from "@terragon/types/cell";

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

/** An error's class name when it is a plain identifier, else `unknown`. */
function errorClassOf(error: unknown): string {
  return error instanceof Error && /^[A-Za-z_$][\w$]{0,63}$/.test(error.name)
    ? error.name
    : "unknown";
}

/** The refresh raced against its bound: "ok" when it resolved in time, else why not. */
async function boundedRefresh(
  ctx: BudgetCtx,
): Promise<"ok" | "timeout" | "no context"> {
  if (!ctx.refreshTimeout) return "no context";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), REFRESH_DEADLINE_MS);
  });
  try {
    return await Promise.race([
      ctx.refreshTimeout(TASK_LANE_REFRESH).then(() => "ok" as const),
      deadline,
    ]);
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
 */
export async function applyRunBudget(
  wire: AgentRunWireInput,
  ctx: BudgetCtx,
): Promise<number> {
  if (!refreshesRunBudget(wire)) return REGISTERED_EXECUTION_TIMEOUT;
  const tag = `[agent-run ${wire.threadId}]`;
  let cause: string;
  try {
    const outcome = await boundedRefresh(ctx);
    if (outcome === "ok") {
      ctx.log(`${tag} run budget: ${TASK_LANE_BUDGET} (refreshed)`);
      return TASK_LANE_EXECUTION_TIMEOUT;
    }
    cause = outcome;
  } catch (error: unknown) {
    cause = `rejected: ${errorClassOf(error)}`;
  }
  ctx.log(`${tag} run budget: refresh failed (${cause}), staying at 30m`);
  return REGISTERED_EXECUTION_TIMEOUT;
}
