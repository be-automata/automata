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
 * #125 C1 abort handling: when the engine cancels a run under a NATIVE
 * supersede policy, the run task posts exactly ONE explicit `superseded`
 * terminal to www — after teardown (egress flushed, workdir cleaned) — for
 * both an in-flight cancel and a pre-daemon (provision-phase) cancel. Legacy
 * runs (no policy on the input) and `app-side` post nothing.
 *
 * Same module-mock harness as workflow-cleanup.test.ts (own file: it mocks
 * ./www-client, which workflow.test.ts exercises for real).
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

const WORKDIR = "/tmp/automata-worker-runs/thr_abort_1";

const provisionWorkdir = vi.fn(async (..._args: unknown[]) => WORKDIR);
const cleanupWorkdir = vi.fn(async (..._args: unknown[]) => {});
const pullAgentCredentials = vi.fn();
const materialiseAgentCredentials = vi.fn();
const pullNextMessage = vi.fn();
const pollUntilTerminal = vi.fn();
const postRunSuperseded = vi.fn(async (..._args: unknown[]) => "applied");
const postEgressEvents = vi.fn(async (..._args: unknown[]) => {});
const startEgressProxy = vi.fn();
const startGitBroker = vi.fn();
const startGhBroker = vi.fn();
const teardown = vi.fn();

vi.mock("./provision", () => ({
  provisionWorkdir: (...args: unknown[]) => provisionWorkdir(...args),
  cleanupWorkdir: (...args: unknown[]) => cleanupWorkdir(...args),
}));
vi.mock("./www-client", () => ({
  pullAgentCredentials: (...args: unknown[]) => pullAgentCredentials(...args),
  pullNextMessage: (...args: unknown[]) => pullNextMessage(...args),
  pollUntilTerminal: (...args: unknown[]) => pollUntilTerminal(...args),
  postRunFailed: vi.fn(),
  postRunSuperseded: (...args: unknown[]) => postRunSuperseded(...args),
  postEgressEvents: (...args: unknown[]) => postEgressEvents(...args),
}));
vi.mock("./egress-proxy", () => ({
  startEgressProxy: (...args: unknown[]) => startEgressProxy(...args),
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
    preflightGhAuth = vi.fn();
    start = vi.fn();
    sendMessage = vi.fn(async () => 42);
    pid = 1234;
    teardown = teardown;
  },
}));

const BASE_INPUT = {
  threadId: "thr_abort_1",
  threadChatId: "tc_1",
  repoFullName: "o/r",
  branch: "main",
  daemonCallbackUrl: "https://www.example.com",
  installationToken: "inst-secret",
  daemonToken: "daemon-tok",
  orgId: "org-1",
  prKey: "org-1/o/r/7",
  deliveryId: "gh-1",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runFn: any;

beforeAll(async () => {
  const mod = await import("./workflow");
  // The fn is shared by every variant; take it from the discard variant.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (mod.agentRunWorkflows as any[]).find(
    (w) => w.definition.name === "agent-run-discard",
  ).definition;
  runFn = def._tasks[0].fn;
});

function makeCtx(runId = "run-ext-1") {
  const abortController = new AbortController();
  const ctx = {
    abortController,
    cancelled: false,
    log: vi.fn(),
    workflowRunId: () => runId,
  };
  return { ctx, abort: () => abortController.abort() };
}

