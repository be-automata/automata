import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import { runPaths } from "./run-owned-paths";

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

/** The run dir — what cleanup removes; the clone is RUN.repo beneath it. */
const WORKDIR = "/tmp/automata-worker-runs/thr_leak_1";
const RUN = runPaths(WORKDIR);

const provisionWorkdir = vi.fn(async (..._args: unknown[]) => RUN);
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
// Phase 5: every message the run wrote to the daemon socket.
const sendMessageCalls: unknown[] = [];

// #152 Stage A: the admission reap scans the REAL namespace root and issues
// real group-SIGKILLs for dead-sibling debris — on a box that also runs
// production workers, a unit test must never do that (a recycled pgid could
// be live work). Mocked like the other side-effectful collaborators, and the
// mocks RECORD their order so the admission wiring (reclaim → reap → lock,
// per the safety argument in workflow.ts) is asserted, not assumed.
const admissionOrder: string[] = [];
// #183 AC10: the main finally's teardown order (daemon teardown →
// cleanupWorkdir → box-lock release) is recorded by the three mocks below and
// asserted in the "#183: finally order" describe. The catch-path releases
// (before cleanupWorkdir) are NOT covered here on purpose — see ADR-007 I2.
const finallyOrder: string[] = [];
const releaseMock = vi.fn(async () => {
  finallyOrder.push("release");
});
vi.mock("./reclaim", () => ({
  reclaimDeadWorkerRuns: vi.fn(() => {
    admissionOrder.push("reclaim");
  }),
  reapOwnThreadAttempts: vi.fn(() => {
    admissionOrder.push("reap");
    return 0;
  }),
}));
// Same shared-root hazard as ./reclaim: the real acquireBoxLock spawns a
// lockf/flock helper on the box's production namespace root during unit tests.
// #205: the workflow acquires a SLOT (acquireBoxSlot); at N = 1 that is the
// exclusive lock. One mock serves both names so a case that swaps the
// implementation under either name swaps the one the workflow calls.
const acquireBoxSlotMock = vi.fn(async () => {
  admissionOrder.push("lock");
  return { release: releaseMock, lost: false, slot: 0 };
});
vi.mock("./box-lock", async (importOriginal) => ({
  // The slot guards (assertSlotIndex & co) stay real: spawn-as-user and config
  // call them at load time. Only the acquire is stubbed.
  ...(await importOriginal<typeof import("./box-lock")>()),
  acquireBoxSlot: (...args: unknown[]) => acquireBoxSlotMock(...(args as [])),
  acquireBoxLock: (...args: unknown[]) => acquireBoxSlotMock(...(args as [])),
}));
// Same hazard once more: with WORKER_AGENT_USER set (the #108 cases below),
// the real ensureRunNamespace applies REAL ACLs (macOS chmod +a / Linux
// setfacl) for that account on the box's production namespace root. That only
// ever passed on machines where the agent account exists — on any other box
// (CI runners included) the exec fails and takes the run down with it.
// Recorded in admissionOrder so the wiring (grant re-asserted BEFORE anything
// touches the namespace dir) stays asserted, not assumed. Everything else
// run-namespace exports stays real.
const ensureRunNamespace = vi.fn(async (_opts: unknown) => {
  admissionOrder.push("ensure-ns");
  return "/tmp/automata-agent-run/test";
});
// #205: the slot subdir grant is a real mkdir + setfacl/chmod +a on the box's
// namespace root — mocked for the same reason, and recorded in order.
const ensureSlotNamespace = vi.fn(async (_opts: unknown) => {
  admissionOrder.push("slot-ns");
  return "/tmp/automata-agent-run/test/s1";
});
vi.mock("./run-namespace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-namespace")>()),
  ensureRunNamespace: (opts: unknown) => ensureRunNamespace(opts),
  ensureSlotNamespace: (opts: unknown) => ensureSlotNamespace(opts),
}));
// #184 (#152 Stage B2): the real reaper's default spawnKill is a REAL
// `sudo kill -9 -- -1` as the agent uid — lethal to live work on the pilot
// box. This mock is the ONLY fence and lands in the same edit as the workflow
// import. It records both phases so the admission order (lock → uid-scan →
// daemon start, AC11/AC15) and the finally order (teardown → uid-scan →
// cleanupWorkdir → release, AC12) are asserted, not assumed.
const reapAgentUidEscapees = vi.fn(async (opts: { phase: string }) => {
  admissionOrder.push(`uid-reap:${opts.phase}`);
  finallyOrder.push(`uid-reap:${opts.phase}`);
  return {
    skipped: false,
    scanned: 0,
    groups: 0,
    helpers: 0,
    killed: 0,
    residual: 0,
    failed: 0,
    durationMs: 0,
  };
});
vi.mock("./uid-reaper", () => ({
  reapAgentUidEscapees: (...args: unknown[]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reapAgentUidEscapees(...(args as [any])),
}));
vi.mock("./provision", () => ({
  // #205: recorded in the module wrapper (not the vi.fn, which cases reset)
  // so lock-before-clone is pinned by order, not inferred.
  provisionWorkdir: (...args: unknown[]) => {
    admissionOrder.push("clone");
    return provisionWorkdir(...args);
  },
  cleanupWorkdir: (...args: unknown[]) => {
    finallyOrder.push("cleanupWorkdir");
    return cleanupWorkdir(...args);
  },
}));

// GATE-01 (09-10): the post-agent fix check and its report, recorded in the
// finally order so the kill → reap → close → check → report sequence is
// asserted, not assumed.
const FIX_PUSHED = "a".repeat(40);
const FIX_BASE = "b".repeat(40);
const pinFixBaseSha = vi.fn(async (..._args: unknown[]) => FIX_BASE);
const remoteBranchHead = vi.fn(async (..._args: unknown[]) => FIX_PUSHED);
const runFixCheck = vi.fn(async (..._args: unknown[]) => {
  finallyOrder.push("runFixCheck");
  return {
    workerStatus: "completed",
    headSha: FIX_PUSHED,
    checkOutcome: "pass",
    deniedPaths: [],
  };
});
const postSelfHealFixCheck = vi.fn(async (..._args: unknown[]) => {
  finallyOrder.push("postSelfHealFixCheck");
  return "recorded";
});
vi.mock("./self-heal-fix-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./self-heal-fix-check")>()),
  pinFixBaseSha: (...args: unknown[]) => pinFixBaseSha(...args),
  remoteBranchHead: (...args: unknown[]) => remoteBranchHead(...args),
  runFixCheck: (...args: unknown[]) => runFixCheck(...args),
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
  postRunCredentialSource: vi.fn(),
  postSelfHealFixCheck: (...args: unknown[]) => postSelfHealFixCheck(...args),
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

let fakeRunCgroupDir: string | null = null;
const readMemoryAnon = vi.fn(
  (_opts: { cgroupDir: string }): number | null => null,
);
vi.mock("./run-cgroup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-cgroup")>()),
  readMemoryAnon: (opts: { cgroupDir: string }) => readMemoryAnon(opts),
}));

