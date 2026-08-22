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

vi.mock("./provision", () => ({
  provisionWorkdir: (...args: unknown[]) => provisionWorkdir(...args),
  cleanupWorkdir: (...args: unknown[]) => cleanupWorkdir(...args),
}));

vi.mock("./www-client", () => ({
  pullAgentCredentials: (...args: unknown[]) => pullAgentCredentials(...args),
  pullNextMessage: vi.fn(),
  pollUntilTerminal: vi.fn(),
  postRunFailed: vi.fn(),
  postEgressEvents: (...args: unknown[]) => postEgressEvents(...args),
}));

vi.mock("./egress-proxy", () => ({
  startEgressProxy: (...args: unknown[]) => startEgressProxy(...args),
}));

vi.mock("./agent-credentials", () => ({
  materialiseAgentCredentials: (...args: unknown[]) =>
    materialiseAgentCredentials(...args),
}));

vi.mock("./daemon-process", () => ({
  DaemonProcess: class {
    preflightGhAuth = vi.fn();
    start = vi.fn();
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
});

afterEach(() => {
  delete process.env.WORKER_BOX_TRUST;
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

  it("policy absent: the proxy is never started (zero behavior change)", async () => {
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
  });
});

describe("createEgressEventBatcher — audit batch add/flush/close", () => {
  const OPTS = { fake: "www-opts" } as never;
  const event = (n: number) => ({
    destinationHost: `host-${n}.example.com`,
    destinationPort: 443,
    action: "allow" as const,
    policyLevel: "domain" as const,
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
