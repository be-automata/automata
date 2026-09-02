import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Workdir-lifetime proof for the run task.
 *
 * The clone is the one thing this workflow puts on the operator's disk that
 * nothing else will ever reclaim (a box runs for weeks; a leaked clone of a
 * customer repo just sits there). `cleanupWorkdir` normally runs from the run
 * task's finally block — but the D1 credential steps (pull + materialise) sit
 * BETWEEN the clone and that try, and both can throw: the pull is a fetch, so a
 * network error or the run's AbortSignal firing on cancel/scheduleTimeout
 * rejects it, and materialise does fs mkdir/writeFile.
 *
 * These tests drive the real run fn with the surrounding modules mocked and
 * assert the workdir is removed on BOTH of those throw paths. They live in
 * their own file because they mock ./www-client, which workflow.test.ts
 * exercises for real in its onFailure tests.
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

const WORKDIR = "/tmp/automata-worker-runs/thr_leak_1";

const provisionWorkdir = vi.fn(async (..._args: unknown[]) => WORKDIR);
const cleanupWorkdir = vi.fn(async (..._args: unknown[]) => {});
const pullAgentCredentials = vi.fn();
const materialiseAgentCredentials = vi.fn();
const postEgressEvents = vi.fn(async (..._args: unknown[]) => {});
const startEgressProxy = vi.fn();
// #81: brokering is ON by default, so every runFn case would otherwise start
// REAL brokers (a real loopback listener + unix socket). Mocked like the
// egress proxy; per-case behavior set in beforeEach / the broker describe.
const startGitBroker = vi.fn();
const startGhBroker = vi.fn();
// Ctor args of every DaemonProcess the run built (the broker handoff pin).
const daemonCtorArgs: unknown[][] = [];

// #152 Stage A: the admission reap scans the REAL namespace root and issues
// real group-SIGKILLs for dead-sibling debris — on a box that also runs
// production workers, a unit test must never do that (a recycled pgid could
// be live work). Mocked like the other side-effectful collaborators, and the
// mocks RECORD their order so the admission wiring (reclaim → reap → slot,
// per the safety argument in workflow.ts) is asserted, not assumed.
const admissionOrder: string[] = [];
vi.mock("./reclaim", () => ({
  reclaimDeadWorkerRuns: vi.fn(() => {
    admissionOrder.push("reclaim");
  }),
  reapOwnThreadAttempts: vi.fn(() => {
    admissionOrder.push("reap");
    return 0;
  }),
}));
// Same shared-root hazard as ./reclaim: the real acquireBoxSlot creates lock
// dirs under the box's production namespace root during unit tests.
vi.mock("./box-slot", () => ({
  acquireBoxSlot: vi.fn(async () => {
    admissionOrder.push("slot");
    return { release: vi.fn() };
  }),
}));
vi.mock("./provision", () => ({
  provisionWorkdir: (...args: unknown[]) => provisionWorkdir(...args),
  cleanupWorkdir: (...args: unknown[]) => cleanupWorkdir(...args),
}));

const pullNextMessage = vi.fn();
const pollUntilTerminal = vi.fn();
const postRunTerminal = vi.fn(async (..._args: unknown[]) => "applied");
const checkRunStaleness = vi.fn(async (..._args: unknown[]) => false);

vi.mock("./www-client", () => ({
  pullAgentCredentials: (...args: unknown[]) => pullAgentCredentials(...args),
  pullNextMessage: (...args: unknown[]) => pullNextMessage(...args),
  pollUntilTerminal: (...args: unknown[]) => pollUntilTerminal(...args),
  postRunFailed: vi.fn(),
  postRunTerminal: (...args: unknown[]) => postRunTerminal(...args),
  checkRunStaleness: (...args: unknown[]) => checkRunStaleness(...args),
  postEgressEvents: (...args: unknown[]) => postEgressEvents(...args),
}));

const assertEgressProxyReachable = vi.fn(async (..._args: unknown[]) => {});

vi.mock("./egress-proxy", () => ({
  startEgressProxy: (...args: unknown[]) => startEgressProxy(...args),
  assertEgressProxyReachable: (...args: unknown[]) =>
    assertEgressProxyReachable(...args),
}));

