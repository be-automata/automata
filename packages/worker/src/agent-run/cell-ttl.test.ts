import { beforeAll, describe, expect, it, vi } from "vitest";
import { CELL_RUN_TTL_MS } from "@terragon/types/cell";

import { buildAgentRunDefinition } from "./definition";
import {
  REGISTERED_EXECUTION_TIMEOUT_MS,
  TASK_LANE_BUDGET,
  TASK_LANE_EXECUTION_TIMEOUT_MS,
  TASK_LANE_REFRESH,
} from "./run-budget";
import {
  CELL_ABNORMAL_POST_MAX_MS,
  CELL_TEARDOWN_DEADLINE_MS,
  CELL_TEARDOWN_WORST_CASE_MS,
} from "./cell-teardown";

// The workflow module runs Hatchet.init() at import: give it a syntactically
// valid unsigned token (no network), as workflow.test.ts does.
function fakeHatchetToken(): string {
  const enc = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc({
    sub: "tenant-test",
    server_url: "http://localhost:8888",
    grpc_broadcast_address: "localhost:7070",
  })}.sig`;
}
process.env.HATCHET_CLIENT_TOKEN = fakeHatchetToken();
process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";
vi.mock("./reclaim", () => ({
  reclaimDeadWorkerRuns: vi.fn(),
  reapOwnThreadAttempts: vi.fn().mockReturnValue(0),
}));

const TEARDOWN_MARGIN_MS = 15 * 60_000;

/** A Hatchet duration such as "30m" in ms. Only the units the definition uses. */
function parseDuration(d: unknown): number {
  if (typeof d !== "string")
    throw new Error("executionTimeout is not a string");
  const m = /^(\d+)(s|m|h)$/.exec(d);
  if (!m) throw new Error(`unsupported duration ${d}`);
  const n = Number(m[1]);
  return n * { s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
}

describe("cell TTL pin (T-TTL, AC-16)", () => {
  let workflowMirrorMs: number;
  beforeAll(async () => {
    const wf = await import("./workflow");
    workflowMirrorMs = wf.RUN_EXECUTION_TIMEOUT_MS;
  });

  // card: protects=CELL_RUN_TTL_MS is the TASK-LANE run budget (cells run task runs only) plus the 15 min teardown margin, and that budget is the registered timeout plus the refresh; fails_when=the registered timeout, the refresh, the task budget or CELL_RUN_TTL_MS moves without the others; no_claim=the server-side TTL cap (deploy-assets.test.ts) and the engine honouring the refresh (refresh-timeout.integration.test.ts)
  it("task-lane budget + 15 min === CELL_RUN_TTL_MS", () => {
    const def = buildAgentRunDefinition("agent-run", null);
    const registered = parseDuration(def.task.executionTimeout);
    expect(registered).toBe(30 * 60_000);
    expect(registered).toBe(REGISTERED_EXECUTION_TIMEOUT_MS);
    expect(workflowMirrorMs).toBe(registered);
    // Additive refresh (measured, hatchet-lite v0.94.10): registered + refresh = budget.
    expect(registered + parseDuration(TASK_LANE_REFRESH)).toBe(
      parseDuration(TASK_LANE_BUDGET),
    );
    expect(parseDuration(TASK_LANE_BUDGET)).toBe(
      TASK_LANE_EXECUTION_TIMEOUT_MS,
    );
    expect(TASK_LANE_EXECUTION_TIMEOUT_MS + TEARDOWN_MARGIN_MS).toBe(
      CELL_RUN_TTL_MS,
    );
    expect(REGISTERED_EXECUTION_TIMEOUT_MS).toBeLessThan(
      TASK_LANE_EXECUTION_TIMEOUT_MS,
    );
  });

  // card: protects=the parser reads the definition's own string, so a changed timeout would fail the pin; fails_when=parseDuration ignores its input; no_claim=anything about the engine
  it("negative control: a 40m budget would not satisfy the pin", () => {
    expect(parseDuration("40m") + TEARDOWN_MARGIN_MS).not.toBe(CELL_RUN_TTL_MS);
  });

  // card: protects=the cell teardown's worst case (deadline, then A and P on their grace) stays well under onFailure's wait for the run's own teardown; fails_when=the deadline or the A cap grows until onFailure posts run-failed first; no_claim=real wall time
  it("M3: the teardown budget fits inside onFailure's typed-terminal wait", async () => {
    const wf = await import("./workflow");
    expect(CELL_TEARDOWN_DEADLINE_MS).toBeLessThanOrEqual(70_000);
    expect(CELL_ABNORMAL_POST_MAX_MS).toBeLessThanOrEqual(30_000);
    expect(CELL_TEARDOWN_WORST_CASE_MS).toBeLessThan(
      wf.ON_FAILURE_TYPED_TERMINAL_WAIT_MS,
    );
    // and leaves at least 30 s of margin
    expect(CELL_TEARDOWN_WORST_CASE_MS + 30_000).toBeLessThanOrEqual(
      wf.ON_FAILURE_TYPED_TERMINAL_WAIT_MS,
    );
  });
});