vi.mock("./daemon-process", () => ({
  DaemonProcess: class {
    constructor(...args: unknown[]) {
      daemonCtorArgs.push(args);
    }
    preflightGhAuth = vi.fn();
    // #184 AC15: the daemon may only be spawned AFTER the admission uid-scan.
    start = vi.fn(() => {
      admissionOrder.push("daemon-start");
    });
    sendMessage = vi.fn(async (message: unknown) => {
      sendMessageCalls.push(message);
      return 42;
    });
    teardown = vi.fn(() => {
      finallyOrder.push("teardown");
    });
    // #371: a test sets fakeRunCgroupDir to stand in for the ceiling's cgroup.
    runCgroupDir = () => fakeRunCgroupDir;
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
  // #371: the headroom gate is OFF for this file unless a describe installs a
  // controller — on a Linux runner the lazy boot decision would otherwise read
  // the runner's live /proc/meminfo and a loaded CI box could defer unrelated
  // admissions.
  mod._setAdmissionControllerForTests(null);
});

beforeEach(() => {
  // "owner" is the only mode that pulls a credential at all.
  process.env.WORKER_BOX_TRUST = "owner";
  provisionWorkdir.mockClear();
  cleanupWorkdir.mockClear();
  ensureRunNamespace.mockClear();
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
  sendMessageCalls.length = 0;
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

describe("agent-run run task — the run's lane is journaled first (UAT #229 F2)", () => {
  it("logs `run start: lane=…` before the clone, so a run that dies cloning still says what it was", async () => {
    provisionWorkdir.mockRejectedValueOnce(new Error("clone failed"));
    const c = ctx();

    await expect(
      runFn(
        {
          ...INPUT,
          prNumber: 7,
          prKey: "org-1/o/r/7",
          supersedePolicy: "newest-wins",
        },
        c,
      ),
    ).rejects.toThrow(/clone failed/);

    const lines = c.log.mock.calls.map((call) => String(call[0]));
    const start = lines.findIndex((l) => l.includes("run start:"));
    expect(start, lines.join("\n")).toBeGreaterThan(-1);
    expect(lines[start]).toContain(
      "[agent-run thr_leak_1] run start: lane=review pr=7 repo=o/r branch=main policy=newest-wins",
    );
    expect(lines.some((l) => l.includes("clone complete"))).toBe(false);
    expect(lines.join("\n")).not.toContain("inst-secret");
    expect(lines.join("\n")).not.toContain("daemon-tok");
  });
});

describe("agent-run run task — workdir is never leaked by a failed credential step", () => {
  it("removes the clone when the credential pull rejects (network error / cancel abort)", async () => {
    pullAgentCredentials.mockRejectedValue(
      new DOMException("aborted", "AbortError"),
    );

    await expect(runFn(INPUT, ctx())).rejects.toThrow(/aborted/);

    expect(provisionWorkdir).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledWith(WORKDIR, expect.anything());
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
    expect(cleanupWorkdir).toHaveBeenCalledWith(WORKDIR, expect.anything());
  });

  it("propagates the original error unchanged, so retry classification still sees it", async () => {
    const original = new Error("connect ECONNREFUSED");
    pullAgentCredentials.mockRejectedValue(original);

    await expect(runFn(INPUT, ctx())).rejects.toSatisfy(
      (e: Error) => e.cause === original,
    );
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

    await expect(runFn(EGRESS_INPUT, ctx())).rejects.toSatisfy(
      (e: Error) => e.cause === original,
    );

    expect(credentialCleanup).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledWith(WORKDIR, expect.anything());
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
      unauthenticatedRequests: () => 0,
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
      unauthenticatedRequests: () => 0,
      close,
    });
    const dead = new Error("egress proxy health check failed");
    assertEgressProxyReachable.mockRejectedValueOnce(dead);

    // Without this the run would hang for 90s producing NO output and no
    // stderr — the agent cannot report a proxy it cannot reach.
    await expect(runFn(EGRESS_INPUT, ctx())).rejects.toSatisfy(
      (e: Error) => e.cause === dead,
    );
    expect(daemonCtorArgs).toHaveLength(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(credentialCleanup).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledWith(WORKDIR, expect.anything());
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
      unauthenticatedRequests: () => 0,
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
      // #205: N = 1 stays credential-less (byte-identical proxy env).
      expect(opts.credential).toBeUndefined();
      // A1: allow-all is only defensible BECAUSE it is audited. onEvent must be
      // the real batcher, never a no-op.
      expect(typeof opts.onEvent).toBe("function");
      expect(assertEgressProxyReachable).toHaveBeenCalledWith({
        url: "http://127.0.0.1:41234",
      });
      // and the daemon child is pointed at it
      expect(daemonCtorArgs[0]![4]).toBe("http://127.0.0.1:41234");
      // The #108 grant repair got the agent account and the configured root —
      // the mock (see top of file) stands in for real chmod +a / setfacl.
      expect(ensureRunNamespace).toHaveBeenCalledWith(
        expect.objectContaining({
          agentUser: "_automata-agent",
          root: "/tmp/automata-agent-run",
        }),
      );
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
      unauthenticatedRequests: () => 0,
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

    await expect(runFn(INPUT, ctx())).rejects.toSatisfy(
      (e: Error) => e.cause === original,
    );

    expect(startGhBroker).not.toHaveBeenCalled();
    expect(credentialCleanup).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledWith(WORKDIR, expect.anything());
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
      unauthenticatedRequests: () => 0,
      close: egressClose,
    });
    const original = new Error("sun_path limit");
    startGhBroker.mockRejectedValue(original);

    await expect(runFn(EGRESS_INPUT, ctx())).rejects.toSatisfy(
      (e: Error) => e.cause === original,
    );

    expect(gitClose).toHaveBeenCalledTimes(1);
    expect(egressClose).toHaveBeenCalledTimes(1);
    expect(cleanupWorkdir).toHaveBeenCalledTimes(1);
  });

  const FIX_INPUT = {
    ...INPUT,
    branch: "main",
    selfHeal: {
      kind: "fix" as const,
      attemptId: "att_1",
      branch: "automata/fix-12-deadbeef-a1",
      baseBranch: "main",
      checks: [],
      denyExceptions: [],
      gateToken: "GATE_SENTINEL",
    },
  };

  it("FENCE-01: a self-heal fix run's git broker is fenced to exactly its attempt branch", async () => {
    sharedBoxNoCredential();

    await expect(runFn(FIX_INPUT, ctx())).resolves.toMatchObject({
      outcome: "nothing-to-run",
    });

    expect(startGitBroker).toHaveBeenCalledTimes(1);
    expect(startGitBroker).toHaveBeenCalledWith(
      expect.objectContaining({
        refFence: { exactRef: "refs/heads/automata/fix-12-deadbeef-a1" },
      }),
    );
  });

  it("FENCE-01: any other run's git broker gets NO refFence key", async () => {
    sharedBoxNoCredential();

    await expect(runFn(INPUT, ctx())).resolves.toMatchObject({
      outcome: "nothing-to-run",
    });

    expect(startGitBroker.mock.calls[0]![0]).not.toHaveProperty("refFence");
  });

  it("FENCE-01: a fix run refuses to start without the credential broker (the fence lives there)", async () => {
    sharedBoxNoCredential();
    process.env.WORKER_CREDENTIAL_BROKER = "legacy-direct";

    await expect(runFn(FIX_INPUT, ctx())).rejects.toThrow(
      /self-heal fix run requires the credential broker/,
    );

    expect(provisionWorkdir).not.toHaveBeenCalled();
    expect(startGitBroker).not.toHaveBeenCalled();
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
    provisionWorkdir.mockReset().mockResolvedValue(RUN);
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

  it("pre-daemon cancel (during provision): terminal posted; nothing to clean; the slot held for the clone is given back (AC4, #205)", async () => {
    const { ctx, abortIn } = makeCtx("run-ext-provision");
    releaseMock.mockClear();
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
    // #205: the clone runs under the slot, so a failed clone releases it.
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("cancel after the clone (credential pull): workdir cleaned AND terminal posted", async () => {
    const { ctx, abortIn } = makeCtx("run-ext-cred");
    process.env.WORKER_BOX_TRUST = "owner";
    abortIn(pullAgentCredentials, "aborted during pull");
    await expect(
      runFn({ ...PR_INPUT, supersedePolicy: "complete-run-queue" }, ctx),
    ).rejects.toThrow("aborted during pull");
    expect(cleanupWorkdir).toHaveBeenCalledWith(WORKDIR, expect.anything());
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

  it("#183 AC13 (#205 shape): cancel while WAITING on the box slot: the abort propagates untouched (a cancel is the engine's own act, never fenced — #371), ONE superseded terminal, NO clone yet so nothing to clean, no failure post, no release", async () => {
    const { ctx, abortIn } = makeCtx("run-ext-lockwait");
    const { postRunFailed } = await import("./www-client");
    vi.mocked(postRunFailed).mockClear();
    releaseMock.mockClear();
    // The waiting helper is SIGKILLed on abort and acquireBoxSlot rejects with
    // the AbortError shape (box-lock.ts) — the workflow must not wrap it.
    abortIn(acquireBoxSlotMock, "box lock wait aborted");
    try {
      // A cancel is the engine's own act: it passes the fence UNWRAPPED (a
      // non-cancel AbortError IS fenced — see retry-classification.test).
      const abortErr: unknown = await runFn(
        { ...PR_INPUT, supersedePolicy: "newest-wins" },
        ctx,
      ).catch((e: unknown) => e);
      expect(abortErr).toBeInstanceOf(Error);
      expect((abortErr as Error).message).toMatch(/aborted/);
      expect(abortErr).not.toBeInstanceOf(NonRetryableError);
      expect(postRunTerminal).toHaveBeenCalledTimes(1);
      expect(postRunTerminal.mock.calls[0]![1]).toEqual(
        expect.objectContaining({
          cause: "superseded",
          policy: "newest-wins",
        }),
      );
      // #205: the slot is taken BEFORE the clone, so a cancel while waiting
      // has no workdir to clean — and nothing to release.
      expect(provisionWorkdir).not.toHaveBeenCalled();
      expect(cleanupWorkdir).not.toHaveBeenCalled();
      expect(postRunFailed).not.toHaveBeenCalled();
      expect(releaseMock).not.toHaveBeenCalled();
    } finally {
      // abortIn() swapped the module-level mock's implementation; restore the
      // harness default so later cases acquire normally.
      acquireBoxSlotMock.mockImplementation(async () => {
        admissionOrder.push("lock");
        return { release: releaseMock, lost: false, slot: 0 };
      });
    }
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
    provisionWorkdir.mockReset().mockResolvedValue(RUN);
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
  it("BOTH admission reaps run BEFORE the box-lock acquire — with the run's threadId and the namespace root (their relative order is not a contract)", async () => {
    admissionOrder.length = 0;
    const { reapOwnThreadAttempts, reclaimDeadWorkerRuns } = await import(
      "./reclaim"
    );
    vi.mocked(reapOwnThreadAttempts).mockClear();
    vi.mocked(reclaimDeadWorkerRuns).mockClear();
    // Fail at the credential pull — everything at and before the lock has run.
    pullAgentCredentials.mockRejectedValue(new Error("stop here"));
    await expect(runFn({ ...INPUT }, ctx())).rejects.toThrow("stop here");
    // The namespace grant is re-asserted before ANYTHING touches the dir.
    expect(admissionOrder[0]).toBe("ensure-ns");
    // The load-bearing invariant is set-before-lock, not reclaim-vs-reap
    // order (either order yields the same end state — see reclaim.ts docs).
    expect(admissionOrder.slice(1, 3).sort()).toEqual(["reap", "reclaim"]);
    expect(admissionOrder[3]).toBe("lock");
    // #205: the clone runs UNDER the slot (its ACL grant needs the slot's account).
    expect(admissionOrder[4]).toBe("clone");
    // #184 AC11: the uid-scan runs UNDER the lock, before the credential pull
    // (which rejects here and stops the run right after).
    expect(admissionOrder[5]).toBe("uid-reap:admission");
    expect(vi.mocked(reapOwnThreadAttempts)).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: INPUT.threadId }),
    );
    expect(vi.mocked(reclaimDeadWorkerRuns)).toHaveBeenCalledWith(
      expect.objectContaining({ root: expect.any(String) }),
    );
  });

  it("#184 AC15: scan-then-spawn — the admission uid-scan runs after the lock and BEFORE the daemon starts, with the config's agentUser and the run's threadId", async () => {
    admissionOrder.length = 0;
    reapAgentUidEscapees.mockClear();
    process.env.WORKER_BOX_TRUST = "shared";
    process.env.WORKER_CREDENTIAL_BROKER = "legacy-direct";
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      cleanup: vi.fn(async () => {}),
    });
    pullNextMessage.mockReset().mockResolvedValue({
      agent: "claudeCode",
      model: "m",
    });
    pollUntilTerminal.mockReset().mockResolvedValue({
      outcome: "terminal",
      finalStatus: "complete",
    });
    postRunTerminal.mockReset().mockResolvedValue("applied");
    await runFn(INPUT, ctx());
    expect(admissionOrder[0]).toBe("ensure-ns");
    expect(admissionOrder.slice(1, 3).sort()).toEqual(["reap", "reclaim"]);
    // The mock records BOTH phases here, so the teardown scan closes the list.
    expect(admissionOrder.slice(3)).toEqual([
      "lock",
      "clone",
      "uid-reap:admission",
      "daemon-start",
      "uid-reap:teardown",
    ]);
    const { loadWorkerConfig } = await import("./config");
    expect(reapAgentUidEscapees).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "admission",
        threadId: INPUT.threadId,
        agentUser: loadWorkerConfig().agentUser,
        runNamespaceRoot: loadWorkerConfig().runNamespaceRoot,
      }),
    );
    expect(reapAgentUidEscapees).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "teardown", threadId: INPUT.threadId }),
    );
  });
});