vi.mock("./agent-credentials", () => ({
  materialiseAgentCredentials: (...args: unknown[]) =>
    materialiseAgentCredentials(...args),
}));

vi.mock("./git-broker", () => ({
  startGitBroker: (...args: unknown[]) => startGitBroker(...args),
}));

vi.mock("./gh-broker", () => ({
  startGhBroker: (...args: unknown[]) => startGhBroker(...args),
}));

vi.mock("./daemon-process", () => ({
  DaemonProcess: class {
    constructor(...args: unknown[]) {
      daemonCtorArgs.push(args);
    }
    preflightGhAuth = vi.fn();
    start = vi.fn();
    sendMessage = vi.fn(async () => 42);
    teardown = vi.fn();
  },
}));

const INPUT = {
  threadId: "thr_leak_1",
  threadChatId: "tc_1",
  repoFullName: "o/r",
  branch: "main",
  daemonCallbackUrl: "https://www.example.com",
  installationToken: "inst-secret",
  daemonToken: "daemon-tok",
  orgId: "org-1",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runFn: any;
let createEgressEventBatcher: typeof import("./workflow").createEgressEventBatcher;

beforeAll(async () => {
  const mod = await import("./workflow");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (mod.agentRunWorkflow as any).definition;
  runFn = def._tasks[0].fn;
  createEgressEventBatcher = mod.createEgressEventBatcher;
});

beforeEach(() => {
  // "owner" is the only mode that pulls a credential at all.
  process.env.WORKER_BOX_TRUST = "owner";
  provisionWorkdir.mockClear();
  cleanupWorkdir.mockClear();
  pullAgentCredentials.mockReset();
  materialiseAgentCredentials.mockReset();
  postEgressEvents.mockClear();
  startEgressProxy.mockReset();
  assertEgressProxyReachable.mockReset();
  assertEgressProxyReachable.mockResolvedValue(undefined);
  // Default: both brokers start fine (the flag is on by default).
  startGitBroker.mockReset();
  startGhBroker.mockReset();
  startGitBroker.mockResolvedValue({
    url: "http://127.0.0.1:41999",
    port: 41999,
    close: vi.fn(async () => {}),
  });
  startGhBroker.mockResolvedValue({
    socketPath: "/tmp/automata-agent-run/w-test/thr_leak_1-gh.sock",
    close: vi.fn(async () => {}),
  });
  daemonCtorArgs.length = 0;
});

afterEach(() => {
  delete process.env.WORKER_BOX_TRUST;
  delete process.env.WORKER_CREDENTIAL_BROKER;
});

function ctx() {
  return {
    cancelled: false,
    log: vi.fn(),
    abortController: new AbortController(),
  };
}

describe("agent-run run task — workdir is never leaked by a failed credential step", () => {
  it("removes the clone when the credential pull rejects (network error / cancel abort)", async () => {
    pullAgentCredentials.mockRejectedValue(
      new DOMException("aborted", "AbortError"),
    );

    await expect(runFn(INPUT, ctx())).rejects.toThrow(/aborted/);

    expect(provisionWorkdir).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledWith(WORKDIR);
  });

  it("removes the clone when materialising the credential throws (fs failure)", async () => {
    pullAgentCredentials.mockResolvedValue({
      agent: "claude",
      credentials: { type: "json-file", contents: "{}" },
    });
    materialiseAgentCredentials.mockRejectedValue(
      new Error("EACCES: permission denied, mkdir"),
    );

    await expect(runFn(INPUT, ctx())).rejects.toThrow(/EACCES/);

    expect(cleanupWorkdir).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledWith(WORKDIR);
  });

  it("propagates the original error unchanged, so retry classification still sees it", async () => {
    const original = new Error("connect ECONNREFUSED");
    pullAgentCredentials.mockRejectedValue(original);

    await expect(runFn(INPUT, ctx())).rejects.toBe(original);
  });

  it("cleans up exactly once — the guard does not double-clean a run that got past it", async () => {
    // A "shared" box never pulls, so the guarded block cannot throw; the run
    // proceeds and the finally block becomes the single cleanup path.
    process.env.WORKER_BOX_TRUST = "shared";
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      env: {},
      cleanup: vi.fn(async () => {}),
    });

    // Runs to a normal return (no message to execute) — well past the guarded
    // block, so cleanup comes solely from the finally.
    await expect(runFn(INPUT, ctx())).resolves.toMatchObject({
      outcome: "nothing-to-run",
    });

    expect(pullAgentCredentials).not.toHaveBeenCalled();
    expect(cleanupWorkdir).toHaveBeenCalledTimes(1);
  });
});

