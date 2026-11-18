import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import type { RunSecrets } from "@terragon/utils/payload-seal";

import type { AbnormalEndState } from "./abnormal-end";
import type { CellConfig } from "./cell-config";
import type { loadWorkerConfig } from "./config";
import type { TokenRevoker } from "./revoke-installation-tokens";
import { resolveRunLane } from "./run-lane";
import type { RunCtx } from "./run-admission";
import type { AgentRunInput, AgentRunOutput } from "./types";
import type { WwwClientOpts } from "./www-client";

/**
 * The seam between the outer run wrapper (`runAgentResolved`) and WHERE a run
 * executes (#656 PR-E): the box (today's `runAgentInner`, byte for byte) or a
 * cell (cell-run.ts). Chosen once per run, by the marker dispatch stamps
 * (`input.cell`), never by an `if (cell)` branch inside the box path. Both
 * executors are injected, so this module imports no cell module at runtime.
 */

/** Why a marked run was refused before admission (nothing held, nothing sent). */
export type CellRunRefusedCode = "cells_unconfigured" | "cell_lane_refused";

/** A marked run that must not run in a cell and must never fall back to the box. */
export class CellRunRefusedError extends NonRetryableError {
  constructor(public readonly code: CellRunRefusedCode) {
    super(
      code === "cells_unconfigured"
        ? "cells_unconfigured: the run is marked for a cell but this worker has no valid WORKER_OPENSANDBOX_* configuration"
        : "cell_lane_refused: only a plain task run may execute in a cell",
    );
    this.name = "CellRunRefusedError";
  }
}

export interface RunExecutorInput {
  input: AgentRunInput;
  secrets: RunSecrets;
  revoker: TokenRevoker;
  ctx: RunCtx;
  config: ReturnType<typeof loadWorkerConfig>;
  /** The run's opts; the cell executor derives a copy with `cellAttempt`. */
  wwwOpts: WwwClientOpts;
  runStartedAt: number;
  /** #371 reservation key, from runAgentResolved. */
  runKey: string;
  /** #437, shared with runAgentResolved so one abnormal terminal is posted. */
  abnormal: AbnormalEndState;
  /**
   * The cell config `selectRunExecutor` read for a marked run (read once, then
   * passed through). Undefined for a box run.
   */
  cellConfig?: CellConfig;
}

export interface RunExecutor {
  readonly kind: "box" | "cell";
  run(args: RunExecutorInput): Promise<AgentRunOutput>;
}

export interface RunExecutorDeps {
  box: RunExecutor;
  cell: RunExecutor;
  /** Read ONLY for a marked run, so an unmarked run never touches the key file. */
  loadCellConfig: () => CellConfig | Promise<CellConfig>;
}

/**
 * No marker: the box. Marker on a plain task run with a valid config: the
 * cell. Any other marked run is refused, before admission: the marker is the
 * only switch, and the worker never runs an unmarked run in a cell nor a
 * marked one on the box.
 */
export async function selectRunExecutor(
  input: AgentRunInput,
  deps: RunExecutorDeps,
): Promise<RunExecutor> {
  if (input.cell === undefined) return deps.box;
  if (
    resolveRunLane(input) !== "task" ||
    input.selfHeal !== undefined ||
    input.reviewAgent !== undefined
  ) {
    throw new CellRunRefusedError("cell_lane_refused");
  }
  if ((await deps.loadCellConfig()).kind !== "on") {
    throw new CellRunRefusedError("cells_unconfigured");
  }
  return deps.cell;
}
