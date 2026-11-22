import { describe, expect, it, vi } from "vitest";
import {
  CELL_RUN_TTL_MS,
  CELL_TEARDOWN_MARGIN,
  REGISTERED_EXECUTION_TIMEOUT,
  SCHEDULE_TIMEOUT,
  TASK_LANE_EXECUTION_TIMEOUT,
} from "@terragon/types/cell";

import { CELL_TIMEOUT_CAPTURE_BUDGET_MS } from "./cell-run";
import { buildAgentRunDefinition } from "./definition";
import { TASK_LANE_BUDGET, TASK_LANE_REFRESH } from "./run-budget";
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
  // card: protects=CELL_RUN_TTL_MS is the TASK-LANE run budget (cells run task runs only) plus the 15 min teardown margin, and that budget is the registered timeout plus the refresh; fails_when=the registered timeout, the refresh, the task budget or CELL_RUN_TTL_MS moves without the others; no_claim=the server-side TTL cap (deploy-assets.test.ts) and the engine honouring the refresh (refresh-timeout.integration.test.ts)
  it("task-lane budget + 15 min === CELL_RUN_TTL_MS", () => {
    const def = buildAgentRunDefinition("agent-run", null);
    const registered = parseDuration(def.task.executionTimeout);
    // The Hatchet strings are pinned against the ms constants they mirror.
    expect(registered).toBe(REGISTERED_EXECUTION_TIMEOUT);
    expect(parseDuration(def.task.scheduleTimeout)).toBe(SCHEDULE_TIMEOUT);
    // Additive refresh (measured, hatchet-lite v0.94.10): registered + refresh = budget.
    expect(registered + parseDuration(TASK_LANE_REFRESH)).toBe(
      parseDuration(TASK_LANE_BUDGET),
    );
    expect(parseDuration(TASK_LANE_BUDGET)).toBe(TASK_LANE_EXECUTION_TIMEOUT);
    expect(TASK_LANE_EXECUTION_TIMEOUT + CELL_TEARDOWN_MARGIN).toBe(
      CELL_RUN_TTL_MS,
    );
  });

  // card: protects=the parser reads the definition's own string, so a changed timeout would fail the pin; fails_when=parseDuration ignores its input; no_claim=anything about the engine
  it("negative control: a 40m budget would not satisfy the pin", () => {
    expect(parseDuration("40m") + CELL_TEARDOWN_MARGIN).not.toBe(
      CELL_RUN_TTL_MS,
    );
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

  // card: protects=#743 OQ-4: the timeout capture (40 s), the cell teardown's worst case (80 s) and 30 s of slack fit inside onFailure's 150 s wait, so the typed timeout still wins the first-terminal race; fails_when=the capture budget, the teardown budget or the wait moves without the others; no_claim=real wall time
  it("OQ-4: 40 s capture + 80 s teardown + 30 s slack <= the 150 s wait", async () => {
    const wf = await import("./workflow");
    expect(CELL_TIMEOUT_CAPTURE_BUDGET_MS).toBe(40_000);
    expect(CELL_TEARDOWN_WORST_CASE_MS).toBe(80_000);
    expect(wf.ON_FAILURE_TYPED_TERMINAL_WAIT_MS).toBe(150_000);
    expect(
      CELL_TIMEOUT_CAPTURE_BUDGET_MS + CELL_TEARDOWN_WORST_CASE_MS + 30_000,
    ).toBeLessThanOrEqual(wf.ON_FAILURE_TYPED_TERMINAL_WAIT_MS);
    // negative control: the old 120 s wait would not hold the sum.
    expect(
      CELL_TIMEOUT_CAPTURE_BUDGET_MS + CELL_TEARDOWN_WORST_CASE_MS + 30_000,
    ).toBeGreaterThan(120_000);
  });
});