describe("agent-run run task — the terminal poll is journaled per run", () => {
  it("the poll's thread-status line carries the [agent-run <id>] prefix (the box acceptance check orders the fix check after it, per thread)", async () => {
    process.env.WORKER_BOX_TRUST = "shared";
    process.env.WORKER_CREDENTIAL_BROKER = "legacy-direct";
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      cleanup: vi.fn(async () => {}),
    });
    pullNextMessage.mockReset().mockResolvedValue({
      agent: "claudeCode",
      model: "m",
    });
    pollUntilTerminal
      .mockReset()
      .mockImplementation(async (pollCtx: { log: (m: string) => void }) => {
        pollCtx.log("thread-status: complete (terminal=true)");
        return { outcome: "terminal", finalStatus: "complete" };
      });
    postRunTerminal.mockReset().mockResolvedValue("applied");
    const c = ctx();

    await runFn(INPUT, c);

    const lines = c.log.mock.calls.map((call) => String(call[0]));
    const poll = lines.find((l) => l.includes("thread-status:"));
    expect(poll, lines.join("\n")).toBe(
      `[agent-run ${INPUT.threadId}] thread-status: complete (terminal=true)`,
    );
  });
});

/**
 * #183 AC10 (ADR-007 I2): in the run's MAIN finally the box lock is released
 * LAST — after the daemon's process group is torn down and after the workdir
 * is gone — so the next run on the box can never overlap this one's daemon or
 * its disk footprint. Holds on a normal return and on a throw from inside the
 * main try alike. The three pre-daemon catch paths (credential pull, egress
 * proxy, brokers) release BEFORE cleanupWorkdir by design and are out of scope.
 */