beforeEach(() => {
  process.env.WORKER_BOX_TRUST = "shared";
  process.env.WORKER_CREDENTIAL_BROKER = "legacy-direct";
  provisionWorkdir.mockClear();
  cleanupWorkdir.mockClear();
  postRunSuperseded.mockClear();
  teardown.mockClear();
  pullAgentCredentials.mockReset();
  materialiseAgentCredentials.mockReset();
  materialiseAgentCredentials.mockResolvedValue({
    delivered: false,
    cleanup: vi.fn(async () => {}),
  });
  pullNextMessage.mockReset();
  pollUntilTerminal.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("abort → explicit superseded terminal (#125 C1)", () => {
  it("in-flight cancel: exactly ONE superseded terminal, posted AFTER teardown + workdir cleanup (AC3)", async () => {
    const { ctx, abort } = makeCtx("run-ext-inflight");
    pullNextMessage.mockResolvedValue({ agent: "claudeCode", model: "m" });
    // The poll observes the cancel and returns promptly with outcome cancelled.
    pollUntilTerminal.mockImplementation(async () => {
      abort();
      ctx.cancelled = true;
      return { outcome: "cancelled" };
    });
    const order: string[] = [];
    teardown.mockImplementation(() => order.push("teardown"));
    cleanupWorkdir.mockImplementation(async () => {
      order.push("cleanup");
    });
    postRunSuperseded.mockImplementation(async () => {
      order.push("post");
      return "applied";
    });

    const out = await runFn(
      { ...BASE_INPUT, supersedePolicy: "complete-run-discard" },
      ctx,
    );
    expect(out.outcome).toBe("cancelled");
    expect(postRunSuperseded).toHaveBeenCalledTimes(1);
    const [opts, args] = postRunSuperseded.mock.calls[0]!;
    expect(opts).toMatchObject({
      baseUrl: "https://www.example.com",
      daemonToken: "daemon-tok",
      threadId: "thr_abort_1",
      threadChatId: "tc_1",
    });
    expect(args).toEqual({
      runExternalId: "run-ext-inflight",
      policy: "complete-run-discard",
    });
    expect(order).toEqual(["teardown", "cleanup", "post"]);
  });

  it("pre-daemon cancel (during provision): terminal posted, workdir not orphaned (AC4)", async () => {
    const { ctx, abort } = makeCtx("run-ext-provision");
    provisionWorkdir.mockImplementation(async () => {
      abort();
      ctx.cancelled = true;
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    await expect(
      runFn({ ...BASE_INPUT, supersedePolicy: "newest-wins" }, ctx),
    ).rejects.toThrow("aborted");
    expect(postRunSuperseded).toHaveBeenCalledTimes(1);
    expect(postRunSuperseded.mock.calls[0]![1]).toEqual({
      runExternalId: "run-ext-provision",
      policy: "newest-wins",
    });
    // Provision threw before a workdir existed: nothing to clean, nothing orphaned.
    expect(cleanupWorkdir).not.toHaveBeenCalled();
  });

  it("cancel after clone but before the daemon (credential pull): workdir cleaned AND terminal posted", async () => {
    const { ctx, abort } = makeCtx("run-ext-cred");
    process.env.WORKER_BOX_TRUST = "owner";
    pullAgentCredentials.mockImplementation(async () => {
      abort();
      ctx.cancelled = true;
      throw new Error("aborted during pull");
    });
    await expect(
      runFn({ ...BASE_INPUT, supersedePolicy: "complete-run-queue" }, ctx),
    ).rejects.toThrow("aborted during pull");
    expect(cleanupWorkdir).toHaveBeenCalledWith(WORKDIR);
    expect(postRunSuperseded).toHaveBeenCalledTimes(1);
  });

  it("a NON-cancelled failure posts no superseded terminal (onFailure owns it)", async () => {
    const { ctx } = makeCtx();
    provisionWorkdir.mockRejectedValue(new Error("clone failed"));
    await expect(
      runFn({ ...BASE_INPUT, supersedePolicy: "newest-wins" }, ctx),
    ).rejects.toThrow("clone failed");
    expect(postRunSuperseded).not.toHaveBeenCalled();
  });

  it("legacy run (no policy) and app-side: cancel posts nothing (AC7 — control plane owns that terminal)", async () => {
    for (const extra of [{}, { supersedePolicy: "app-side" as const }]) {
      const { ctx, abort } = makeCtx();
      provisionWorkdir.mockImplementation(async () => {
        abort();
        ctx.cancelled = true;
        throw new Error("aborted");
      });
      await expect(runFn({ ...BASE_INPUT, ...extra }, ctx)).rejects.toThrow();
    }
    expect(postRunSuperseded).not.toHaveBeenCalled();
  });

  it("no workflowRunId available: logs and skips the post (C4 sweep is the backstop)", async () => {
    const abortController = new AbortController();
    const ctx = { abortController, cancelled: false, log: vi.fn() };
    provisionWorkdir.mockImplementation(async () => {
      abortController.abort();
      ctx.cancelled = true;
      throw new Error("aborted");
    });
    await expect(
      runFn({ ...BASE_INPUT, supersedePolicy: "newest-wins" }, ctx),
    ).rejects.toThrow();
    expect(postRunSuperseded).not.toHaveBeenCalled();
    expect(
      ctx.log.mock.calls.some((c) => String(c[0]).includes("no workflowRunId")),
    ).toBe(true);
  });
});