const EGRESS_INPUT = {
  ...INPUT,
  egressPolicy: { level: "domain" as const, allowlist: ["api.example.com"] },
};

describe("agent-run run task — egress proxy start failure and teardown (#66 slice 2)", () => {
  // The proxy start block sits BETWEEN the clone and the try/finally that owns
  // cleanup (same class of path as the credential steps above), so it must
  // clean up after itself: credential wipe + workdir removal, then rethrow.
  it("start failure: wipes the credential, removes the workdir, and propagates the error", async () => {
    process.env.WORKER_BOX_TRUST = "shared";
    const credentialCleanup = vi.fn(async () => {});
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      env: {},
      cleanup: credentialCleanup,
    });
    const original = new Error("listen EADDRINUSE");
    startEgressProxy.mockRejectedValue(original);

    await expect(runFn(EGRESS_INPUT, ctx())).rejects.toBe(original);

    expect(credentialCleanup).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledWith(WORKDIR);
  });

  it("teardown: a run that started the proxy closes it exactly once in the finally", async () => {
    process.env.WORKER_BOX_TRUST = "shared";
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      env: {},
      cleanup: vi.fn(async () => {}),
    });
    const close = vi.fn(async () => {});
    startEgressProxy.mockResolvedValue({
      url: "http://127.0.0.1:41234",
      port: 41234,
      close,
    });

    await expect(runFn(EGRESS_INPUT, ctx())).resolves.toMatchObject({
      outcome: "nothing-to-run",
    });

    expect(startEgressProxy).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledTimes(1);
  });

  it("A2: a proxy that fails its health check blocks the run before the daemon starts", async () => {
    process.env.WORKER_BOX_TRUST = "shared";
    const credentialCleanup = vi.fn(async () => {});
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      env: {},
      cleanup: credentialCleanup,
    });
    const close = vi.fn(async () => {});
    startEgressProxy.mockResolvedValue({
      url: "http://127.0.0.1:41234",
      port: 41234,
      mode: "enforce",
      observedHosts: () => new Map(),
      close,
    });
    const dead = new Error("egress proxy health check failed");
    assertEgressProxyReachable.mockRejectedValueOnce(dead);

    // Without this the run would hang for 90s producing NO output and no
    // stderr — the agent cannot report a proxy it cannot reach.
    await expect(runFn(EGRESS_INPUT, ctx())).rejects.toBe(dead);
    expect(daemonCtorArgs).toHaveLength(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(credentialCleanup).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledWith(WORKDIR);
  });

  it("#108: no policy AND no agentUser: the proxy is never started (default-off proof)", async () => {
    process.env.WORKER_BOX_TRUST = "shared";
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      env: {},
      cleanup: vi.fn(async () => {}),
    });

    await expect(runFn(INPUT, ctx())).resolves.toMatchObject({
      outcome: "nothing-to-run",
    });

    expect(startEgressProxy).not.toHaveBeenCalled();
    expect(postEgressEvents).not.toHaveBeenCalled();
    expect(assertEgressProxyReachable).not.toHaveBeenCalled();
  });

  it("#108: agentUser set with no policy starts an OBSERVE proxy that still audits", async () => {
    process.env.WORKER_BOX_TRUST = "shared";
    process.env.WORKER_AGENT_USER = "_automata-agent";
    process.env.WORKER_WORKDIR_ROOT = "/usr/local/automata/runs";
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      env: {},
      cleanup: vi.fn(async () => {}),
    });
    const close = vi.fn(async () => {});
    startEgressProxy.mockResolvedValue({
      url: "http://127.0.0.1:41234",
      port: 41234,
      mode: "observe",
      observedHosts: () => new Map(),
      close,
    });

    try {
      await expect(runFn(INPUT, ctx())).resolves.toMatchObject({
        outcome: "nothing-to-run",
      });
      const [opts] = startEgressProxy.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(opts.mode).toBe("observe");
      expect(opts.policy).toEqual({ level: "none", allowlist: [] });
      // A1: allow-all is only defensible BECAUSE it is audited. onEvent must be
      // the real batcher, never a no-op.
      expect(typeof opts.onEvent).toBe("function");
      expect(assertEgressProxyReachable).toHaveBeenCalledWith({
        url: "http://127.0.0.1:41234",
      });
      // and the daemon child is pointed at it
      expect(daemonCtorArgs[0]![4]).toBe("http://127.0.0.1:41234");
    } finally {
      delete process.env.WORKER_AGENT_USER;
      delete process.env.WORKER_WORKDIR_ROOT;
    }
  });

  it("#108: a repo policy stays ENFORCE even in agent-uid mode", async () => {
    process.env.WORKER_BOX_TRUST = "shared";
    process.env.WORKER_AGENT_USER = "_automata-agent";
    process.env.WORKER_WORKDIR_ROOT = "/usr/local/automata/runs";
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      env: {},
      cleanup: vi.fn(async () => {}),
    });
    startEgressProxy.mockResolvedValue({
      url: "http://127.0.0.1:41234",
      port: 41234,
      mode: "enforce",
      observedHosts: () => new Map(),
      close: vi.fn(async () => {}),
    });
    try {
      await runFn(EGRESS_INPUT, ctx());
      const [opts] = startEgressProxy.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(opts.mode).toBe("enforce");
      expect(opts.policy).toEqual(EGRESS_INPUT.egressPolicy);
    } finally {
      delete process.env.WORKER_AGENT_USER;
      delete process.env.WORKER_WORKDIR_ROOT;
    }
  });
});