describe("#183: finally order — box lock released last, after teardown and cleanupWorkdir", () => {
  // #184 AC12: the teardown uid-scan sits between the daemon teardown and
  // cleanupWorkdir (before the proxy/broker closes — escapees are child
  // traffic); the box-lock release stays last.
  const TEARDOWN_TOKENS = [
    "teardown",
    "uid-reap:teardown",
    "cleanupWorkdir",
    "release",
  ];
  const ctx = () => ({
    abortController: new AbortController(),
    cancelled: false,
    log: vi.fn(),
    workflowRunId: () => "run-ext-fin",
  });

  beforeEach(() => {
    process.env.WORKER_BOX_TRUST = "shared";
    process.env.WORKER_CREDENTIAL_BROKER = "legacy-direct";
    finallyOrder.length = 0;
    releaseMock.mockClear();
    provisionWorkdir.mockReset().mockResolvedValue(RUN);
    cleanupWorkdir.mockReset().mockResolvedValue(undefined);
    postRunTerminal.mockReset().mockResolvedValue("applied");
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      cleanup: vi.fn(async () => {}),
    });
    pullNextMessage.mockReset();
    pollUntilTerminal.mockReset();
  });

  it("normal return: teardown → cleanupWorkdir → release, release exactly once", async () => {
    pullNextMessage.mockResolvedValue(null);
    await expect(runFn(INPUT, ctx())).resolves.toMatchObject({
      outcome: "nothing-to-run",
    });
    expect(finallyOrder.filter((x) => TEARDOWN_TOKENS.includes(x))).toEqual([
      "teardown",
      "uid-reap:teardown",
      "cleanupWorkdir",
      "release",
    ]);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("#184: a LOST box lock skips the teardown uid-scan (another run may own the box) — logged, admission scan still ran, release still last", async () => {
    reapAgentUidEscapees.mockClear();
    acquireBoxSlotMock.mockImplementationOnce(async () => {
      admissionOrder.push("lock");
      return { release: releaseMock, lost: true, slot: 0 };
    });
    pullNextMessage.mockResolvedValue(null);
    const c = ctx();
    await expect(runFn(INPUT, c)).resolves.toMatchObject({
      outcome: "nothing-to-run",
    });
    expect(reapAgentUidEscapees.mock.calls.map(([opts]) => opts.phase)).toEqual(
      ["admission"],
    );
    expect(finallyOrder.filter((x) => TEARDOWN_TOKENS.includes(x))).toEqual([
      "teardown",
      "cleanupWorkdir",
      "release",
    ]);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    const skipped = c.log.mock.calls
      .map((call) => String(call[0]))
      .filter((l) => l.includes("box.escapees_scan_skipped"));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('"phase":"teardown"');
    expect(skipped[0]).toContain('"reason":"lock lost"');
  });

  it("throw from inside the main try (pollUntilTerminal rejects): same order, release exactly once", async () => {
    pullNextMessage.mockResolvedValue({ agent: "claudeCode", model: "m" });
    pollUntilTerminal.mockRejectedValue(new Error("poll blew up"));
    await expect(runFn(INPUT, ctx())).rejects.toThrow("poll blew up");
    expect(finallyOrder.filter((x) => TEARDOWN_TOKENS.includes(x))).toEqual([
      "teardown",
      "uid-reap:teardown",
      "cleanupWorkdir",
      "release",
    ]);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});

describe("review agent wire + batteries line (Phase 5)", () => {
  const REVIEW_MESSAGE = {
    type: "claude",
    model: "sonnet",
    agent: "claudeCode",
    agentVersion: 1,
    prompt: "review",
    sessionId: null,
    permissionMode: "review",
    featureFlags: {},
  };
  const ORCHESTRATED = {
    mode: "orchestrated" as const,
    batteries: ["gstack-review"],
    runTests: true,
    runTestsDowngradedReason: "fork" as const,
    commandTimeoutMs: 240000,
    maxTurns: 30,
  };
  const CLASSIC = {
    mode: "classic" as const,
    batteries: [],
    runTests: false,
    commandTimeoutMs: 60000,
  };
  const SEEDED = {
    ok: true as const,
    packs: ["gstack-review"],
    manifestHash: "abcdef012345".padEnd(64, "0"),
  };

  beforeEach(() => {
    process.env.WORKER_BOX_TRUST = "shared";
    process.env.WORKER_CREDENTIAL_BROKER = "legacy-direct";
    pullNextMessage.mockReset().mockResolvedValue({ ...REVIEW_MESSAGE });
    pollUntilTerminal.mockReset().mockResolvedValue({
      outcome: "completed",
      finalStatus: "complete",
    });
  });

  async function run(
    reviewAgent: unknown,
    batteries: unknown = undefined,
  ): Promise<{ lines: string[]; sent: Record<string, unknown> }> {
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      env: {},
      cleanup: vi.fn(async () => {}),
      batteries,
    });
    const c = ctx();
    // A real review dispatch always carries prKey + supersedePolicy, which
    // is what puts the run in the review lane.
    const reviewInput = {
      ...INPUT,
      prNumber: 7,
      prKey: "org-1/o/r/7",
      supersedePolicy: "newest-wins",
    };
    await expect(
      runFn(
        reviewAgent === undefined
          ? reviewInput
          : { ...reviewInput, reviewAgent },
        c,
      ),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(sendMessageCalls).toHaveLength(1);
    return {
      lines: c.log.mock.calls.map((call) => String(call[0])),
      sent: sendMessageCalls[0] as Record<string, unknown>,
    };
  }

  const batteriesLines = (lines: string[]) =>
    lines.filter((l) => /\] batteries: /.test(l));

  it("orchestrated: the daemon message carries exactly {mode, commandTimeoutMs, maxTurns}", async () => {
    const { lines, sent } = await run(ORCHESTRATED, SEEDED);
    expect(sent.reviewAgent).toEqual({
      mode: "orchestrated",
      commandTimeoutMs: 240000,
      maxTurns: 30,
    });
    expect(JSON.stringify(sent)).not.toMatch(/runTests|batteries/);
    const [arg] = materialiseAgentCredentials.mock.calls[0]! as [
      { seed: unknown },
    ];
    expect(arg.seed).toEqual({
      batteries: ORCHESTRATED.batteries,
      hooksOff: true,
    });
    const bl = batteriesLines(lines);
    expect(bl).toHaveLength(1);
    expect(bl[0]).toContain(
      "batteries: mode=orchestrated packs=gstack-review manifest=abcdef012345",
    );
    expect(lines.some((l) => l.includes("foreground-only"))).toBe(false);
    expect(
      lines.some((l) =>
        l.includes(
          "review agent: orchestrated → daemon (bashTimeoutMs=240000, maxTurns=30)",
        ),
      ),
    ).toBe(true);
  });

  it.each([
    ["classic", CLASSIC],
    ["absent", undefined],
  ])(
    "%s: the daemon message has no reviewAgent key and one classic batteries line",
    async (_label, reviewAgent) => {
      const { lines, sent } = await run(reviewAgent);
      expect("reviewAgent" in sent).toBe(false);
      // Exactly today's keys: the pulled message + the worker's useCredits.
      expect(Object.keys(sent).sort()).toEqual(
        [...Object.keys(REVIEW_MESSAGE), "useCredits"].sort(),
      );
      const bl = batteriesLines(lines);
      expect(bl).toHaveLength(1);
      expect(bl[0]).toMatch(/\] batteries: mode=classic$/);
      expect(lines.some((l) => l.includes("review agent:"))).toBe(false);
      expect(lines.some((l) => l.includes("foreground-only"))).toBe(false);
    },
  );

  it("out-of-bounds orchestrated: bounds-rejected BEFORE seeding, so it seeds, logs and runs classic", async () => {
    const { lines, sent } = await run({ ...ORCHESTRATED, commandTimeoutMs: 5 });
    expect("reviewAgent" in sent).toBe(false);
    const [arg] = materialiseAgentCredentials.mock.calls[0]! as [
      { seed: unknown },
    ];
    expect(arg.seed).toBeUndefined();
    const rejected = lines.filter((l) => l.includes("bounds-rejected"));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("commandTimeoutMs");
    expect(rejected[0]).toContain("→ classic");
    const bl = batteriesLines(lines);
    expect(bl).toHaveLength(1);
    expect(bl[0]).toMatch(/\] batteries: mode=classic$/);
    // The bounds check runs before materialise (seeding), not at send time.
    const rejectIdx = lines.findIndex((l) => l.includes("bounds-rejected"));
    const credIdx = lines.findIndex((l) => l.includes("agent credential:"));
    expect(rejectIdx).toBeLessThan(credIdx);
  });

  it("orchestrated on a non-review pulled message: no wire is stamped", async () => {
    pullNextMessage.mockResolvedValue({
      ...REVIEW_MESSAGE,
      permissionMode: "allowAll",
    });
    const { sent } = await run(ORCHESTRATED, SEEDED);
    expect("reviewAgent" in sent).toBe(false);
  });
});

