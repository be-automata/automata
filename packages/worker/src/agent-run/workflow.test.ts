import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk";
import { AGENT_RUN_VARIANTS } from "./definition";

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
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
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
let resolveUseCredits: typeof import("./workflow").resolveUseCredits;

beforeAll(async () => {
  const mod = await import("./workflow");
  workflowDef = (mod.agentRunWorkflow as unknown as { definition: unknown })
    .definition;
  resolveUseCredits = mod.resolveUseCredits;
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
    expect(keys[1].expression).toBe("'agent-run-global-memory-budget'");
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
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("OK", { status: 200 }));
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
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("OK", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = { errors: () => ({}) };
    await expect(workflowDef.onFailure.fn(INPUT, ctx)).resolves.toBeUndefined();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.messages[0].error_info).toMatch(/agent-run failed/);
  });
});

describe("resolveUseCredits — the worker's final say", () => {
  it("box-key + no delivered credential OVERRIDES an incoming useCredits=true (the 402 pilot bug)", () => {
    // www sets useCredits=true precisely when the user has no connected
    // credential — the box-key operator's normal state. Leaving it true blanks
    // the box key in daemon-env and 402s at the credits proxy.
    const r = resolveUseCredits({
      boxTrust: "box-key",
      credentialDelivered: false,
      incomingUseCredits: true,
    });
    expect(r.useCredits).toBe(false);
    expect(r.log).toMatch(/box-key/);
  });

  it("box-key + no delivered credential keeps useCredits=false when it arrives false", () => {
    const r = resolveUseCredits({
      boxTrust: "box-key",
      credentialDelivered: false,
      incomingUseCredits: false,
    });
    expect(r.useCredits).toBe(false);
    expect(r.log).toBeNull();
  });

  it.each(["shared", "owner"] as const)(
    "%s + no delivered credential forces credits (proxy) when useCredits arrives false",
    (boxTrust) => {
      // The silent-third-mode fix: an undelivered run on a non-box-key box must
      // never fall through to whatever key the box happens to carry.
      const r = resolveUseCredits({
        boxTrust,
        credentialDelivered: false,
        incomingUseCredits: false,
      });
      expect(r.useCredits).toBe(true);
      expect(r.log).toMatch(/forcing credits/);
    },
  );

  it.each(["shared", "owner"] as const)(
    "%s + no delivered credential keeps useCredits=true when it arrives true",
    (boxTrust) => {
      const r = resolveUseCredits({
        boxTrust,
        credentialDelivered: false,
        incomingUseCredits: true,
      });
      expect(r.useCredits).toBe(true);
      expect(r.log).toBeNull();
    },
  );

  it.each(["shared", "owner", "box-key"] as const)(
    "a delivered credential wins in %s mode: useCredits is false regardless of the incoming value",
    (boxTrust) => {
      for (const incomingUseCredits of [true, false]) {
        const r = resolveUseCredits({
          boxTrust,
          credentialDelivered: true,
          incomingUseCredits,
        });
        expect(r.useCredits).toBe(false);
      }
    },
  );
});

describe("#125 C1: makeAgentRunWorkflow variants", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  beforeAll(async () => {
    mod = await import("./workflow");
  });

  const defOf = (name: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.agentRunWorkflows.find((w: any) => w.definition.name === name)
      ?.definition;

  it("registers the legacy workflow + 3 policy variants, table-driven", () => {
    expect(Object.keys(AGENT_RUN_VARIANTS)).toEqual([
      "agent-run",
      "agent-run-newest",
      "agent-run-strict",
      "agent-run-discard",
    ]);
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mod.agentRunWorkflows.map((w: any) => w.definition.name),
    ).toEqual(Object.keys(AGENT_RUN_VARIANTS));
  });

  it("legacy agent-run is byte-identical to pre-#125: 2 keys, no per-PR entry, no idempotency (AC7)", () => {
    const legacy = defOf("agent-run");
    expect(legacy.concurrency).toHaveLength(2);
    expect(legacy.concurrency[0].expression).toBe("input.orgId");
    expect(legacy.idempotency).toBeUndefined();
    expect(legacy._tasks[0].idempotency).toBeUndefined();
  });

  it("variants are identical to legacy EXCEPT the stacked per-PR entry's limitStrategy + the deliveryId idempotency (AC1)", () => {
    const legacy = defOf("agent-run");
    const expectedStrategy: Record<string, ConcurrencyLimitStrategy> = {
      "agent-run-newest": ConcurrencyLimitStrategy.CANCEL_IN_PROGRESS,
      "agent-run-strict": ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
      "agent-run-discard": ConcurrencyLimitStrategy.CANCEL_NEWEST,
    };
    for (const [name, strategy] of Object.entries(expectedStrategy)) {
      const v = defOf(name);
      expect(v, name).toBeDefined();
      // Per-PR entry is FIRST and references the field, never interpolates.
      expect(v.concurrency).toHaveLength(3);
      expect(v.concurrency[0]).toEqual({
        expression: "input.prKey",
        maxRuns: 1,
        limitStrategy: strategy,
      });
      // The two legacy entries follow, unchanged.
      expect(v.concurrency.slice(1)).toEqual(legacy.concurrency);
      // ONE shared task fn + identical task config.
      expect(v._tasks).toHaveLength(1);
      expect(v._tasks[0].fn).toBe(legacy._tasks[0].fn);
      expect(v._tasks[0]).toEqual(legacy._tasks[0]);
      // Idempotency is WORKFLOW-level (the only level the SDK registers).
      expect(v.idempotency).toEqual({
        strategy: "ttl",
        expression: "input.deliveryId",
        ttlMs: 24 * 60 * 60 * 1000,
      });
      // Same onFailure handler.
      expect(v.onFailure.fn).toBe(legacy.onFailure.fn);
    }
  });

  it("throws at registration on an unsupported per-PR strategy (AC2 fail-loud)", () => {
    expect(() =>
      mod.makeAgentRunWorkflow(
        "agent-run-bogus",
        999 as unknown as ConcurrencyLimitStrategy,
      ),
    ).toThrow(/unsupported per-PR concurrency strategy 999/);
  });
});