describe("agent-run run task — credential brokers (#81)", () => {
  function sharedBoxNoCredential() {
    process.env.WORKER_BOX_TRUST = "shared";
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      env: {},
      cleanup: vi.fn(async () => {}),
    });
  }

  it("brokers start by default, the DaemonProcess gets the broker handoff, and both close exactly once", async () => {
    sharedBoxNoCredential();
    const gitClose = vi.fn(async () => {});
    const ghClose = vi.fn(async () => {});
    startGitBroker.mockResolvedValue({
      url: "http://127.0.0.1:41999",
      port: 41999,
      close: gitClose,
    });
    startGhBroker.mockResolvedValue({
      socketPath: "/tmp/automata-agent-run/w-test/thr_leak_1-gh.sock",
      close: ghClose,
    });

    await expect(runFn(INPUT, ctx())).resolves.toMatchObject({
      outcome: "nothing-to-run",
    });

    expect(startGitBroker).toHaveBeenCalledTimes(1);
    // The real token + repo fence go to the broker; one shared bearer to both.
    expect(startGitBroker).toHaveBeenCalledWith(
      expect.objectContaining({
        installationToken: "inst-secret",
        repoFullName: "o/r",
        runBearer: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(startGhBroker).toHaveBeenCalledTimes(1);
    const bearer = (startGitBroker.mock.calls[0]![0] as { runBearer: string })
      .runBearer;
    expect(startGhBroker).toHaveBeenCalledWith(
      expect.objectContaining({
        installationToken: "inst-secret",
        runBearer: bearer,
        socketPath: expect.stringMatching(/thr_leak_1-gh\.sock$/),
      }),
    );
    // The DaemonProcess ctor's broker opt carries the bearer, never the token.
    const brokerArg = daemonCtorArgs[0]![5] as Record<string, string>;
    expect(brokerArg).toMatchObject({
      gitUrl: "http://127.0.0.1:41999",
      bearer,
      repoFullName: "o/r",
    });
    expect(gitClose).toHaveBeenCalledTimes(1);
    expect(ghClose).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledTimes(1);
  });

  it("git broker start failure: fail-closed — wipes the credential, removes the workdir, propagates", async () => {
    sharedBoxNoCredential();
    const credentialCleanup = vi.fn(async () => {});
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      env: {},
      cleanup: credentialCleanup,
    });
    const original = new Error("listen EADDRINUSE");
    startGitBroker.mockRejectedValue(original);

    await expect(runFn(INPUT, ctx())).rejects.toBe(original);

    expect(startGhBroker).not.toHaveBeenCalled();
    expect(credentialCleanup).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledWith(WORKDIR);
  });

  it("gh broker start failure: closes the already-started git broker AND the egress proxy, then rethrows", async () => {
    sharedBoxNoCredential();
    const gitClose = vi.fn(async () => {});
    startGitBroker.mockResolvedValue({
      url: "http://127.0.0.1:41999",
      port: 41999,
      close: gitClose,
    });
    const egressClose = vi.fn(async () => {});
    startEgressProxy.mockResolvedValue({
      url: "http://127.0.0.1:41234",
      port: 41234,
      close: egressClose,
    });
    const original = new Error("sun_path limit");
    startGhBroker.mockRejectedValue(original);

    await expect(runFn(EGRESS_INPUT, ctx())).rejects.toBe(original);

    expect(gitClose).toHaveBeenCalledTimes(1);
    expect(egressClose).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledTimes(1);
  });

  it("WORKER_CREDENTIAL_BROKER=legacy-direct: no brokers, and the DaemonProcess gets broker=null (rollback)", async () => {
    sharedBoxNoCredential();
    process.env.WORKER_CREDENTIAL_BROKER = "legacy-direct";

    await expect(runFn(INPUT, ctx())).resolves.toMatchObject({
      outcome: "nothing-to-run",
    });

    expect(startGitBroker).not.toHaveBeenCalled();
    expect(startGhBroker).not.toHaveBeenCalled();
    expect(daemonCtorArgs[0]![5]).toBeNull();
  });
});