describe("task agent packs + one batteries line per run (phase 7)", () => {
  const TASK_MESSAGE = {
    type: "claude",
    model: "sonnet",
    agent: "claudeCode",
    agentVersion: 1,
    prompt: "audit",
    sessionId: null,
    permissionMode: "allowAll",
    featureFlags: {},
  };
  const SEEDED = {
    ok: true as const,
    packs: ["somnio-skills"],
    manifestHash: "0123456789ab".padEnd(64, "f"),
  };

  beforeEach(() => {
    process.env.WORKER_BOX_TRUST = "shared";
    process.env.WORKER_CREDENTIAL_BROKER = "legacy-direct";
    pullNextMessage.mockReset().mockResolvedValue({ ...TASK_MESSAGE });
    pollUntilTerminal.mockReset().mockResolvedValue({
      outcome: "completed",
      finalStatus: "complete",
    });
  });

  async function run(
    extra: Record<string, unknown>,
    batteries: unknown = undefined,
  ): Promise<{
    lines: string[];
    sent: Record<string, unknown>;
    arg: { seed?: unknown; foregroundOnly?: boolean };
  }> {
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      env: {},
      cleanup: vi.fn(async () => {}),
      batteries,
    });
    const c = ctx();
    await expect(runFn({ ...INPUT, ...extra }, c)).resolves.toMatchObject({
      outcome: "completed",
    });
    expect(sendMessageCalls).toHaveLength(1);
    const [arg] = materialiseAgentCredentials.mock.calls[0]! as [
      { seed?: unknown; foregroundOnly?: boolean },
    ];
    return {
      lines: c.log.mock.calls.map((call) => String(call[0])),
      sent: sendMessageCalls[0] as Record<string, unknown>,
      arg,
    };
  }

  const batteriesLines = (lines: string[]) =>
    lines.filter((l) => /\] batteries: /.test(l));
  const foregroundLines = (lines: string[]) =>
    lines.filter((l) => l.includes("foreground-only"));

  it("task lane with packs: materialise gets the hooks-on task seed, one lane=task line after the credential line", async () => {
    const { lines, sent, arg } = await run(
      { taskAgent: { batteries: ["somnio-skills"] } },
      SEEDED,
    );
    expect(arg.seed).toEqual({
      batteries: ["somnio-skills"],
      hooksOff: false,
    });
    expect(arg.foregroundOnly).toBe(true);
    const bl = batteriesLines(lines);
    expect(bl).toHaveLength(1);
    expect(bl[0]).toMatch(
      /\] batteries: lane=task packs=somnio-skills manifest=0123456789ab$/,
    );
    const credIdx = lines.findIndex((l) => l.includes("agent credential:"));
    expect(lines.indexOf(bl[0]!)).toBeGreaterThan(credIdx);
    const fg = foregroundLines(lines);
    expect(fg).toHaveLength(1);
    expect(fg[0]).toMatch(/\] task agent: foreground-only hook installed$/);
    expect(lines.indexOf(fg[0]!)).toBe(lines.indexOf(bl[0]!) + 1);
    // No wire change: the daemon never sees the task packs.
    expect(JSON.stringify(sent)).not.toMatch(/taskAgent|batteries/);
    expect(Object.keys(sent).sort()).toEqual(
      [...Object.keys(TASK_MESSAGE), "useCredits"].sort(),
    );
  });

  it("task lane with an unavailable seed: unavailable lane=task reason=<r>", async () => {
    const { lines } = await run(
      { taskAgent: { batteries: ["somnio-skills"] } },
      { ok: false, reason: "manifest-drift" },
    );
    const bl = batteriesLines(lines);
    expect(bl).toHaveLength(1);
    expect(bl[0]).toMatch(
      /\] batteries: unavailable lane=task reason=manifest-drift$/,
    );
    expect(foregroundLines(lines)).toHaveLength(1);
  });

  it("a mention on a PR (prNumber only): lane=pr", async () => {
    const { lines, arg } = await run(
      { prNumber: 7, taskAgent: { batteries: ["somnio-skills"] } },
      SEEDED,
    );
    expect(arg.seed).toEqual({
      batteries: ["somnio-skills"],
      hooksOff: false,
    });
    expect(arg.foregroundOnly).toBe(true);
    const bl = batteriesLines(lines);
    expect(bl).toHaveLength(1);
    expect(bl[0]).toMatch(/\] batteries: lane=pr packs=somnio-skills /);
  });

  it("a malformed taskAgent: rejected line (reason only), nothing seeded, task-agent-invalid", async () => {
    const { lines, arg } = await run({
      taskAgent: { batteries: ["Bad Id"] },
    });
    expect(arg.seed).toBeUndefined();
    const rejected = lines.filter((l) => l.includes("task agent: rejected"));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("batteries[0]");
    expect(lines.join("\n")).not.toContain("Bad Id");
    // Still a headless task run: the guard does not depend on packs.
    expect(arg.foregroundOnly).toBe(true);
    expect(foregroundLines(lines)).toHaveLength(1);
    const bl = batteriesLines(lines);
    expect(bl).toHaveLength(1);
    expect(bl[0]).toMatch(
      /\] batteries: unavailable lane=task reason=task-agent-invalid$/,
    );
  });

  it("a review-lane run carrying taskAgent: ignored, nothing seeded, today's review line", async () => {
    const { lines, arg } = await run({
      prNumber: 7,
      prKey: "org-1/o/r/7",
      supersedePolicy: "newest-wins",
      taskAgent: { batteries: ["somnio-skills"] },
    });
    expect(arg.seed).toBeUndefined();
    expect(arg.foregroundOnly).toBe(false);
    expect(
      lines.filter((l) => l.includes("task agent: ignored (review-lane)")),
    ).toHaveLength(1);
    expect(foregroundLines(lines)).toEqual([]);
    const bl = batteriesLines(lines);
    expect(bl).toHaveLength(1);
    expect(bl[0]).toMatch(/\] batteries: mode=classic$/);
  });

  it("no taskAgent: today's classic line, the foreground-only guard, today's message keys", async () => {
    const { lines, sent, arg } = await run({});
    expect(arg.seed).toBeUndefined();
    expect(arg.foregroundOnly).toBe(true);
    expect(lines.filter((l) => l.includes("task agent:"))).toEqual([
      expect.stringMatching(/\] task agent: foreground-only hook installed$/),
    ]);
    const bl = batteriesLines(lines);
    expect(bl).toHaveLength(1);
    expect(bl[0]).toMatch(/\] batteries: mode=classic$/);
    expect(Object.keys(sent).sort()).toEqual(
      [...Object.keys(TASK_MESSAGE), "useCredits"].sort(),
    );
  });
});

