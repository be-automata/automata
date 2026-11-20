import {
  CELL_EGRESS_REASONS,
  CellPlanRefusedError,
  CellPlanUnavailableError,
} from "./cell-www-client";
import { CellRunRefusedError } from "./run-executor";

/**
 * #718: the worker-authored line a thread shows when a marked run was refused
 * before its daemon started (`run-failed-unreported`, `detail.info`).
 *
 * Built only from a closed allowlist: the route's own string, the error
 * message (it names internal config), the HTTP status and any id or token are
 * never echoed. A code outside the map prints as `unknown`.
 *
 * `resend`: dispatch re-checks the condition, so sending the message again runs
 * it where it is allowed now. `named`: a resend fails the same way, so only the
 * reason is shown.
 */
export type CellRefusalKind = "resend" | "named";

export const CELL_REFUSAL_KINDS = {
  // Resend helps: the next dispatch re-checks and routes the run elsewhere.
  cells_disabled: "resend",
  agent_not_supported: "resend",
  unknown_profile: "resend",
  egress_not_enforced: "resend",
  egress_level_unsupported: "resend",
  egress_compile_failed: "resend",
  no_model_credential: "resend",
  cell_plan_unavailable: "resend",
  cell_plan_superseded: "resend",
  // Reason only: a resend is marked again and fails the same way.
  cells_unconfigured: "named",
  cell_lane_refused: "named",
  no_run_key: "named",
  invalid_run_key: "named",
  org_required: "named",
  invalid_deployment_tag: "named",
  invalid_body: "named",
  thread_terminal: "named",
  work_branch_unresolved: "named",
  step_done: "named",
  conflict: "named",
  attempt_limit: "named",
  runtime_not_runc: "named",
  bearer_refused: "named",
  egress_wildcard: "named",
  cell_plan_mismatch: "named",
  unknown: "named",
} as const satisfies Record<string, CellRefusalKind>;

export type CellRefusalCode = keyof typeof CELL_REFUSAL_KINDS;

const RESEND_LINE = "Send the message again: it runs where it is allowed now.";
const CELLS_UNCONFIGURED_HINT =
  "cells are not configured on this execution plane";

function isCellRefusalCode(code: string): code is CellRefusalCode {
  return Object.hasOwn(CELL_REFUSAL_KINDS, code);
}

/** The thread text for a refused cell run, or undefined for any other error. */
export function cellRefusalInfo(err: unknown): string | undefined {
  if (
    !(
      err instanceof CellPlanRefusedError ||
      err instanceof CellPlanUnavailableError ||
      err instanceof CellRunRefusedError
    )
  ) {
    return undefined;
  }
  const code: CellRefusalCode = isCellRefusalCode(err.code)
    ? err.code
    : "unknown";
  // Re-checked here, not only in fetchCellPlan: the allowlist holds whoever
  // built the error.
  const reason =
    err instanceof CellPlanRefusedError &&
    err.reason !== undefined &&
    (CELL_EGRESS_REASONS as readonly string[]).includes(err.reason)
      ? err.reason
      : undefined;
  const head = `The cell refused this run before it started (${
    reason ? `${code}: ${reason}` : code
  })`;
  if (code === "cells_unconfigured") {
    return `${head}: ${CELLS_UNCONFIGURED_HINT}.`;
  }
  return CELL_REFUSAL_KINDS[code] === "resend"
    ? `${head}. ${RESEND_LINE}`
    : `${head}.`;
}
