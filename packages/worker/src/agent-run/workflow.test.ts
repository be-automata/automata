import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("agentRunWorkflow registration shape", () => {
  it('keeps the workflow name "agent-run" (REST trigger contract)', () => {
    expect(workflowDef.name).toBe("agent-run");
  });

  it("carries the stacked [per-org, global] GROUP_ROUND_ROBIN concurrency keys (Phase 2 #3a)", () => {
    // Normalise: the SDK may store it as an object or an array.
    const keys = Array.isArray(workflowDef.concurrency)
      ? workflowDef.concurrency
      : [workflowDef.concurrency];
    expect(keys).toHaveLength(2);

    // Key 1: per-ORG fair ordering on input.orgId.
    expect(keys[0].expression).toBe("input.orgId");
    expect(keys[0].maxRuns).toBe(1);
    expect(keys[0].limitStrategy).toBe(
      ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    );

    // Key 2: global single-daemon-socket / memory-budget cap.
    expect(keys[1].expression).toBe("'agent-run-shared-daemon-socket'");
    expect(keys[1].maxRuns).toBe(1);
    expect(keys[1].limitStrategy).toBe(
      ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    );

    // Invariant: per-org cap must never exceed the global cap (no org can hold
    // every slot).
    expect(keys[0].maxRuns).toBeLessThanOrEqual(keys[1].maxRuns);
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

  it("registers an onFailure handler (no name — SDK amendment 3)", () => {
    expect(typeof workflowDef.onFailure?.fn).toBe("function");
    expect(workflowDef.onFailure?.name).toBeUndefined();
  });
});

describe("agentRunWorkflow onFailure (#2)", () => {
  const INPUT = {
    threadId: "thr_fail_1",
    threadChatId: "tc_1",
    repoFullName: "o/r",
    branch: "main",
    daemonCallbackUrl: "https://www.example.com",
    installationToken: "inst-secret",
    daemonToken: "daemon-tok",
    orgId: "org-1",
  };

  it("posts exactly one custom-error with the Hatchet error summary — no prompt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("OK", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // ctx.errors() is Hatchet's per-task error map (error class/message, NOT agent
    // output). The handler forwards ONLY this as the reason.
    const ctx = { errors: () => ({ run: "daemon rejected the message" }) };
    await workflowDef.onFailure.fn(INPUT, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.example.com/api/daemon-event");
    const body = JSON.parse(init.body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].type).toBe("custom-error");
    expect(body.messages[0].error_info).toContain(
      "run: daemon rejected the message",
    );
    // No prompt / installation secret ever leaves in the failure callback (H2).
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("inst-secret");
    expect(serialized.toLowerCase()).not.toContain("prompt");
  });

  it("does not throw when ctx.errors() is empty (falls back to a generic reason)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("OK", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = { errors: () => ({}) };
    await expect(
      workflowDef.onFailure.fn(INPUT, ctx),
    ).resolves.toBeUndefined();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.messages[0].error_info).toMatch(/agent-run failed/);
  });
});