describe("read-only task token wiring (phase 7, brokered run-fn)", () => {
  const TASK_MESSAGE = {
    type: "claude",
    model: "sonnet",
    agent: "claudeCode",
    agentVersion: 1,
    prompt: "audit",
    sessionId: null,
    permissionMode: "allowAll",
    featureFlags: {},
  };
  const READ = "ghs_fake_read_token_value";
  const SEEDED_REQUIRING = {
    ok: true as const,
    packs: ["somnio-skills"],
    manifestHash: "0123456789ab".padEnd(64, "f"),
    requires: ["github-read-token"],
  };
  const future = () => new Date(Date.now() + 30 * 60_000).toISOString();

  beforeEach(() => {
    process.env.WORKER_BOX_TRUST = "shared";
    pullNextMessage.mockReset().mockResolvedValue({ ...TASK_MESSAGE });
    pollUntilTerminal.mockReset().mockResolvedValue({
      outcome: "completed",
      finalStatus: "complete",
    });
  });

  async function run(
    extra: Record<string, unknown>,
    batteries: unknown,
  ): Promise<{ lines: string[]; options: unknown }> {
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      env: {},
      cleanup: vi.fn(async () => {}),
      batteries,
    });
    const c = ctx();
    await expect(runFn({ ...INPUT, ...extra }, c)).resolves.toMatchObject({
      outcome: "completed",
    });
    const lines = c.log.mock.calls.map((call) => String(call[0]));
    // Never logged, whatever happened.
    expect(lines.join("\n")).not.toContain(READ);
    return { lines, options: daemonCtorArgs[0]![6] };
  }

  const tokenLines = (lines: string[]) =>
    lines.filter((l) => l.includes("read-token"));
  /** The one fixed-format line, or nothing. */
  const tokenLine = (lines: string[]) => {
    const found = tokenLines(lines);
    expect(found.length).toBeLessThanOrEqual(1);
    return found[0]?.replace(/^.*\] /, "");
  };

  it("task lane + requiring seed + token + future expiry ⇒ DaemonProcess gets the token; one applied line after the brokers", async () => {
    const { lines, options } = await run(
      {
        taskAgent: { batteries: ["somnio-skills"] },
        githubReadToken: READ,
        githubReadTokenExpiresAt: future(),
      },
      SEEDED_REQUIRING,
    );
    expect(options).toEqual({ lane: "task", githubReadToken: READ });
    expect(tokenLine(lines)).toBe("task agent: read-token=applied");
    const brokersIdx = lines.findIndex((l) =>
      l.includes("credential brokers up"),
    );
    expect(brokersIdx).toBeGreaterThan(-1);
    expect(lines.indexOf(tokenLines(lines)[0]!)).toBeGreaterThan(brokersIdx);
  });

  it.each<[string, Record<string, unknown>, unknown, string]>([
    [
      "expired",
      {
        githubReadToken: READ,
        githubReadTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      },
      SEEDED_REQUIRING,
      "expired",
    ],
    ["requiring pack but no token", {}, SEEDED_REQUIRING, "not-delivered"],
    [
      "non-requiring pack + token",
      { githubReadToken: READ, githubReadTokenExpiresAt: future() },
      { ok: true, packs: ["somnio-review"], manifestHash: "0".repeat(64) },
      "no-requiring-pack",
    ],
    [
      "seeding unavailable",
      { githubReadToken: READ, githubReadTokenExpiresAt: future() },
      { ok: false, reason: "manifest-drift" },
      "no-requiring-pack",
    ],
  ])(
    "%s ⇒ no token passed; one skip line",
    async (_name, extra, seeded, reason) => {
      const { lines, options } = await run(
        { taskAgent: { batteries: ["somnio-skills"] }, ...extra },
        seeded,
      );
      expect(options).toEqual({ lane: "task" });
      expect(tokenLine(lines)).toBe(`task agent: read-token=skip=${reason}`);
    },
  );

  it("legacy-direct (no broker) ⇒ no token passed; skip=no-broker", async () => {
    process.env.WORKER_CREDENTIAL_BROKER = "legacy-direct";
    const { lines, options } = await run(
      {
        taskAgent: { batteries: ["somnio-skills"] },
        githubReadToken: READ,
        githubReadTokenExpiresAt: future(),
      },
      SEEDED_REQUIRING,
    );
    expect(options).toEqual({ lane: "task" });
    expect(tokenLine(lines)).toBe("task agent: read-token=skip=no-broker");
  });

  it("REVIEW lane with a forged token ⇒ not passed, no line", async () => {
    pullNextMessage.mockResolvedValue({
      ...TASK_MESSAGE,
      permissionMode: "review",
    });
    const { lines, options } = await run(
      {
        prNumber: 7,
        prKey: "org-1/o/r/7",
        supersedePolicy: "newest-wins",
        taskAgent: { batteries: ["somnio-skills"] },
        githubReadToken: READ,
        githubReadTokenExpiresAt: future(),
      },
      SEEDED_REQUIRING,
    );
    expect(options).toEqual({ lane: "review" });
    expect(tokenLines(lines)).toEqual([]);
  });

  it("no taskAgent (an unconfigured repo), even with a forged token ⇒ not passed, no line", async () => {
    const { lines, options } = await run(
      { githubReadToken: READ, githubReadTokenExpiresAt: future() },
      undefined,
    );
    expect(options).toEqual({ lane: "task" });
    expect(tokenLines(lines)).toEqual([]);
  });
});

describe("GATE-01: the fix check runs after the agent is dead, then reports (09-10)", () => {
  const FIX_RUN = {
    ...INPUT,
    branch: "main",
    selfHeal: {
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
    },
  };
  const fixCtx = () => ({
    abortController: new AbortController(),
    cancelled: false,
    log: vi.fn(),
    workflowRunId: () => "run-ext-fix",
  });

  beforeEach(() => {
    process.env.WORKER_BOX_TRUST = "shared";
    finallyOrder.length = 0;
    releaseMock.mockClear();
    provisionWorkdir.mockReset().mockResolvedValue(RUN);
    cleanupWorkdir.mockReset().mockResolvedValue(undefined);
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      cleanup: vi.fn(async () => {}),
    });
    startGitBroker.mockResolvedValue({
      url: "http://127.0.0.1:41999",
      port: 41999,
      lastPushedSha: () => {
        finallyOrder.push("lastPushedSha");
        return FIX_PUSHED;
      },
      close: vi.fn(async () => {
        finallyOrder.push("git-close");
      }),
    });
    startGhBroker.mockResolvedValue({
      socketPath: "/tmp/automata-agent-run/w-test/thr_leak_1-gh.sock",
      close: vi.fn(async () => {
        finallyOrder.push("gh-close");
      }),
    });
    pinFixBaseSha.mockClear();
    remoteBranchHead.mockClear();
    runFixCheck.mockClear();
    postSelfHealFixCheck.mockClear();
    pullNextMessage.mockReset();
    pollUntilTerminal.mockReset();
  });

  it("#205: a throw between the clone and the credential pull (pinFixBaseSha) still removes the workdir and releases the slot — nothing is held for the life of the worker", async () => {
    pinFixBaseSha.mockRejectedValueOnce(new Error("git exploded"));
    releaseMock.mockClear();
    cleanupWorkdir.mockClear();
    await expect(runFn(FIX_RUN, fixCtx())).rejects.toThrow("git exploded");
    expect(cleanupWorkdir).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    // and the cleanup came BEFORE the release (I2)
    expect(cleanupWorkdir.mock.invocationCallOrder[0]).toBeLessThan(
      releaseMock.mock.invocationCallOrder[0]!,
    );
  });

  it("completed: teardown → reap → lastPushedSha → git close → gh close → check → report; then the finally sequence, lock last", async () => {
    pullNextMessage.mockResolvedValue({ agent: "claudeCode", model: "m" });
    pollUntilTerminal.mockResolvedValue({
      outcome: "completed",
      finalStatus: "complete",
    });
    const c = fixCtx();
    await expect(runFn(FIX_RUN, c)).resolves.toMatchObject({
      outcome: "completed",
    });
    expect(finallyOrder.filter((x) => x !== "uid-reap:admission")).toEqual([
      "teardown",
      "uid-reap:teardown",
      "lastPushedSha",
      "git-close",
      "gh-close",
      "runFixCheck",
      "postSelfHealFixCheck",
      // the finally block: second teardown/reap/closes are no-ops
      "teardown",
      "uid-reap:teardown",
      "git-close",
      "gh-close",
      "cleanupWorkdir",
      "release",
    ]);
    expect(pinFixBaseSha).toHaveBeenCalledWith({
      workdir: RUN.repo,
      baseBranch: "main",
    });
    const checkArgs = runFixCheck.mock.calls[0]![0] as Record<string, unknown>;
    expect(checkArgs.pushedSha).toBe(FIX_PUSHED);
    expect(checkArgs.baseSha).toBe(FIX_BASE);
    expect(checkArgs.workdir).toBe(RUN.repo);
    expect(postSelfHealFixCheck).toHaveBeenCalledTimes(1);
    expect(postSelfHealFixCheck.mock.calls[0]![0]).toMatchObject({
      gateToken: "GATE_TOKEN_SENTINEL",
      attemptId: FIX_RUN.selfHeal.attemptId,
      report: { workerStatus: "completed", checkOutcome: "pass" },
    });
    const lines = c.log.mock.calls.map((call) => String(call[0]));
    const checkLines = lines.filter((l) =>
      l.includes("self-heal fix-check: status="),
    );
    expect(checkLines).toHaveLength(1);
    expect(checkLines[0]).toMatch(
      /self-heal fix-check: status=completed check=pass denied=0 head=aaaaaaaa ms=\d+ report=recorded$/,
    );
    expect(lines.some((l) => l.includes("run start: lane=self-heal-fix"))).toBe(
      true,
    );
    expect(lines.join("\n")).not.toContain("GATE_TOKEN_SENTINEL");
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it.each(["cancelled", "stopped"] as const)(
    "%s: no check; exactly one report with workerStatus aborted",
    async (outcome) => {
      pullNextMessage.mockResolvedValue({ agent: "claudeCode", model: "m" });
      pollUntilTerminal.mockResolvedValue({ outcome });
      await runFn(FIX_RUN, fixCtx());
      expect(runFixCheck).not.toHaveBeenCalled();
      expect(postSelfHealFixCheck).toHaveBeenCalledTimes(1);
      expect(postSelfHealFixCheck.mock.calls[0]![0]).toMatchObject({
        report: {
          workerStatus: "aborted",
          headSha: null,
          checkOutcome: null,
          deniedPaths: [],
        },
      });
      expect(finallyOrder.at(-1)).toBe("release");
    },
  );

  it("R4: nothing to run (a 204, e.g. a duplicate dispatch): no check and NO report — the real run's report wins the single-use CAS", async () => {
    pullNextMessage.mockResolvedValue(null);
    const c = fixCtx();
    await expect(runFn(FIX_RUN, c)).resolves.toMatchObject({
      outcome: "nothing-to-run",
    });
    expect(runFixCheck).not.toHaveBeenCalled();
    expect(postSelfHealFixCheck).not.toHaveBeenCalled();
    const lines = c.log.mock.calls.map((call) => String(call[0]));
    expect(
      lines.some((l) =>
        l.includes("self-heal fix-check: not reported (nothing to run)"),
      ),
    ).toBe(true);
    expect(finallyOrder.at(-1)).toBe("release");
  });

  it("a fix run that throws mid-run still reports aborted once, and the throw propagates", async () => {
    pullNextMessage.mockResolvedValue({ agent: "claudeCode", model: "m" });
    pollUntilTerminal.mockRejectedValue(new Error("poll blew up"));
    await expect(runFn(FIX_RUN, fixCtx())).rejects.toThrow("poll blew up");
    expect(runFixCheck).not.toHaveBeenCalled();
    expect(postSelfHealFixCheck).toHaveBeenCalledTimes(1);
  });

  it("a non-fix run never checks or reports", async () => {
    pullNextMessage.mockResolvedValue({ agent: "claudeCode", model: "m" });
    pollUntilTerminal.mockResolvedValue({
      outcome: "completed",
      finalStatus: "complete",
    });
    await runFn(INPUT, fixCtx());
    expect(pinFixBaseSha).not.toHaveBeenCalled();
    expect(runFixCheck).not.toHaveBeenCalled();
    expect(postSelfHealFixCheck).not.toHaveBeenCalled();
  });
});