describe("createEgressEventBatcher — audit batch add/flush/close", () => {
  const OPTS = { fake: "www-opts" } as never;
  const event = (n: number) => ({
    destinationHost: `host-${n}.example.com`,
    destinationPort: 443,
    action: "allow" as const,
    policyLevel: "domain" as const,
    mode: "enforce" as const,
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes immediately at 20 events, in wire format with source=worker", () => {
    const batcher = createEgressEventBatcher(OPTS);
    for (let i = 0; i < 20; i++) {
      batcher.add(event(i));
    }
    expect(postEgressEvents).toHaveBeenCalledTimes(1);
    const [opts, events] = postEgressEvents.mock.calls[0] as [
      unknown,
      Array<Record<string, unknown>>,
    ];
    expect(opts).toBe(OPTS);
    expect(events).toHaveLength(20);
    expect(events[0]).toEqual({
      destinationHost: "host-0.example.com",
      destinationPort: 443,
      action: "allow",
      policyLevel: "domain",
      mode: "enforce",
      source: "worker",
    });
  });

  it("flushes a partial batch on the 2s timer, and an empty tick posts nothing", () => {
    const batcher = createEgressEventBatcher(OPTS);
    batcher.add(event(1));
    expect(postEgressEvents).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(postEgressEvents).toHaveBeenCalledTimes(1);

    // Nothing new buffered → the next tick must NOT post an empty batch.
    vi.advanceTimersByTime(2_000);
    expect(postEgressEvents).toHaveBeenCalledTimes(1);
  });

  it("close() flushes the remainder and stops the timer", async () => {
    const batcher = createEgressEventBatcher(OPTS);
    batcher.add(event(1));
    await batcher.close();
    expect(postEgressEvents).toHaveBeenCalledTimes(1);

    // Timer is cleared: time passing after close never posts again.
    vi.advanceTimersByTime(10_000);
    expect(postEgressEvents).toHaveBeenCalledTimes(1);
  });

  it("null destinationPort (unknown) travels as an ABSENT destinationPort", async () => {
    const batcher = createEgressEventBatcher(OPTS);
    batcher.add({
      destinationHost: "unparseable",
      destinationPort: null,
      action: "deny",
      policyLevel: "domain",
      mode: "enforce" as const,
    });
    await batcher.close();
    const [, events] = postEgressEvents.mock.calls[0] as [
      unknown,
      Array<Record<string, unknown>>,
    ];
    expect(events[0]).not.toHaveProperty("destinationPort");
    expect(events[0]).toMatchObject({ action: "deny" });
  });
});

