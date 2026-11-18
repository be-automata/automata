import { beforeAll, describe, expect, it, vi } from "vitest";
import { CELL_RUN_TTL_MS } from "@terragon/types/cell";

import { buildAgentRunDefinition } from "./definition";

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
  let runTimeoutMs: number;
  beforeAll(async () => {
    const wf = await import("./workflow");
    runTimeoutMs = wf.RUN_EXECUTION_TIMEOUT_MS;
  });

  // card: protects=CELL_RUN_TTL_MS is the run's execution timeout plus the 15 min teardown margin, on both mirrors; fails_when=definition.ts executionTimeout (say 40m) or RUN_EXECUTION_TIMEOUT_MS moves without CELL_RUN_TTL_MS; no_claim=the server-side TTL cap (deploy-assets.test.ts)
  it("parse(executionTimeout) + 15 min === CELL_RUN_TTL_MS", () => {
    const def = buildAgentRunDefinition("agent-run", null);
    expect(parseDuration(def.task.executionTimeout)).toBe(30 * 60_000);
    expect(parseDuration(def.task.executionTimeout) + TEARDOWN_MARGIN_MS).toBe(
      CELL_RUN_TTL_MS,
    );
    expect(runTimeoutMs + TEARDOWN_MARGIN_MS).toBe(CELL_RUN_TTL_MS);
  });

  // card: protects=the parser reads the definition's own string, so a changed timeout would fail the pin; fails_when=parseDuration ignores its input; no_claim=anything about the engine
  it("negative control: a 40m timeout would not satisfy the pin", () => {
    expect(parseDuration("40m") + TEARDOWN_MARGIN_MS).not.toBe(CELL_RUN_TTL_MS);
  });
});