/**
 * #205 (AC5 at the workflow level): once a slot is held, EVERYTHING per run —
 * the clone grant, the daemon, the admission and teardown reaps, the cleanup —
 * runs as that slot's own account, so a kill issued by this run reaches only
 * this slot's uid.
 */
describe("#205: a run on slot 1 executes as the slot-1 account end to end", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.WORKER_BOX_TRUST = "shared";
    process.env.WORKER_CREDENTIAL_BROKER = "legacy-direct";
    process.env.WORKER_AGENT_USER = "_automata-agent";
    process.env.WORKER_WORKDIR_ROOT = "/usr/local/automata/runs";
    process.env.WORKER_BOX_SLOTS = "2";
    process.env.WORKER_RUN_MEMORY_MAX = "1500M";
    admissionOrder.length = 0;
    daemonCtorArgs.length = 0;
    ensureSlotNamespace.mockClear();
    reapAgentUidEscapees.mockClear();
    cleanupWorkdir.mockClear();
    acquireBoxSlotMock.mockImplementationOnce(async () => {
      admissionOrder.push("lock");
      return { release: releaseMock, lost: false, slot: 1 };
    });
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      env: {},
      cleanup: vi.fn(async () => {}),
    });
    // agent-uid mode starts the egress proxy (observe mode) on every run.
    startEgressProxy.mockResolvedValue({
      url: "http://127.0.0.1:41998",
      port: 41998,
      unauthenticatedRequests: () => 0,
      close: vi.fn(async () => {}),
    });
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  });

  it("grants the slot subdir, clones, spawns, reaps and cleans up as `_automata-agent-1`, never as the base account", async () => {
    await runFn(INPUT, { cancelled: false, log: vi.fn() });
    // ensure-ns (all accounts) → Stage A → lock → slot grant → clone → uid-reap → daemon.
    expect(admissionOrder.slice(3, 7)).toEqual([
      "lock",
      "slot-ns",
      "clone",
      "uid-reap:admission",
    ]);
    expect(ensureSlotNamespace).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 1, agentUser: "_automata-agent-1" }),
    );
    expect(ensureRunNamespace).toHaveBeenCalledWith(
      expect.objectContaining({
        agentUsers: ["_automata-agent", "_automata-agent-1"],
      }),
    );
    expect(provisionWorkdir).toHaveBeenCalledWith(
      expect.objectContaining({ agentUser: "_automata-agent-1" }),
    );
    // The cross-slot proxy fence: at N > 1 the run's proxy REQUIRES a per-run
    // credential (a sibling slot can reach the loopback port).
    const [proxyOpts] = startEgressProxy.mock.calls[0] as [
      { credential?: { user: string; secret: string } },
    ];
    expect(proxyOpts.credential).toEqual({
      user: "run",
      secret: expect.stringMatching(/^[0-9a-f]{48}$/),
    });
    const daemonConfig = daemonCtorArgs[0]?.[0] as {
      agentUser: string;
      boxSlot?: number;
      boxSlots: number;
    };
    expect(daemonConfig).toMatchObject({
      agentUser: "_automata-agent-1",
      boxSlot: 1,
      boxSlots: 2,
    });
    const reapUsers = reapAgentUidEscapees.mock.calls.map(
      (c) => (c[0] as { agentUser: string; phase: string }).agentUser,
    );
    expect(reapUsers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(reapUsers)).toEqual(new Set(["_automata-agent-1"]));
    expect(cleanupWorkdir).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentUser: "_automata-agent-1" }),
    );
  });
});

/**
 * #371: the memory-headroom check sits under the slot and before the clone. A
 * deferral gives the slot back, touches nothing on disk and reaches the engine
 * as the ONE plain (retryable) error; every post-admission failure reaches it
 * fenced as NonRetryableError, so the raised `retries` can never re-execute an
 * agent.
 */