/**
 * #125 C1 cancel hook: when the engine cancels a run under a NATIVE supersede
 * policy, exactly ONE explicit `superseded` terminal is posted to www — after
 * teardown (egress flushed, workdir cleaned) — for an in-flight cancel and for
 * a pre-daemon (provision-phase) cancel alike. Legacy runs (no policy on the
 * input — non-review lanes) post nothing.
 */
describe("#125 C1: engine cancel → explicit superseded terminal", () => {
  const PR_INPUT = {
    ...INPUT,
    prKey: "org-1/o/r/7",
    deliveryId: "gh-1",
  };

  function makeCtx(runId: string | null = "run-ext-1") {
    const abortController = new AbortController();
    const ctx = {
      abortController,
      cancelled: false,
      log: vi.fn(),
      ...(runId !== null ? { workflowRunId: () => runId } : {}),
    };
    // Fire the engine cancel from inside a mocked step: abort + flag + throw.
    const abortIn = (mock: ReturnType<typeof vi.fn>, message = "aborted") =>
      mock.mockImplementation(async () => {
        abortController.abort();
        ctx.cancelled = true;
        throw new Error(message);
      });
    return { ctx, abortIn, abortController };
  }

  beforeEach(() => {
    process.env.WORKER_BOX_TRUST = "shared";
    process.env.WORKER_CREDENTIAL_BROKER = "legacy-direct";
    // abortIn() swaps implementations; restore the harness defaults per case.
    provisionWorkdir.mockReset().mockResolvedValue(WORKDIR);
    cleanupWorkdir.mockReset().mockResolvedValue(undefined);
    pullAgentCredentials.mockReset();
    postRunTerminal.mockReset().mockResolvedValue("applied");
    pullNextMessage.mockReset();
    pollUntilTerminal.mockReset();
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      cleanup: vi.fn(async () => {}),
    });
  });

  it("user Stop (www reports `stopping`): the run ends NOW with ONE user-cancelled terminal stamped with this run's id — no engine cancel involved", async () => {
    const { ctx } = makeCtx("run-ext-stop");
    pullNextMessage.mockResolvedValue({ agent: "claudeCode", model: "m" });
    const order: string[] = [];
    pollUntilTerminal.mockResolvedValue({
      outcome: "stopped",
      finalStatus: "stopping",
    });
    cleanupWorkdir.mockImplementation(async () => {
      order.push("cleanup");
    });
    postRunTerminal.mockImplementation(async () => {
      order.push("post");
      return "applied";
    });

    const out = await runFn(PR_INPUT, ctx); // legacy policy: still posts
    expect(out.outcome).toBe("stopped");
    expect(postRunTerminal).toHaveBeenCalledTimes(1);
    const [, args] = postRunTerminal.mock.calls[0]!;
    expect(args).toEqual({
      runExternalId: "run-ext-stop",
      cause: "user-cancelled",
      policy: undefined,
    });
    // Teardown/cleanup precede the terminal (the daemon is dead before www
    // is told), and the cancel hook did NOT also fire (not an engine cancel).
    expect(order).toEqual(["cleanup", "post"]);
  });

  it("user Stop without a workflowRunId posts nothing (sweep is the backstop)", async () => {
    const { ctx } = makeCtx(null);
    pullNextMessage.mockResolvedValue({ agent: "claudeCode", model: "m" });
    pollUntilTerminal.mockResolvedValue({
      outcome: "stopped",
      finalStatus: "stopping",
    });
    const out = await runFn(PR_INPUT, ctx);
    expect(out.outcome).toBe("stopped");
    expect(postRunTerminal).not.toHaveBeenCalled();
  });

  it("in-flight cancel: ONE terminal, posted AFTER teardown + cleanup, stamped with this run's id (AC3)", async () => {
    const { ctx, abortController } = makeCtx("run-ext-inflight");
    pullNextMessage.mockResolvedValue({ agent: "claudeCode", model: "m" });
    const order: string[] = [];
    pollUntilTerminal.mockImplementation(async () => {
      abortController.abort();
      ctx.cancelled = true;
      return { outcome: "cancelled" };
    });
    cleanupWorkdir.mockImplementation(async () => {
      order.push("cleanup");
    });
    postRunTerminal.mockImplementation(async () => {
      order.push("post");
      return "applied";
    });

    const out = await runFn(
      { ...PR_INPUT, supersedePolicy: "complete-run-discard" },
      ctx,
    );
    expect(out.outcome).toBe("cancelled");
    expect(postRunTerminal).toHaveBeenCalledTimes(1);
    const [opts, args] = postRunTerminal.mock.calls[0]!;
    expect(opts).toMatchObject({
      baseUrl: INPUT.daemonCallbackUrl,
      daemonToken: INPUT.daemonToken,
      threadId: INPUT.threadId,
      runExternalId: "run-ext-inflight",
    });
    expect(args).toEqual({
      runExternalId: "run-ext-inflight",
      cause: "superseded",
      policy: "complete-run-discard",
    });
    expect(order).toEqual(["cleanup", "post"]);
  });

  it("pre-daemon cancel (during provision): terminal posted; nothing to clean (AC4)", async () => {
    const { ctx, abortIn } = makeCtx("run-ext-provision");
    abortIn(provisionWorkdir);
    await expect(
      runFn({ ...PR_INPUT, supersedePolicy: "newest-wins" }, ctx),
    ).rejects.toThrow("aborted");
    expect(postRunTerminal).toHaveBeenCalledTimes(1);
    expect(postRunTerminal.mock.calls[0]![1]).toEqual({
      runExternalId: "run-ext-provision",
      cause: "superseded",
      policy: "newest-wins",
    });
    expect(cleanupWorkdir).not.toHaveBeenCalled();
  });

  it("cancel after the clone (credential pull): workdir cleaned AND terminal posted", async () => {
    const { ctx, abortIn } = makeCtx("run-ext-cred");
    process.env.WORKER_BOX_TRUST = "owner";
    abortIn(pullAgentCredentials, "aborted during pull");
    await expect(
      runFn({ ...PR_INPUT, supersedePolicy: "complete-run-queue" }, ctx),
    ).rejects.toThrow("aborted during pull");
    expect(cleanupWorkdir).toHaveBeenCalledWith(WORKDIR);
    expect(postRunTerminal).toHaveBeenCalledTimes(1);
  });

  it("a NON-cancelled failure posts no superseded terminal (onFailure owns it)", async () => {
    const { ctx } = makeCtx();
    provisionWorkdir.mockRejectedValue(new Error("clone failed"));
    await expect(
      runFn({ ...PR_INPUT, supersedePolicy: "newest-wins" }, ctx),
    ).rejects.toThrow("clone failed");
    expect(postRunTerminal).not.toHaveBeenCalled();
  });

  it("legacy run (no policy) and a retired 'app-side' WIRE literal: cancel posts nothing (AC7/#165)", async () => {
    // 'app-side' left the TS union in #165, but input is a WIRE value — a
    // pre-#165 in-flight run can still carry the literal. The positive
    // allowlist must fail toward posting nothing (sweep is the backstop).
    const retired = { supersedePolicy: "app-side" } as unknown as Pick<
      typeof PR_INPUT,
      never
    >;
    for (const extra of [{}, retired]) {
      const { ctx, abortIn } = makeCtx();
      abortIn(provisionWorkdir);
      await expect(runFn({ ...PR_INPUT, ...extra }, ctx)).rejects.toThrow();
    }
    expect(postRunTerminal).not.toHaveBeenCalled();
  });

  it("no workflowRunId: logs and skips the post (C4 sweep is the backstop)", async () => {
    const { ctx, abortIn } = makeCtx(null);
    abortIn(provisionWorkdir);
    await expect(
      runFn({ ...PR_INPUT, supersedePolicy: "newest-wins" }, ctx),
    ).rejects.toThrow();
    expect(postRunTerminal).not.toHaveBeenCalled();
    expect(
      ctx.log.mock.calls.some((c) => String(c[0]).includes("no workflowRunId")),
    ).toBe(true);
  });
});

