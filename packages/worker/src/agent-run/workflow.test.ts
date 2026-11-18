import {
  describe,
  it,
  expect,
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk";
import {
  generatePlaneKeyPair,
  sealBindingOf,
  sealRunSecrets,
} from "@terragon/utils/payload-seal";
import { fixBranchName } from "@terragon/utils/fix-branch";
import { AGENT_RUN_VARIANTS } from "./definition";
import { resetPlaneKeyRingForTests } from "./payload-seal-keys";
import type { RunExecutor, RunExecutorInput } from "./run-executor";
import type { CellConfig } from "./cell-config";

// Defensive: this suite only checks registration shapes and never runs the
// task fn — but if a future case does, the admission reap and box lock must
// never touch the box's REAL namespace root from a unit test (#152 Stage A).
vi.mock("./reclaim", () => ({
  reclaimDeadWorkerRuns: vi.fn(),
  reapOwnThreadAttempts: vi.fn().mockReturnValue(0),
}));
vi.mock("./box-lock", () => ({
  acquireBoxLock: vi.fn(async () => ({
    release: vi.fn(),
    lost: false,
    slot: 0,
  })),
  // #205: the workflow takes a slot; at N = 1 that is the exclusive lock.
  acquireBoxSlot: vi.fn(async () => ({
    release: vi.fn(),
    lost: false,
    slot: 0,
  })),
}));

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
// ADR-013 P3: every box runs its agents in containers, so loadWorkerConfig
// (which onFailure calls for the seal key path) needs the image and ceiling.
process.env.WORKER_BATTERIES_IMAGE = `ghcr.io/be-automata/automata-batteries@sha256:${"ab".repeat(32)}`;
process.env.WORKER_RUN_MEMORY_MAX = "1500M";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let workflowDef: any;
let resolveUseCredits: typeof import("./workflow").resolveUseCredits;
let resolveCredentialSource: typeof import("./workflow").resolveCredentialSource;
let runSelfHealAuditStep: typeof import("./workflow").runSelfHealAuditStep;
let selfHealRefFence: typeof import("./workflow").selfHealRefFence;
let wf: typeof import("./workflow");

beforeAll(async () => {
  const mod = await import("./workflow");
  wf = mod;
  workflowDef = (mod.agentRunWorkflow as unknown as { definition: unknown })
    .definition;
  resolveUseCredits = mod.resolveUseCredits;
  resolveCredentialSource = mod.resolveCredentialSource;
  runSelfHealAuditStep = mod.runSelfHealAuditStep;
  selfHealRefFence = mod.selfHealRefFence;
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

    // Invariant (#372): the per-org cap never EXCEEDS the global cap; equal is
    // allowed (a single-org box must be able to use every slot — fairness
    // across orgs is GROUP_ROUND_ROBIN's ordering, not a reservation).
    expect(keys[0].maxRuns).toBeLessThanOrEqual(keys[1].maxRuns);
  });

  it("#372: the default-caps registry is the shipped 1/1 shape with ONE named delta — an explicit slotCost: 1 on the run task", () => {
    const tasks = workflowDef._tasks as Array<{
      name: string;
      slotCost?: number;
    }>;
    expect(tasks[0]!.slotCost).toBe(1);
  });

  it("#372: buildAgentRunWorkflows({3, 2}) registers per-org 2 and global 3 on EVERY variant, slotCost stays 1; a per-org cap above the global one is refused by the pure guard", () => {
    const list = wf.buildAgentRunWorkflows({
      globalMaxRuns: 3,
      perOrgMaxRuns: 2,
    });
    expect(list.map((w) => w.definition.name)).toEqual([
      "agent-run",
      "agent-run-newest",
      "agent-run-strict",
      "agent-run-discard",
    ]);
    for (const w of list) {
      const def = w.definition as unknown as {
        concurrency: Array<{ expression: string; maxRuns: number }>;
        _tasks: Array<{ slotCost?: number; retries?: number }>;
      };
      const org = def.concurrency.find((k) => k.expression === "input.orgId")!;
      const global = def.concurrency.find(
        (k) => k.expression === "'agent-run-global-memory-budget'",
      )!;
      expect(org.maxRuns).toBe(2);
      expect(global.maxRuns).toBe(3);
      expect(def._tasks[0]!.slotCost).toBe(1);
      expect(def._tasks[0]!.retries).toBe(0);
    }
    expect(() =>
      wf.buildAgentRunWorkflows({ globalMaxRuns: 2, perOrgMaxRuns: 3 }),
    ).toThrow(/perOrgMaxRuns ≤ globalMaxRuns/);
    expect(() =>
      wf.buildAgentRunWorkflows({ globalMaxRuns: 0, perOrgMaxRuns: 0 }),
    ).toThrow(/integers ≥ 1/);
  });

  it("registers exactly one run task with EXPLICIT retries: 0, no backoff, and the 30m timeouts — and #371 keeps it so", () => {
    const tasks = workflowDef._tasks as Array<{
      name: string;
      retries?: number;
      backoff?: unknown;
      scheduleTimeout?: string;
      executionTimeout?: string;
    }>;
    expect(tasks).toHaveLength(1);
    const run = tasks[0]!;
    expect(run.name).toBe("run");
    // Explicit, never undefined: an agent run is NON-idempotent and the engine
    // retries its own failures (an executionTimeout) under this policy — and a
    // retried attempt re-enters CANCEL_IN_PROGRESS as the newest item. The
    // memory-headroom deferral (#371) waits IN PROCESS instead, so nothing
    // ever needs an engine retry.
    expect(run.retries).toBe(0);
    expect("backoff" in run).toBe(false);
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

  // #380 strict mode: onFailure accepts sealed inputs only. A describe-level
  // ring seals INPUT's plain fields into the envelope (the shape www sends).
  let ringPlane: Awaited<
    ReturnType<
      typeof import("@terragon/utils/payload-seal").generatePlaneKeyPair
    >
  >;
  let ringFile = "";
  const sealedInput = async () => {
    const { sealBindingOf, sealRunSecrets } = await import(
      "@terragon/utils/payload-seal"
    );
    const { installationToken, daemonToken, ...rest } = INPUT;
    return {
      ...rest,
      sealedSecrets: await sealRunSecrets(
        ringPlane.publicKey,
        { installationToken, daemonToken },
        sealBindingOf(rest),
      ),
    };
  };
  beforeAll(async () => {
    const { generatePlaneKeyPair } = await import(
      "@terragon/utils/payload-seal"
    );
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    ringPlane = await generatePlaneKeyPair("plane-onfailure");
    ringFile = path.join(
      mkdtempSync(path.join(tmpdir(), "seal-onfailure-")),
      "payload-seal.json",
    );
    writeFileSync(ringFile, JSON.stringify({ keys: [ringPlane.privateKey] }), {
      mode: 0o600,
    });
  });
  beforeEach(async () => {
    const { resetPlaneKeyRingForTests } = await import("./payload-seal-keys");
    process.env.WORKER_PAYLOAD_SEAL_KEY_FILE = ringFile;
    resetPlaneKeyRingForTests();
  });
  afterEach(async () => {
    const { resetPlaneKeyRingForTests } = await import("./payload-seal-keys");
    delete process.env.WORKER_PAYLOAD_SEAL_KEY_FILE;
    resetPlaneKeyRingForTests();
  });

  it("posts exactly one custom-error with the Hatchet error summary — no prompt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("OK", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // ctx.errors() is Hatchet's per-task error map (error class/message, NOT agent
    // output). The handler forwards ONLY this as the reason.
    const ctx = { errors: () => ({ run: "daemon rejected the message" }) };
    await workflowDef.onFailure.fn(await sealedInput(), ctx);

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
    await expect(
      workflowDef.onFailure.fn(await sealedInput(), ctx),
    ).resolves.toBeUndefined();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.messages[0].error_info).toMatch(/agent-run failed/);
  });

  /**
   * Card: protects=strict onFailure (rollout step 4) — a plain-text input
   * posts NOTHING (no token is trusted from plain fields) and the log names
   * field names only; fails_when=onFailure posts with a plain-text daemon
   * token or logs a value; no_claim=the sweep reconcile.
   */
  it("#380 strict: a plain-text input posts nothing and logs field names only", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("OK", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await workflowDef.onFailure.fn(INPUT, { errors: () => ({ run: "boom" }) });
    expect(fetchMock).not.toHaveBeenCalled();
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain(
      "payload-seal: strict mode refuses plain-text secret fields (installationToken, daemonToken)",
    );
    expect(logged).not.toContain("inst-secret");
    expect(logged).not.toContain("daemon-tok");
    errorSpy.mockRestore();
  });

  // #380: the daemon token now arrives sealed. onFailure unseals with the
  // box's ring (WORKER_PAYLOAD_SEAL_KEY_FILE) and posts with it; when the
  // envelope cannot be opened it posts NOTHING and says why by class —
  // www's sweep rule (iii) is the reconcile. Card: protects=the failure
  // post still authenticates with the unsealed token / fail-closed on a
  // foreign envelope; fails_when=onFailure reads a plain-text field, posts
  // with a wrong token, or logs a secret byte; no_claim=the sweep itself.
  it("#380: unseals the daemon token from the envelope before posting", async () => {
    const { generatePlaneKeyPair, sealBindingOf, sealRunSecrets } =
      await import("@terragon/utils/payload-seal");
    const { resetPlaneKeyRingForTests } = await import("./payload-seal-keys");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const plane = await generatePlaneKeyPair("plane-fail");
    const keyFile = path.join(
      mkdtempSync(path.join(tmpdir(), "seal-fail-")),
      "payload-seal.json",
    );
    writeFileSync(keyFile, JSON.stringify({ keys: [plane.privateKey] }), {
      mode: 0o600,
    });
    process.env.WORKER_PAYLOAD_SEAL_KEY_FILE = keyFile;
    resetPlaneKeyRingForTests();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("OK", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const { installationToken, daemonToken, ...rest } = INPUT;
      void installationToken;
      const sealed = {
        ...rest,
        sealedSecrets: await sealRunSecrets(
          plane.publicKey,
          {
            installationToken: "ghs_sealed_inst",
            daemonToken: "sealed-daemon",
          },
          sealBindingOf(INPUT),
        ),
      };
      await workflowDef.onFailure.fn(sealed, {
        errors: () => ({ run: "boom" }),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0]!;
      expect(init.headers["x-daemon-token"]).toBe("sealed-daemon");
      expect(init.headers["x-daemon-token"]).not.toBe(daemonToken);

      // A foreign envelope: nothing posted, the log names kid + reason only.
      fetchMock.mockClear();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const other = await generatePlaneKeyPair("plane-fail");
      await workflowDef.onFailure.fn(
        {
          ...rest,
          sealedSecrets: await sealRunSecrets(
            other.publicKey,
            { installationToken: "ghs_x", daemonToken: "y" },
            sealBindingOf(INPUT),
          ),
        },
        { errors: () => ({ run: "boom" }) },
      );
      expect(fetchMock).not.toHaveBeenCalled();
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain(
        "run secrets unavailable (payload-seal: unseal failed (kid=plane-fail, reason=tag))",
      );
      expect(logged).not.toContain(plane.privateKey.privateKeyJwk.d);
      errorSpy.mockRestore();
    } finally {
      resetPlaneKeyRingForTests();
    }
  });

  it("#437: onFailure waits for a task run still live in this process; a run that never started here, and a live review run, post at once", async () => {
    // protects=the typed timeout winning the first-terminal race on an
    // executionTimeout (onFailure is scheduled while the teardown still
    // runs); fails_when=onFailure posts before the live run ends, or a run
    // that never ran here / a review run is delayed; no_claim=the engine's
    // scheduling itself (simulated with a held run fn), and the 120 s bound.
    const { _trackLiveRunForTests, ON_FAILURE_EXECUTION_TIMEOUT } =
      await import("./workflow");
    expect(ON_FAILURE_EXECUTION_TIMEOUT).toBe("3m");
    const order: string[] = [];
    const fetchMock = vi.fn(async () => {
      order.push("post");
      return new Response("OK", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const runId = "2d4f8a74-6b0f-4d0f-9f3e-9c7f5e4b3a2d";
      let finishTeardown!: () => void;
      const live = _trackLiveRunForTests(
        runId,
        () =>
          new Promise<void>((resolve) => {
            finishTeardown = () => {
              order.push("teardown-finished");
              resolve();
            };
          }),
      );
      const failure = workflowDef.onFailure.fn(await sealedInput(), {
        errors: () => ({ run: "Task exceeded timeout of 30m" }),
        workflowRunId: () => runId,
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(order).toEqual([]);
      finishTeardown();
      await Promise.all([live, failure]);
      expect(order).toEqual(["teardown-finished", "post"]);

      // Never live here (e.g. a scheduleTimeout): no wait at all.
      order.length = 0;
      const started = Date.now();
      await workflowDef.onFailure.fn(await sealedInput(), {
        errors: () => ({ run: "boom" }),
        workflowRunId: () => "3e5a9b85-7c1a-4e1a-8a4f-ad8f6f5c4b3e",
      });
      expect(order).toEqual(["post"]);
      expect(Date.now() - started).toBeLessThan(1_000);

      // A review run still live in this process: it owns no abnormal
      // terminal, so its onFailure posts at once, before the run ends.
      order.length = 0;
      const reviewRunId = "4f6b0c96-8d2b-4f2b-9b5f-be9f7f6d5c4f";
      let releaseReview!: () => void;
      const reviewLive = _trackLiveRunForTests(
        reviewRunId,
        () =>
          new Promise<void>((resolve) => {
            releaseReview = () => {
              order.push("review-ended");
              resolve();
            };
          }),
      );
      const { installationToken, daemonToken, ...rest } = INPUT;
      const reviewWire = { ...rest, prKey: "org-1/o/r/7" };
      const { sealBindingOf, sealRunSecrets } = await import(
        "@terragon/utils/payload-seal"
      );
      await workflowDef.onFailure.fn(
        {
          ...reviewWire,
          sealedSecrets: await sealRunSecrets(
            ringPlane.publicKey,
            { installationToken, daemonToken },
            sealBindingOf(reviewWire),
          ),
        },
        { errors: () => ({ run: "boom" }), workflowRunId: () => reviewRunId },
      );
      releaseReview();
      await reviewLive;
      expect(order).toEqual(["post", "review-ended"]);
    } finally {
      vi.unstubAllGlobals();
    }
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

describe("resolveCredentialSource — the attribution (#209 item 1)", () => {
  it("owner + delivered → user-credential", () => {
    expect(
      resolveCredentialSource({
        boxTrust: "owner",
        credentialDelivered: true,
      }),
    ).toBe("user-credential");
  });

  it("shared + not delivered → built-in-credits (the #209 defect's exact configuration)", () => {
    // The connected credential read ENABLED on the admin page and was never
    // consulted: a shared box forces the credits path. This is the line that
    // makes that legible without a production database query.
    expect(
      resolveCredentialSource({
        boxTrust: "shared",
        credentialDelivered: false,
      }),
    ).toBe("built-in-credits");
  });

  it("box-key + not delivered → box-key", () => {
    expect(
      resolveCredentialSource({
        boxTrust: "box-key",
        credentialDelivered: false,
      }),
    ).toBe("box-key");
  });

  it("the three paths carry three PAIRWISE DISTINCT attributions", () => {
    const sources = [
      resolveCredentialSource({ boxTrust: "owner", credentialDelivered: true }),
      resolveCredentialSource({
        boxTrust: "shared",
        credentialDelivered: false,
      }),
      resolveCredentialSource({
        boxTrust: "box-key",
        credentialDelivered: false,
      }),
    ];
    expect(new Set(sources).size).toBe(3);
  });

  it("agrees with resolveUseCredits across the WHOLE input space", () => {
    // The attribution and the credential actually used are decided from the
    // same two inputs; if they ever disagree the thread line is a lie.
    for (const boxTrust of ["owner", "shared", "box-key"] as const) {
      for (const credentialDelivered of [true, false]) {
        for (const incomingUseCredits of [true, false]) {
          const source = resolveCredentialSource({
            boxTrust,
            credentialDelivered,
          });
          const { useCredits } = resolveUseCredits({
            boxTrust,
            credentialDelivered,
            incomingUseCredits,
          });
          if (credentialDelivered) {
            expect(source).toBe("user-credential");
            expect(useCredits).toBe(false);
          } else if (useCredits) {
            expect(source).toBe("built-in-credits");
          } else {
            expect(source).toBe("box-key");
          }
        }
      }
    }
  });
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

describe("runSelfHealAuditStep (FORGE-01 / OBS-01 / SKEW-01)", () => {
  const TOKEN = "TOKEN_SENTINEL";
  const checks = [
    { fingerprint: "aaaaaaaaaaaaaaaa", check: "file-exists", subject: "a" },
    { fingerprint: "bbbbbbbbbbbbbbbb", check: "file-exists", subject: "b" },
    { fingerprint: "cccccccccccccccc", check: "file-exists", subject: "c" },
  ];
  const base = {
    threadId: "thr_sh_1",
    daemonCallbackUrl: "https://www.example.com",
  };

  function harness(
    runChecks: import("./workflow").SelfHealAuditStepDeps["runChecks"],
  ) {
    const order: string[] = [];
    const lines: string[] = [];
    const runSpy = vi.fn(runChecks);
    const postSpy = vi.fn(async (_a: { results: unknown[] }) => {
      order.push("post");
      return "recorded" as const;
    });
    const deps = {
      runChecks: ((a) => {
        order.push("run");
        return runSpy(a);
      }) as typeof runChecks,
      postReport:
        postSpy as unknown as import("./workflow").SelfHealAuditStepDeps["postReport"],
    };
    return { order, lines, runSpy, postSpy, deps };
  }

  it("runs the checks then posts the real outcomes once, in one step line", async () => {
    const h = harness(async () => [
      { fingerprint: "aaaaaaaaaaaaaaaa", outcome: "pass" },
      { fingerprint: "bbbbbbbbbbbbbbbb", outcome: "fail" },
      { fingerprint: "cccccccccccccccc", outcome: "error" },
    ]);
    await runSelfHealAuditStep({
      input: {
        ...base,
        selfHeal: { kind: "audit", checks, checkToken: TOKEN },
      },
      workdir: "/w",
      egressProxyUrl: "http://127.0.0.1:1",
      step: (m) => h.lines.push(m),
      deps: h.deps,
    });
    expect(h.order).toEqual(["run", "post"]);
    const env = h.runSpy.mock.calls[0]?.[0].env ?? {};
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:1");
    expect(h.lines).toEqual([
      "self-heal checks: requested=3 pass=1 fail=1 error=1 report=recorded",
    ]);
    expect(h.lines.join("\n")).not.toContain(TOKEN);
  });

  it("a throwing runner still posts a sealing report of errors", async () => {
    const h = harness(async () => {
      throw new Error("boom");
    });
    await runSelfHealAuditStep({
      input: {
        ...base,
        selfHeal: { kind: "audit", checks, checkToken: TOKEN },
      },
      workdir: "/w",
      egressProxyUrl: null,
      step: (m) => h.lines.push(m),
      deps: h.deps,
    });
    expect(h.postSpy).toHaveBeenCalledTimes(1);
    const results = h.postSpy.mock.calls[0]?.[0].results as {
      outcome: string;
    }[];
    expect(results.map((r) => r.outcome)).toEqual(["error", "error", "error"]);
  });

  it("empty checks: runner not called, a zero-result report is still posted", async () => {
    const h = harness(async () => []);
    await runSelfHealAuditStep({
      input: {
        ...base,
        selfHeal: { kind: "audit", checks: [], checkToken: TOKEN },
      },
      workdir: "/w",
      egressProxyUrl: null,
      step: (m) => h.lines.push(m),
      deps: h.deps,
    });
    expect(h.runSpy).not.toHaveBeenCalled();
    expect(h.postSpy).toHaveBeenCalledTimes(1);
    expect(h.postSpy.mock.calls[0]?.[0].results).toEqual([]);
  });

  it("no selfHeal (old www): neither function called, no step line", async () => {
    const h = harness(async () => []);
    await runSelfHealAuditStep({
      input: base,
      workdir: "/w",
      egressProxyUrl: null,
      step: (m) => h.lines.push(m),
      deps: h.deps,
    });
    expect(h.runSpy).not.toHaveBeenCalled();
    expect(h.postSpy).not.toHaveBeenCalled();
    expect(h.lines).toEqual([]);
  });

  it("a report error does not throw (the run proceeds)", async () => {
    const h = harness(async () => []);
    h.postSpy.mockResolvedValueOnce("error" as never);
    const lines: string[] = [];
    await expect(
      runSelfHealAuditStep({
        input: {
          ...base,
          selfHeal: { kind: "audit", checks: [], checkToken: TOKEN },
        },
        workdir: "/w",
        egressProxyUrl: null,
        step: (m) => lines.push(m),
        deps: h.deps,
      }),
    ).resolves.toBeUndefined();
    expect(lines[0]).toContain("report=error");
  });
});

describe("selfHealRefFence (FENCE-01 wiring)", () => {
  const fix = (branch: string) => ({
    kind: "fix" as const,
    attemptId: "att_1",
    branch,
    baseBranch: "main",
    checks: [],
    denyExceptions: [],
    gateToken: "GATE_SENTINEL",
  });

  it("a fix run is fenced to exactly refs/heads/<its branch>", () => {
    expect(selfHealRefFence(fix("automata/fix-12-deadbeef-a1"))).toEqual({
      exactRef: "refs/heads/automata/fix-12-deadbeef-a1",
    });
  });

  it("no selfHeal or an audit run → no fence", () => {
    expect(selfHealRefFence(undefined)).toBeUndefined();
    expect(
      selfHealRefFence({ kind: "audit", checks: [], checkToken: "t" }),
    ).toBeUndefined();
  });

  it("a fix run whose branch is not an automata/fix-* branch fails closed", () => {
    for (const branch of [
      "main",
      "refs/heads/automata/fix-1",
      "automata/fix-",
      "automata/fix-1/../main",
      "automata/fix-1 x",
      "automata/fix-1.lock",
      "Automata/fix-1",
      "automata/fix-a@{1}",
      "automata/fix-HEAD.",
      "automata/fix-a/b",
      "automata/fix-a\ufffd",
    ]) {
      expect(() => selfHealRefFence(fix(branch)), branch).toThrow(
        /self-heal fix run/,
      );
    }
  });

  describe("real fixBranchName output (the fence accepts every generated name)", () => {
    it("every name fixBranchName builds maps to exactly its ref", () => {
      const issues = [1, 9, 10, 12, 99999, 2147483647, Number.MAX_SAFE_INTEGER];
      const fps = [
        "00000000",
        "ffffffff",
        "deadbeef",
        "0123abcd",
        "0123456789abcdef".repeat(4),
      ];
      const attempts = [
        1,
        2,
        9,
        10,
        99999,
        2147483647,
        Number.MAX_SAFE_INTEGER,
      ];
      for (const issueNumber of issues) {
        for (const fingerprint of fps) {
          for (const attemptNo of attempts) {
            const name = fixBranchName({ issueNumber, fingerprint, attemptNo });
            expect(selfHealRefFence(fix(name)), name).toEqual({
              exactRef: `refs/heads/${name}`,
            });
          }
        }
      }
    });

    it("a seeded sample of safe-integer issue and attempt numbers maps to exactly its ref", () => {
      // Deterministic BigInt LCG (Knuth MMIX), reduced into [1, MAX_SAFE_INTEGER].
      let state = 623n;
      const MASK = (1n << 64n) - 1n;
      const max = BigInt(Number.MAX_SAFE_INTEGER);
      const next = (): number => {
        state = (state * 6364136223846793005n + 1442695040888963407n) & MASK;
        return Number((state >> 11n) % max) + 1;
      };
      for (let i = 0; i < 500; i++) {
        const issueNumber = next();
        const attemptNo = next();
        const name = fixBranchName({
          issueNumber,
          fingerprint: "deadbeef",
          attemptNo,
        });
        expect(selfHealRefFence(fix(name)), name).toEqual({
          exactRef: `refs/heads/${name}`,
        });
      }
    });
  });
});

describe("runSelfHealFixStep (GATE-01 / TMO-01 / OBS-01)", () => {
  const PUSHED = "a".repeat(40);
  const BASE = "b".repeat(40);
  const FIX_SELF_HEAL = {
    kind: "fix" as const,
    attemptId: "11111111-1111-4111-8111-111111111111",
    branch: "automata/fix-12-deadbeef-a1",
    baseBranch: "main",
    checks: [
      {
        fingerprint: "0123456789abcdef",
        check: "file-exists",
        subject: "SECURITY.md",
      },
    ],
    denyExceptions: [],
    gateToken: "GATE_TOKEN_SENTINEL",
  };
  const INPUT = {
    selfHeal: FIX_SELF_HEAL,
    daemonCallbackUrl: "https://www.example.com",
    repoFullName: "o/r",
  };
  /** #380: the token now arrives from the unsealed RunSecrets, beside the input. */
  const INSTALLATION_TOKEN = "INSTALL_SENTINEL";
  const COMPLETED = {
    workerStatus: "completed" as const,
    headSha: PUSHED,
    checkOutcome: "pass" as const,
    deniedPaths: [],
  };

  function setup(
    over: {
      lastPushed?: string | null;
      remote?: () => Promise<string | null>;
      lockLost?: boolean;
    } = {},
  ) {
    const order: string[] = [];
    const lines: string[] = [];
    const deps = {
      remoteHead: vi.fn(async (_args: unknown) => {
        order.push("remoteHead");
        return over.remote ? over.remote() : PUSHED;
      }),
      runCheck: vi.fn(async (_args: unknown) => {
        order.push("runFixCheck");
        return COMPLETED;
      }),
      postReport: vi.fn(async (_args: unknown) => {
        order.push("postSelfHealFixCheck");
        return "recorded" as const;
      }),
    };
    const lastPushed = "lastPushed" in over ? over.lastPushed! : PUSHED;
    const run = () =>
      wf.runSelfHealFixStep({
        input: INPUT,
        installationToken: INSTALLATION_TOKEN,
        workdir: "/w",
        egressProxyUrl: null,
        baseSha: BASE,
        lockLost: over.lockLost ?? false,
        teardown: () => order.push("teardown"),
        reap: async () => order.push("reap"),
        gitBroker: {
          lastPushedSha: () => {
            order.push("lastPushedSha");
            return lastPushed;
          },
          close: async () => {
            order.push("git-close");
          },
        },
        ghBroker: {
          close: async () => {
            order.push("gh-close");
          },
        },
        runStartedAt: 1_000_000,
        step: (m) => lines.push(m),
        now: () => 1_000_000 + 5_000,
        deps,
      });
    return { order, lines, deps, run };
  }

  it("kills, reaps, reads the pushed sha, closes both brokers, then checks and reports", async () => {
    const { order, lines, deps, run } = setup();
    await run();
    expect(order).toEqual([
      "teardown",
      "reap",
      "lastPushedSha",
      "git-close",
      "gh-close",
      "remoteHead",
      "runFixCheck",
      "postSelfHealFixCheck",
    ]);
    const checkArgs = deps.runCheck.mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    expect(checkArgs.pushedSha).toBe(PUSHED);
    expect(checkArgs.baseSha).toBe(BASE);
    expect(checkArgs.fix).toBe(FIX_SELF_HEAL);
    // min(now + 3 min, start + 30 min − 60 s)
    expect(checkArgs.deadlineAt).toBe(1_000_000 + 5_000 + 180_000);
    expect(deps.postReport).toHaveBeenCalledWith({
      baseUrl: "https://www.example.com",
      gateToken: "GATE_TOKEN_SENTINEL",
      attemptId: FIX_SELF_HEAL.attemptId,
      report: COMPLETED,
    });
    expect(lines).toEqual([
      "self-heal fix-check: status=completed check=pass denied=0 head=aaaaaaaa ms=0 report=recorded",
    ]);
    expect(lines.join("\n")).not.toContain("GATE_TOKEN_SENTINEL");
    expect(lines.join("\n")).not.toContain("INSTALL_SENTINEL");
  });

  it("nothing pushed → the check runs with pushedSha null (no_branch); GitHub is not asked", async () => {
    const { deps, run } = setup({ lastPushed: null });
    await run();
    expect(deps.remoteHead).not.toHaveBeenCalled();
    expect(
      (deps.runCheck.mock.calls[0]![0] as unknown as { pushedSha: unknown })
        .pushedSha,
    ).toBeNull();
  });

  it("a push GitHub does not hold (per-ref rejection) → pushedSha null", async () => {
    const { deps, run } = setup({ remote: async () => null });
    await run();
    expect(
      (deps.runCheck.mock.calls[0]![0] as unknown as { pushedSha: unknown })
        .pushedSha,
    ).toBeNull();
  });

  it("a GitHub head that differs from the push → error, nothing checked", async () => {
    const { deps, lines, run } = setup({ remote: async () => "c".repeat(40) });
    await run();
    expect(deps.runCheck).not.toHaveBeenCalled();
    expect(
      (deps.postReport.mock.calls[0]![0] as unknown as { report: unknown })
        .report,
    ).toEqual({
      workerStatus: "error",
      headSha: PUSHED,
      checkOutcome: null,
      deniedPaths: [],
    });
    expect(lines.at(-1)).toContain("status=error");
  });

  it("a failed head lookup → error, nothing checked", async () => {
    const { deps, run } = setup({
      remote: async () => {
        throw new Error("git ls-remote failed (exit 128)");
      },
    });
    await run();
    expect(deps.runCheck).not.toHaveBeenCalled();
    expect(deps.postReport).toHaveBeenCalledTimes(1);
  });

  it("a lost box lock skips the reap and the check, and still reports error", async () => {
    const { order, deps, run } = setup({ lockLost: true });
    await run();
    expect(order).not.toContain("reap");
    expect(deps.runCheck).not.toHaveBeenCalled();
    expect(
      (
        deps.postReport.mock.calls[0]![0] as unknown as {
          report: { workerStatus: string };
        }
      ).report.workerStatus,
    ).toBe("error");
  });

  it("never throws: a check that throws becomes an error report and one line", async () => {
    const { deps, lines, run } = setup();
    deps.runCheck.mockRejectedValueOnce(new Error("boom"));
    await expect(run()).resolves.toBeUndefined();
    expect(deps.postReport).toHaveBeenCalledTimes(1);
    expect(lines.at(-1)).toContain("status=error");
  });

  it("does nothing for a run without a fix", async () => {
    const { order, deps } = setup();
    await wf.runSelfHealFixStep({
      input: { ...INPUT, selfHeal: undefined },
      installationToken: INSTALLATION_TOKEN,
      workdir: "/w",
      egressProxyUrl: null,
      baseSha: BASE,
      lockLost: false,
      teardown: () => order.push("teardown"),
      reap: async () => order.push("reap"),
      gitBroker: null,
      ghBroker: null,
      runStartedAt: 0,
      step: () => {},
      deps,
    });
    expect(order).toEqual([]);
    expect(deps.postReport).not.toHaveBeenCalled();
  });

  it("reportSelfHealFixAborted posts workerStatus aborted once", async () => {
    const { deps, lines } = setup();
    await wf.reportSelfHealFixAborted({
      input: INPUT,
      step: (m) => lines.push(m),
      deps,
    });
    expect(deps.postReport).toHaveBeenCalledTimes(1);
    expect(
      (deps.postReport.mock.calls[0]![0] as unknown as { report: unknown })
        .report,
    ).toEqual({
      workerStatus: "aborted",
      headSha: null,
      checkOutcome: null,
      deniedPaths: [],
    });
    expect(lines[0]).toMatch(
      /^self-heal fix-check: status=aborted check=none denied=0 head=none ms=\d+ report=recorded$/,
    );
  });

  it("the deadline is capped by the 30-minute run timeout minus 60 s", () => {
    const start = 0;
    const late = 29 * 60_000;
    expect(wf.fixCheckDeadline(late, start)).toBe(29 * 60_000);
    expect(wf.fixCheckDeadline(1_000, start)).toBe(181_000);
  });

  it("RUN_EXECUTION_TIMEOUT_MS mirrors the task's executionTimeout", () => {
    expect(workflowDef._tasks[0].executionTimeout).toBe("30m");
    expect(wf.RUN_EXECUTION_TIMEOUT_MS).toBe(30 * 60_000);
  });
});

describe("#371 sleepAbortable — the real deferral sleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after ms and removes its abort listener on resolve", async () => {
    vi.useFakeTimers();
    const { sleepAbortable } = await import("./workflow");
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    let settled = false;
    const p = sleepAbortable(2_000, ac.signal).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    // A late abort finds no listener and changes nothing.
    ac.abort();
  });

  it("rejects with an AbortError at once when the signal is ALREADY aborted (no timer armed)", async () => {
    vi.useFakeTimers();
    const { sleepAbortable } = await import("./workflow");
    const ac = new AbortController();
    ac.abort();
    await expect(sleepAbortable(60_000, ac.signal)).rejects.toMatchObject({
      name: "AbortError",
      message: expect.stringMatching(/aborted/),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with an AbortError when aborted mid-wait and clears the timer", async () => {
    vi.useFakeTimers();
    const { sleepAbortable } = await import("./workflow");
    const ac = new AbortController();
    const p = sleepAbortable(60_000, ac.signal);
    const settled = p.then(
      () => "resolved",
      (e: Error) => e.name,
    );
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    expect(await settled).toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("without a signal it is a plain sleep", async () => {
    vi.useFakeTimers();
    const { sleepAbortable } = await import("./workflow");
    const p = sleepAbortable(50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toBeUndefined();
  });
});

describe("#656 PR-E: the run executor seam (the run fn with a fake injected executor)", () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "wf-seam-"));
  const RING = path.join(ROOT, "payload-seal.json");
  const SAVED: Record<string, string | undefined> = {};
  const ENV_NAMES = [
    "WORKER_RUN_NAMESPACE_ROOT",
    "WORKER_PAYLOAD_SEAL_KEY_FILE",
    "WORKER_BOX_SLOTS",
  ] as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rawRunFn: any;
  let plane: Awaited<ReturnType<typeof generatePlaneKeyPair>>;
  let seq = 0;
  const posts: { url: string; body: Record<string, unknown> }[] = [];

  const ON: CellConfig = {
    kind: "on",
    baseUrl: "http://127.0.0.1:8090",
    apiKey: "k".repeat(32),
    image: {
      repository: "ghcr.io/be-automata/automata-cell",
      digest: `sha256:${"cd".repeat(32)}`,
      reference: `ghcr.io/be-automata/automata-cell@sha256:${"cd".repeat(32)}`,
    },
  };

  beforeAll(async () => {
    for (const n of ENV_NAMES) SAVED[n] = process.env[n];
    process.env.WORKER_RUN_NAMESPACE_ROOT = path.join(ROOT, "ns");
    process.env.WORKER_PAYLOAD_SEAL_KEY_FILE = RING;
    plane = await generatePlaneKeyPair("plane-seam");
    fs.writeFileSync(RING, JSON.stringify({ keys: [plane.privateKey] }), {
      mode: 0o600,
    });
    resetPlaneKeyRingForTests();
    rawRunFn = workflowDef._tasks[0].fn;
  });

  afterAll(() => {
    for (const n of ENV_NAMES) {
      if (SAVED[n] === undefined) delete process.env[n];
      else process.env[n] = SAVED[n];
    }
    resetPlaneKeyRingForTests();
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    posts.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        posts.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ applied: true }), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    wf._setRunExecutorsForTests(undefined);
  });

  /** A sealed wire input, the way www sends it. */
  async function wireInput(extra: Record<string, unknown> = {}) {
    // A self-heal audit plan carries its check token in the envelope, not the plan.
    const { selfHeal, ...rest } = extra as {
      selfHeal?: { kind: string; checkToken?: string };
    };
    const { checkToken, ...plan } = selfHeal ?? { kind: "audit" };
    const wire = {
      threadId: `thr_seam_${++seq}`,
      threadChatId: "tc_1",
      repoFullName: "o/r",
      branch: "main",
      daemonCallbackUrl: "https://www.example.com",
      orgId: "org-1",
      ...rest,
      ...(selfHeal ? { selfHeal: plan } : {}),
    };
    return {
      ...wire,
      sealedSecrets: await sealRunSecrets(
        plane.publicKey,
        {
          installationToken: "inst-secret",
          daemonToken: "daemon-tok",
          ...(checkToken !== undefined ? { selfHealToken: checkToken } : {}),
        },
        sealBindingOf(wire),
      ),
    };
  }
  const ctx = () => ({
    cancelled: false,
    log: vi.fn(),
    abortController: new AbortController(),
    workflowRunId: () => `run-seam-${seq}`,
  });
  const urls = () => posts.map((p) => new URL(p.url).pathname);
  const cellCalls = () =>
    urls().filter((u) => /cell-plan|cell-teardown/.test(u));
  const terminals = () => urls().filter((u) => u.endsWith("/run-terminal"));

  function fakeExecutor(
    kind: "box" | "cell",
    run: (a: RunExecutorInput) =>
      | Promise<never>
      | Promise<{
          threadId: string;
          threadChatId: string;
          outcome: "completed" | "fenced";
        }>,
  ) {
    const fn = vi.fn(run);
    const executor: RunExecutor = {
      kind,
      run: fn as unknown as RunExecutor["run"],
    };
    return { executor, fn };
  }
  const completed = (a: RunExecutorInput) =>
    Promise.resolve({
      threadId: a.input.threadId,
      threadChatId: a.input.threadChatId,
      outcome: "completed" as const,
    });

  // card: protects=no marker means the box executor, no config read and no cell request; fails_when=an unmarked run touches the key file, the cell executor or a cell route; no_claim=the real box path (the existing suites, HATCHET_IT)
  it("T-FLAG-OFF / T-CONFIG-LAZY: no marker selects the box, never loads the cell config", async () => {
    const box = fakeExecutor("box", completed);
    const cell = fakeExecutor("cell", completed);
    const loadCellConfig = vi.fn(() => ON);
    wf._setRunExecutorsForTests({
      box: box.executor,
      cell: cell.executor,
      loadCellConfig,
    });
    const out = await rawRunFn(await wireInput(), ctx());
    expect(out.outcome).toBe("completed");
    expect(box.fn).toHaveBeenCalledTimes(1);
    expect(cell.fn).not.toHaveBeenCalled();
    expect(loadCellConfig).not.toHaveBeenCalled();
    expect(cellCalls()).toEqual([]);
  });

  // card: protects=negative control: the same input with the marker selects the cell and reads the config exactly once; fails_when=the marker is ignored or the config is read twice; no_claim=the cell executor
  it("T-FLAG-OFF control / T-CONFIG-LAZY: the marker selects the cell, one config read", async () => {
    const box = fakeExecutor("box", completed);
    const cell = fakeExecutor("cell", completed);
    const loadCellConfig = vi.fn(() => ON);
    wf._setRunExecutorsForTests({
      box: box.executor,
      cell: cell.executor,
      loadCellConfig,
    });
    await rawRunFn(await wireInput({ cell: "opensandbox" }), ctx());
    expect(cell.fn).toHaveBeenCalledTimes(1);
    expect(box.fn).not.toHaveBeenCalled();
    expect(loadCellConfig).toHaveBeenCalledTimes(1);
  });

  // card: protects=a marked run with the cell config off or invalid fails cells_unconfigured, never on the box, with no cell request; fails_when=it falls back to the box or calls cell-plan; no_claim=the typed terminal's text
  it.each([
    ["off", { kind: "off" } as CellConfig],
    ["partial", { kind: "invalid", reason: "partial" } as CellConfig],
    ["key_file", { kind: "invalid", reason: "key_file" } as CellConfig],
  ])(
    "T-CONFIG: a marked run with config %s fails cells_unconfigured",
    async (_n, cfg) => {
      const box = fakeExecutor("box", completed);
      const cell = fakeExecutor("cell", completed);
      wf._setRunExecutorsForTests({
        box: box.executor,
        cell: cell.executor,
        loadCellConfig: () => cfg,
      });
      await expect(
        rawRunFn(await wireInput({ cell: "opensandbox" }), ctx()),
      ).rejects.toMatchObject({
        name: "CellRunRefusedError",
        code: "cells_unconfigured",
      });
      expect(box.fn).not.toHaveBeenCalled();
      expect(cell.fn).not.toHaveBeenCalled();
      expect(cellCalls()).toEqual([]);
      // A pre-daemon throw of a task run: the outer catch posts its one typed terminal.
      expect(terminals()).toHaveLength(1);
    },
  );

  // card: protects=a marker on a review, self-heal or reviewAgent input fails cell_lane_refused before the config is read; fails_when=any of them reaches the cell or the box; no_claim=how dispatch stamps the marker
  it.each([
    ["review", { prKey: "org-1/o/r/7", supersedePolicy: "newest-wins" }],
    ["pr", { prNumber: 7 }],
    [
      "self-heal",
      { selfHeal: { kind: "audit", attemptId: "a1", checkToken: "chk-tok" } },
    ],
    ["reviewAgent", { reviewAgent: { agent: "claude" } }],
  ])(
    "T-LANE: a marker on a %s run fails cell_lane_refused",
    async (_n, extra) => {
      const cell = fakeExecutor("cell", completed);
      const loadCellConfig = vi.fn(() => ON);
      wf._setRunExecutorsForTests({
        box: fakeExecutor("box", completed).executor,
        cell: cell.executor,
        loadCellConfig,
      });
      await expect(
        rawRunFn(await wireInput({ cell: "opensandbox", ...extra }), ctx()),
      ).rejects.toMatchObject({ code: "cell_lane_refused" });
      expect(cell.fn).not.toHaveBeenCalled();
      expect(loadCellConfig).not.toHaveBeenCalled();
      expect(cellCalls()).toEqual([]);
    },
  );

  // card: protects=an executor returning fenced posts nothing: no terminal, no onFailure-visible failure; fails_when=runAgentResolved posts a run-terminal for a fenced return; no_claim=the real cell teardown (cell-run.test.ts)
  it("T-FENCED-NO-TERMINAL: a fenced return posts nothing and the engine sees a normal return", async () => {
    const cell = fakeExecutor("cell", async (a) => {
      // A fenced executor claims the end with nothing to post, as cell-run.ts does.
      a.abnormal.claimed = true;
      return {
        threadId: a.input.threadId,
        threadChatId: a.input.threadChatId,
        outcome: "fenced" as const,
      };
    });
    wf._setRunExecutorsForTests({
      box: fakeExecutor("box", completed).executor,
      cell: cell.executor,
      loadCellConfig: () => ON,
    });
    const out = await rawRunFn(await wireInput({ cell: "opensandbox" }), ctx());
    expect(out.outcome).toBe("fenced");
    expect(terminals()).toEqual([]);
  });

  // card: protects=negative control: an executor that throws without claiming gets exactly one typed terminal from the outer catch; fails_when=the catch posts nothing or twice; no_claim=the cause chosen
  it("T-FENCED-NO-TERMINAL control: a throwing executor posts one abnormal end", async () => {
    const cell = fakeExecutor("cell", async () => {
      throw new Error("cell_attempt_revoked");
    });
    wf._setRunExecutorsForTests({
      box: fakeExecutor("box", completed).executor,
      cell: cell.executor,
      loadCellConfig: () => ON,
    });
    await expect(
      rawRunFn(await wireInput({ cell: "opensandbox" }), ctx()),
    ).rejects.toThrow("cell_attempt_revoked");
    expect(terminals()).toHaveLength(1);
    expect(
      posts.find((p) => p.url.endsWith("/run-terminal"))?.body,
    ).toMatchObject({
      cause: "run-failed-unreported",
    });
  });

  // card: protects=an executor that claimed the end itself leaves the outer catch with nothing to post; fails_when=a throw after the claim posts a second terminal; no_claim=the executor's own post
  it("an executor that claimed the abnormal end leaves the outer catch silent", async () => {
    const cell = fakeExecutor("cell", async (a) => {
      a.abnormal.claimed = true; // the cell's finally claims before its teardown
      throw new Error("cell create failed: not_ready");
    });
    wf._setRunExecutorsForTests({
      box: fakeExecutor("box", completed).executor,
      cell: cell.executor,
      loadCellConfig: () => ON,
    });
    await expect(
      rawRunFn(await wireInput({ cell: "opensandbox" }), ctx()),
    ).rejects.toThrow("not_ready");
    expect(terminals()).toEqual([]);
  });

  // card: protects=onFailure skips run-failed for a run whose terminal read retired the token, logging the expected line at info and never as an error; fails_when=it posts, or logs at error level; no_claim=www's side of the 401
  it("T-POST-TERMINAL: a retired run's onFailure posts nothing and logs at info", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const input = await wireInput();
    const runId = "run-retired-1";
    wf._runEndMarksForTests.mark(runId, "retired");
    await workflowDef.onFailure.fn(input, {
      errors: () => ({ run: "late failure" }),
      workflowRunId: () => runId,
    });
    expect(posts).toEqual([]);
    expect(
      info.mock.calls.some((c) =>
        String(c[0]).includes("token retired at the terminal read (expected"),
      ),
    ).toBe(true);
    expect(err).not.toHaveBeenCalled();
    info.mockRestore();
    err.mockRestore();
  });

  // card: protects=negative control: a run that is not recorded retired still posts run-failed; fails_when=onFailure skips every cell run; no_claim=the cell path
  it("T-POST-TERMINAL control: a non-retired failure still posts run-failed", async () => {
    await workflowDef.onFailure.fn(await wireInput(), {
      errors: () => ({ run: "boom" }),
      workflowRunId: () => "run-live-1",
    });
    expect(urls()).toEqual(["/api/daemon-event"]);
  });

  // card: protects=a run whose token www deleted (409 cell_step_conflict) posts no run-failed and logs at info; fails_when=it posts or logs an error; no_claim=www's one alert
  it("T-409-SKIP (onFailure half): a token-gone run posts nothing and logs at info", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const runId = "run-gone-1";
    wf._runEndMarksForTests.mark(runId, "tokenGone");
    await workflowDef.onFailure.fn(await wireInput(), {
      errors: () => ({ run: "cell_step_conflict" }),
      workflowRunId: () => runId,
    });
    expect(posts).toEqual([]);
    expect(
      info.mock.calls.some((c) =>
        String(c[0]).includes("token deleted by www on cell_step_conflict"),
      ),
    ).toBe(true);
    expect(err).not.toHaveBeenCalled();
    info.mockRestore();
    err.mockRestore();
  });

  // card: protects=a fenced run's onFailure (an executionTimeout during its teardown) posts nothing and logs at info; fails_when=run-failed reaches the thread the newer attempt owns; no_claim=the fenced teardown itself (cell-run.test.ts)
  it("M4: a fenced run's onFailure posts nothing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const runId = "run-fenced-1";
    wf._runEndMarksForTests.mark(runId, "fenced");
    await workflowDef.onFailure.fn(await wireInput(), {
      errors: () => ({ run: "timeout" }),
      workflowRunId: () => runId,
    });
    expect(posts).toEqual([]);
    expect(
      info.mock.calls.some((c) =>
        String(c[0]).includes("newer attempt fenced"),
      ),
    ).toBe(true);
    expect(err).not.toHaveBeenCalled();
    info.mockRestore();
    err.mockRestore();
  });

  // card: protects=the real cell executor is wired: a marked run whose plan www refuses with cells_disabled fails with that code and never runs on the box; fails_when=it falls back to the box executor or posts a cell-teardown; no_claim=a live cell
  it("cell half of T-FLAG-OFF: a marked run with cells_disabled fails closed, never on the box", async () => {
    wf._setAdmissionControllerForTests(null);
    const box = fakeExecutor("box", completed);
    wf._setRunExecutorsForTests({
      box: box.executor,
      loadCellConfig: () => ON,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        posts.push({ url, body: JSON.parse(init.body) });
        return String(url).endsWith("/cell-plan")
          ? new Response(JSON.stringify({ error: "cells_disabled" }), {
              status: 404,
            })
          : new Response(JSON.stringify({ applied: true }), { status: 200 });
      }),
    );
    await expect(
      rawRunFn(await wireInput({ cell: "opensandbox" }), ctx()),
    ).rejects.toMatchObject({
      name: "CellPlanRefusedError",
      code: "cells_disabled",
    });
    expect(box.fn).not.toHaveBeenCalled();
    expect(urls().filter((u) => u.endsWith("/cell-plan"))).toHaveLength(1);
    expect(urls().filter((u) => u.endsWith("/cell-teardown"))).toEqual([]);
    // The refusal came before the executor's teardown try: the outer catch posts the one terminal.
    expect(terminals()).toHaveLength(1);
    wf._setAdmissionControllerForTests(undefined);
  });
});