describe("#371: headroom deferral and the non-retryable fence", () => {
  const STARVED = `MemTotal:        7937228 kB
MemAvailable:     200000 kB
SwapTotal:       8388604 kB
SwapFree:        8289020 kB
CommitLimit:    12357216 kB
Committed_AS:   12000000 kB
`;
  const ROOMY = STARVED.replace(
    "MemAvailable:     200000 kB",
    "MemAvailable:    6000000 kB",
  ).replace("Committed_AS:   12000000 kB", "Committed_AS:    2600000 kB");
  const POLICY = {
    floorBytes: 1024 ** 3,
    commitFraction: 0.9,
    runCommitBytes: 1300 * 1024 ** 2,
  };

  beforeEach(() => {
    process.env.WORKER_BOX_TRUST = "shared";
    releaseMock.mockClear();
    materialiseAgentCredentials.mockResolvedValue({
      delivered: false,
      env: {},
      cleanup: vi.fn(async () => {}),
    });
  });
  afterEach(async () => {
    const { _setAdmissionControllerForTests } = await import("./workflow");
    // Back to OFF for the rest of the file (see the top-level beforeAll).
    _setAdmissionControllerForTests(null);
    releaseMock.mockClear();
  });

  it("re-execution guard: an attempt above the recorded deferrals (an engine-retried timeout) is refused FIRST — final, nothing touched", async () => {
    const { _resetReexecutionGuardForTests } = await import(
      "./reexecution-guard"
    );
    _resetReexecutionGuardForTests(
      (await import("./config")).loadWorkerConfig().runNamespaceRoot,
    );
    const ctx = { cancelled: false, log: vi.fn(), retryCount: () => 1 };
    let caught: unknown;
    try {
      await runFn(INPUT, ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NonRetryableError);
    expect((caught as Error).message).toMatch(/never re-executes/);
    expect(ensureRunNamespace).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
    expect(provisionWorkdir).not.toHaveBeenCalled();
    expect(daemonCtorArgs).toHaveLength(0);
  });

  it("re-execution guard: the LAST allowed deferral records nothing (no retry comes back), so the ledger stays exact", async () => {
    const { _setAdmissionControllerForTests } = await import("./workflow");
    const { AdmissionController } = await import("./headroom");
    const {
      _resetReexecutionGuardForTests,
      deferralsRecorded,
      recordDeferral,
    } = await import("./reexecution-guard");
    _resetReexecutionGuardForTests(
      (await import("./config")).loadWorkerConfig().runNamespaceRoot,
    );
    _setAdmissionControllerForTests(
      new AdmissionController(POLICY, () => STARVED),
    );
    const { loadWorkerConfig } = await import("./config");
    const max = loadWorkerConfig().admissionMaxDeferrals;
    for (let i = 0; i < max; i++) recordDeferral("wfr-last");
    const ctx = {
      cancelled: false,
      log: vi.fn(),
      retryCount: () => max,
      workflowRunId: () => "wfr-last",
    };
    await expect(runFn(INPUT, ctx)).rejects.toSatisfy(
      (e: Error) => e.name === "AdmissionDeferredError",
    );
    expect(deferralsRecorded("wfr-last")).toBe(0);
  });

  it("re-execution guard: the ledger is keyed by the workflow run — a sibling run of the same thread starts clean, and a run keeps its own count across the retry", async () => {
    const { _setAdmissionControllerForTests } = await import("./workflow");
    const { AdmissionController } = await import("./headroom");
    const { _resetReexecutionGuardForTests, deferralsRecorded } = await import(
      "./reexecution-guard"
    );
    _resetReexecutionGuardForTests(
      (await import("./config")).loadWorkerConfig().runNamespaceRoot,
    );
    _setAdmissionControllerForTests(
      new AdmissionController(POLICY, () => STARVED),
    );
    const runA = {
      cancelled: false,
      log: vi.fn(),
      retryCount: () => 0,
      workflowRunId: () => "wfr-A",
    };
    await expect(runFn(INPUT, runA)).rejects.toSatisfy(
      (e: Error) => e.name === "AdmissionDeferredError",
    );
    expect(deferralsRecorded("wfr-A")).toBe(1);
    expect(deferralsRecorded("wfr-B")).toBe(0);
    // Sibling run B of the same thread at attempt 1 with no deferral of its
    // own: refused (that attempt came from an engine-side failure).
    const runB = {
      cancelled: false,
      log: vi.fn(),
      retryCount: () => 1,
      workflowRunId: () => "wfr-B",
    };
    await expect(runFn(INPUT, runB)).rejects.toBeInstanceOf(NonRetryableError);
    // A's own retry is still accounted for.
    expect(deferralsRecorded("wfr-A")).toBe(1);
  });

  it("re-execution guard: the retry of a recorded deferral is admitted (deferred once as attempt 0, admitted as attempt 1), and the ledger is dropped when the run ends", async () => {
    const { _setAdmissionControllerForTests } = await import("./workflow");
    const { AdmissionController } = await import("./headroom");
    const { _resetReexecutionGuardForTests, deferralsRecorded } = await import(
      "./reexecution-guard"
    );
    _resetReexecutionGuardForTests(
      (await import("./config")).loadWorkerConfig().runNamespaceRoot,
    );
    let meminfo = STARVED;
    _setAdmissionControllerForTests(
      new AdmissionController(POLICY, () => meminfo),
    );
    await expect(
      runFn(INPUT, { cancelled: false, log: vi.fn(), retryCount: () => 0 }),
    ).rejects.toSatisfy((e: Error) => e.name === "AdmissionDeferredError");
    expect(deferralsRecorded(INPUT.threadId)).toBe(1);
    meminfo = ROOMY;
    await runFn(INPUT, { cancelled: false, log: vi.fn(), retryCount: () => 1 });
    expect(provisionWorkdir).toHaveBeenCalledTimes(1);
    expect(deferralsRecorded(INPUT.threadId)).toBe(0);
  });

  it("a deferral releases the slot, clones nothing, and escapes as AdmissionDeferredError (plain, retryable)", async () => {
    const { _setAdmissionControllerForTests } = await import("./workflow");
    const { AdmissionController, AdmissionDeferredError } = await import(
      "./headroom"
    );
    _setAdmissionControllerForTests(
      new AdmissionController(POLICY, () => STARVED),
    );
    // Attempt 4 is legitimate only after three recorded deferrals.
    const { _resetReexecutionGuardForTests, recordDeferral } = await import(
      "./reexecution-guard"
    );
    _resetReexecutionGuardForTests(
      (await import("./config")).loadWorkerConfig().runNamespaceRoot,
    );
    for (let i = 0; i < 3; i++) recordDeferral(INPUT.threadId);
    const ctx = { cancelled: false, log: vi.fn(), retryCount: () => 3 };
    let caught: unknown;
    try {
      await runFn(INPUT, ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AdmissionDeferredError);
    expect(caught).not.toBeInstanceOf(NonRetryableError);
    expect((caught as Error).message).toMatch(/attempt 4,/);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    // AC 3: nothing else was touched — no clone, no credential, no daemon.
    expect(provisionWorkdir).not.toHaveBeenCalled();
    expect(cleanupWorkdir).not.toHaveBeenCalled();
    expect(pullAgentCredentials).not.toHaveBeenCalled();
    expect(materialiseAgentCredentials).not.toHaveBeenCalled();
    expect(daemonCtorArgs).toHaveLength(0);
    expect(
      ctx.log.mock.calls.some((c) =>
        String(c[0]).includes("box.headroom_rejected"),
      ),
    ).toBe(true);
  });

  it("with headroom the run is admitted (headroom_ok logged) and proceeds to the clone; the reservation lives until the finally", async () => {
    const { _setAdmissionControllerForTests } = await import("./workflow");
    const { AdmissionController } = await import("./headroom");
    const controller = new AdmissionController(POLICY, () => ROOMY);
    _setAdmissionControllerForTests(controller);
    const ctx = { cancelled: false, log: vi.fn() };
    await runFn(INPUT, ctx);
    expect(provisionWorkdir).toHaveBeenCalledTimes(1);
    expect(
      ctx.log.mock.calls.some((c) => String(c[0]).includes("box.headroom_ok")),
    ).toBe(true);
    // Released in the finally, not before.
    expect(controller.reservedBytes()).toBe(0);
  });

  it("once the daemon is up the reservation shrinks by the run cgroup's anonymous memory and is whole again when the probe reads nothing; teardown frees it", async () => {
    const { _setAdmissionControllerForTests } = await import("./workflow");
    const { AdmissionController } = await import("./headroom");
    const controller = new AdmissionController(POLICY, () => ROOMY);
    _setAdmissionControllerForTests(controller);
    fakeRunCgroupDir =
      "/sys/fs/cgroup/system.slice/automata-worker.service/run-x";
    const anon = 300 * 1024 ** 2;
    readMemoryAnon.mockImplementation(() => anon);
    const seen: Array<number | null> = [];
    pollUntilTerminal.mockReset().mockImplementation(async () => {
      // Mid-run: the daemon started, the probe is attached.
      seen.push(controller.reservedBytes());
      readMemoryAnon.mockImplementation(() => null);
      seen.push(controller.reservedBytes());
      return { outcome: "completed", finalStatus: "complete" };
    });
    try {
      await runFn(INPUT, { cancelled: false, log: vi.fn() });
      expect(readMemoryAnon).toHaveBeenCalledWith({
        cgroupDir: "/sys/fs/cgroup/system.slice/automata-worker.service/run-x",
      });
      expect(seen).toEqual([
        POLICY.runCommitBytes - anon,
        POLICY.runCommitBytes,
      ]);
      expect(controller.reservedBytes()).toBe(0);
    } finally {
      fakeRunCgroupDir = null;
      readMemoryAnon.mockReset().mockImplementation(() => null);
    }
  });

  it("a plain post-admission failure reaches the engine as NonRetryableError with its message intact", async () => {
    provisionWorkdir.mockRejectedValueOnce(
      new Error("clone failed: ECONNRESET"),
    );
    const ctx = { cancelled: false, log: vi.fn() };
    let caught: unknown;
    try {
      await runFn(INPUT, ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NonRetryableError);
    expect((caught as Error).message).toMatch(/clone failed: ECONNRESET/);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});
