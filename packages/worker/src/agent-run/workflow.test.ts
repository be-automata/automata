import { describe, it, expect, beforeAll } from "vitest";
import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk";

/**
 * Phase 0.1 registration-shape proof for the agent-run WORKFLOW (converted from a
 * standalone `hatchet.task` so #2 onFailure + #3 stacked concurrency can attach).
 *
 * We assert the workflow DEFINITION the SDK will register — name (the REST trigger
 * contract), the single-key concurrency (unchanged behaviour until Phase 2), and
 * the run task's EXPLICIT `retries: 0` (Phase 1.4 mechanism #1: a minutes-long,
 * non-idempotent agent run must never auto-retry). Scheduler behaviour itself is a
 * live concern; this locks the config an edit could silently regress.
 *
 * `hatchet.workflow()` runs `Hatchet.init()` at import, which needs a token to
 * decode. We inject a syntactically-valid unsigned JWT carrying the claims the
 * config-loader reads (sub + addresses) BEFORE importing the module — no network,
 * no real engine.
 */

function fakeHatchetToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const claims = Buffer.from(
    JSON.stringify({
      sub: "tenant-test",
      server_url: "http://localhost:8888",
      grpc_broadcast_address: "localhost:7070",
    }),
  ).toString("base64url");
  return `${header}.${claims}.sig`;
}

process.env.HATCHET_CLIENT_TOKEN = fakeHatchetToken();
process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let workflowDef: any;

beforeAll(async () => {
  const mod = await import("./workflow");
  workflowDef = (mod.agentRunWorkflow as unknown as { definition: unknown })
    .definition;
});

describe("agentRunWorkflow registration shape", () => {
  it('keeps the workflow name "agent-run" (REST trigger contract)', () => {
    expect(workflowDef.name).toBe("agent-run");
  });

  it("carries a single GROUP_ROUND_ROBIN concurrency key (maxRuns 1, unchanged)", () => {
    // Normalise: the SDK may store it as an object or a one-element array.
    const keys = Array.isArray(workflowDef.concurrency)
      ? workflowDef.concurrency
      : [workflowDef.concurrency];
    expect(keys).toHaveLength(1);
    expect(keys[0].expression).toBe("'agent-run-shared-daemon-socket'");
    expect(keys[0].maxRuns).toBe(1);
    expect(keys[0].limitStrategy).toBe(
      ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    );
  });

  it("registers exactly one run task with EXPLICIT retries:0 and the 30m timeouts", () => {
    const tasks = workflowDef._tasks as Array<{
      name: string;
      retries?: number;
      scheduleTimeout?: string;
      executionTimeout?: string;
    }>;
    expect(tasks).toHaveLength(1);
    const run = tasks[0]!;
    expect(run.name).toBe("run");
    // Explicit 0 — never undefined (a future edit that drops it must fail here).
    expect(run.retries).toBe(0);
    expect(run.scheduleTimeout).toBe("30m");
    expect(run.executionTimeout).toBe("30m");
  });
});