/**
 * #125 C4 queue-mode staleness self-check: under complete-run·queue the run
 * asks www FIRST whether a newer run is already recorded for its PR and, if
 * so, skips itself with a `stale-skipped` terminal before provisioning
 * anything. Other policies never ask; a transport failure fails open.
 */
describe("#125 C4: queue-mode staleness self-check", () => {
  const QUEUE_INPUT = {
    ...INPUT,
    prKey: "org-1/o/r/9",
    deliveryId: "gh-9",
    supersedePolicy: "complete-run-queue" as const,
  };
  const ctx = () => ({
    abortController: new AbortController(),
    cancelled: false,
    log: vi.fn(),
    workflowRunId: () => "run-ext-q",
  });

  beforeEach(() => {
    process.env.WORKER_BOX_TRUST = "shared";
    process.env.WORKER_CREDENTIAL_BROKER = "legacy-direct";
    provisionWorkdir.mockReset().mockResolvedValue(WORKDIR);
    cleanupWorkdir.mockReset().mockResolvedValue(undefined);
    postRunTerminal.mockReset().mockResolvedValue("applied");
    checkRunStaleness.mockReset().mockResolvedValue(false);
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      cleanup: vi.fn(async () => {}),
    });
    pullNextMessage.mockReset().mockResolvedValue(null);
  });

  it("stale ⇒ stale-skipped terminal, NO provisioning, outcome stale-skipped (AC4)", async () => {
    checkRunStaleness.mockResolvedValue(true);
    const c = ctx();
    const out = await runFn(QUEUE_INPUT, c);
    expect(out.outcome).toBe("stale-skipped");
    expect(provisionWorkdir).not.toHaveBeenCalled();
    expect(postRunTerminal).toHaveBeenCalledTimes(1);
    const [opts, args] = postRunTerminal.mock.calls[0]!;
    expect(opts).toMatchObject({
      threadId: INPUT.threadId,
      runExternalId: "run-ext-q",
    });
    expect(args).toEqual({
      runExternalId: "run-ext-q",
      cause: "stale-skipped",
      policy: "complete-run-queue",
    });
  });

  it("not stale ⇒ the run proceeds to provision", async () => {
    const out = await runFn(QUEUE_INPUT, ctx());
    expect(checkRunStaleness).toHaveBeenCalledTimes(1);
    expect(provisionWorkdir).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe("nothing-to-run");
    expect(postRunTerminal).not.toHaveBeenCalled();
  });

  it("other policies and legacy runs never ask", async () => {
    for (const extra of [
      {},
      { supersedePolicy: "newest-wins" as const },
      { supersedePolicy: "complete-run-discard" as const },
    ]) {
      await runFn({ ...INPUT, prKey: "k", deliveryId: "d", ...extra }, ctx());
    }
    expect(checkRunStaleness).not.toHaveBeenCalled();
  });
});

describe("#152 Stage A: admission wiring order", () => {
  it("BOTH admission reaps run BEFORE the box-slot acquire — with the run's threadId and the namespace root (their relative order is not a contract)", async () => {
    admissionOrder.length = 0;
    const { reapOwnThreadAttempts, reclaimDeadWorkerRuns } = await import(
      "./reclaim"
    );
    vi.mocked(reapOwnThreadAttempts).mockClear();
    vi.mocked(reclaimDeadWorkerRuns).mockClear();
    // Fail at the credential pull — everything at and before the slot has run.
    pullAgentCredentials.mockRejectedValue(new Error("stop here"));
    await expect(runFn({ ...INPUT }, ctx())).rejects.toThrow("stop here");
    // The load-bearing invariant is set-before-slot, not reclaim-vs-reap
    // order (either order yields the same end state — see reclaim.ts docs).
    expect(admissionOrder.slice(0, 3).sort()).toEqual([
      "reap",
      "reclaim",
      "slot",
    ]);
    expect(admissionOrder[2]).toBe("slot");
    expect(vi.mocked(reapOwnThreadAttempts)).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: INPUT.threadId }),
    );
    expect(vi.mocked(reclaimDeadWorkerRuns)).toHaveBeenCalledWith(
      expect.objectContaining({ root: expect.any(String) }),
    );
  });
});
