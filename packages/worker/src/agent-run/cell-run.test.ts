import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  abnormalEndInfo,
  newAbnormalEndState,
  type AbnormalEnd,
} from "./abnormal-end";
import { BoundedRunMap } from "./run-end-marks";
import {
  buildCellMessage,
  createCellExecutor,
  CELL_SETUP_STAMP_MS,
  type CellExecutorDeps,
} from "./cell-run";
import { cellEntrypoint } from "./cell-image";
import {
  CELL_PG_BIN,
  CELL_TEST_DB_DIR,
  CELL_TEST_DB_MKDIR_ARGV,
  CELL_TEST_DB_PASSWORD_FILE,
  CELL_TEST_DB_READY_ARGV,
  CELL_TEST_DB_ROLE_SH,
  CELL_TEST_DB_START_SH,
  CELL_TEST_DB_STOP_SH,
  cellTestDbUrl,
} from "./cell-test-db";
import {
  CellPlanRefusedError,
  CellPlanUnavailableError,
} from "./cell-www-client";
import type { RunExecutorInput } from "./run-executor";
import {
  CellStepConflictError,
  NextMessageHttpError,
  ThreadStatusHttpError,
  type CellLease,
  type PollContext,
  type ThreadStatusPoll,
} from "./www-client";

const released: string[] = [];
vi.mock("./run-admission", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-admission")>()),
  admitRunSlot: async () => ({
    kind: "admitted" as const,
    boxLock: {
      release: async () => {
        released.push("slot");
      },
      lost: false,
      slot: 0,
    },
    config: {},
    reservation: {
      release: () => {
        released.push("reservation");
      },
    },
  }),
}));

const PROMPT = "PROMPT-CANARY-do-the-thing";
const VAULT = "VAULT-CANARY-credential";
const DAEMON = "daemon-token-canary";
const RUN_ID = "run-1";
const TEST_DB_PASSWORD = "0f".repeat(24);

function plan(attempt = 7, deployment = "www.example.org") {
  return {
    provider: "opensandbox",
    runtime: "runc",
    tags: {
      automata: "cell",
      worker: "w-1-abcd1234",
      epoch: "1",
      stepKey: "cell-k1",
      attempt: String(attempt),
      expiresAt: "1",
      deployment,
    },
    vault: [{ credential: VAULT }],
  };
}

const pulled = {
  type: "claude" as const,
  model: "m",
  agent: "claudeCode",
  agentVersion: 1,
  prompt: PROMPT,
  sessionId: null,
  permissionMode: "allowAll" as const,
  useCredits: true,
  featureFlags: {},
};

const flush = () => new Promise<void>((r) => setImmediate(r));

function setup(
  over: {
    attempt?: number;
    deployment?: string;
    pollIntervalMs?: number;
    fetchPlan?: CellExecutorDeps["www"]["fetchPlan"];
    create?: () => Promise<{ cellId: string }>;
    listByTags?: () => Promise<unknown>;
    nextMessage?: (signal?: AbortSignal) => Promise<typeof pulled | null>;
    pollThreadStatus?: () => Promise<ThreadStatusPoll>;
    pollUntilTerminal?: (ctx: PollContext) => Promise<unknown>;
    execExit?: (argv: string[]) => number;
    execStderr?: (argv: string[]) => string;
    execHang?: (argv: string[]) => boolean;
    /** Holds the clone exec until released (setup stays busy, the cell exists). */
    execGate?: Promise<void>;
    /** The box test-services file (#707); default a path that does not exist. */
    testServicesPath?: string;
  } = {},
) {
  released.length = 0;
  const calls: string[] = [];
  const execs: string[][] = [];
  const files: { path: string; text: string; opts: unknown }[] = [];
  const logs: string[] = [];
  const www = {
    revokeSignals: [] as boolean[],
    pollOpts: [] as unknown[],
    abnormalPosts: 0,
    abnormalEnds: [] as AbnormalEnd[],
    revokeResult: "ok" as "ok" | "unauthorized" | "failed",
    reportBodies: [] as unknown[],
  };
  let hbWaiters: (() => void)[] = [];
  let clock = 0;
  const marks = new BoundedRunMap(16);
  const provider = {
    create: vi.fn(async () => {
      calls.push("provider.create");
      return (await over.create?.()) ?? { cellId: "c1" };
    }),
    exec: vi.fn(async (_id: string, argv: string[]) => {
      calls.push("provider.exec");
      execs.push(argv);
      if (over.execHang?.(argv)) return new Promise<never>(() => {});
      if (over.execGate && argv[1] === "clone") await over.execGate;
      return {
        exitCode: over.execExit?.(argv) ?? 0,
        stdout: "",
        stderr: over.execStderr?.(argv) ?? "",
      };
    }),
    copyOut: vi.fn(async () => {
      throw new Error("absent");
    }),
    copyIn: vi.fn(
      async (_id: string, path: string, bytes: Uint8Array, opts: unknown) => {
        calls.push("provider.copyIn");
        files.push({ path, text: new TextDecoder().decode(bytes), opts });
      },
    ),
    revoke: vi.fn(async () => {
      calls.push("provider.revoke");
    }),
    quarantine: vi.fn(async () => {
      calls.push("provider.quarantine");
    }),
    delete: vi.fn(async () => {
      calls.push("provider.delete");
      return "deleted" as const;
    }),
    teardown: vi.fn(),
    listByTags: vi.fn(async (tags: Record<string, string>) => {
      calls.push(
        tags.attempt === undefined
          ? "provider.listPrior"
          : "provider.listByTags",
      );
      if (over.listByTags && tags.attempt === undefined) {
        return (await over.listByTags()) as never;
      }
      return [] as never;
    }),
  };
  const makeProvider = vi.fn((_cfg: unknown) => provider as never);
  const fetchPlan = vi.fn(
    over.fetchPlan ??
      (async () => ({
        ok: true as const,
        attempt: over.attempt ?? 7,
        plan: plan(over.attempt ?? 7, over.deployment) as never,
      })),
  );
  const deps: CellExecutorDeps = {
    www: {
      fetchPlan: (...a) => {
        calls.push("www.fetchPlan");
        return fetchPlan(...a);
      },
      revoke: async (_o, _a, signal) => {
        calls.push("www.revoke");
        www.revokeSignals.push(signal.aborted);
        return { result: www.revokeResult };
      },
      report: async (_o, _a, outcome) => {
        calls.push("www.report");
        www.reportBodies.push(outcome);
        return "ok";
      },
      nextMessage: async (_o, signal) => {
        calls.push("www.nextMessage");
        return over.nextMessage ? over.nextMessage(signal) : pulled;
      },
      pollThreadStatus: async () => {
        calls.push("www.heartbeat");
        return (
          (await over.pollThreadStatus?.()) ?? {
            kind: "status",
            status: "working",
            terminal: false,
            lease: "renewed",
          }
        );
      },
      pollUntilTerminal: async (ctx, opts) => {
        calls.push("www.poll");
        www.pollOpts.push(opts);
        return ((await over.pollUntilTerminal?.(ctx)) ?? {
          outcome: "completed",
          finalStatus: "complete",
        }) as never;
      },
      postEgress: async () => {
        calls.push("www.egress");
      },
      postAbnormal: async (_state, end) => {
        calls.push("www.abnormal");
        www.abnormalPosts += 1;
        www.abnormalEnds.push(end);
        return null;
      },
    },
    makeProvider,
    sleep: async (ms, signal) => {
      if (ms === CELL_SETUP_STAMP_MS) {
        await new Promise<void>((resolve) => {
          hbWaiters.push(resolve);
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }
      clock += ms;
    },
    now: () => clock,
    randomId: () => "rid0123456789abcdefghijkl",
    testDbPassword: () => TEST_DB_PASSWORD,
    boxTestServicesEnvPath:
      over.testServicesPath ?? "/nonexistent/agent-test-services.env",
    marks,
  };
  const abnormal = newAbnormalEndState({
    owns: true,
    runStartedAt: 0,
    runExecutionTimeoutMs: 30 * 60_000,
  });
  const ac = new AbortController();
  const ctx = {
    cancelled: false,
    log: (m: string) => logs.push(m),
    abortController: ac,
  };
  const args = {
    input: {
      threadId: "thr_1",
      threadChatId: "tc_1",
      repoFullName: "acme/widgets",
      branch: "main",
      daemonCallbackUrl: "https://www.example.org",
      cell: "opensandbox",
    },
    secrets: { installationToken: "x", daemonToken: DAEMON },
    revoker: { revokeOnce: async () => {} },
    ctx,
    config: {
      pollIntervalMs: over.pollIntervalMs ?? 7000,
      botLogin: "bot[bot]",
    },
    wwwOpts: {
      baseUrl: "https://www.example.org",
      daemonToken: DAEMON,
      threadId: "thr_1",
      threadChatId: "tc_1",
      runExternalId: RUN_ID,
    },
    runStartedAt: 0,
    runKey: "rk",
    abnormal,
    cellConfig: {
      kind: "on",
      baseUrl: "http://127.0.0.1:8090",
      apiKey: "k".repeat(32),
      image: {
        repository: "r",
        digest: `sha256:${"cd".repeat(32)}`,
        reference: `r@sha256:${"cd".repeat(32)}`,
      },
    },
  } as unknown as RunExecutorInput;
  const executor = createCellExecutor(deps);
  /** One heartbeat tick: wake the pending sleep and let the beat finish. */
  const tick = async () => {
    const w = hbWaiters;
    hbWaiters = [];
    w.forEach((r) => r());
    await flush();
    await flush();
  };
  return {
    executor,
    args,
    calls,
    execs,
    files,
    logs,
    www,
    provider,
    makeProvider,
    fetchPlan,
    marks,
    abnormal,
    ac,
    tick,
  };
}

const idx = (calls: string[], name: string, from = 0) =>
  calls.indexOf(name, from);

/** The teardown tail: www.revoke < provider steps < readback < report. */
function expectTeardownOrder(calls: string[]) {
  const r = idx(calls, "www.revoke");
  expect(r).toBeGreaterThan(-1);
  const v = idx(calls, "provider.revoke", r);
  const q = idx(calls, "provider.quarantine", v);
  const d = idx(calls, "provider.delete", q);
  const b = idx(calls, "provider.listByTags", d);
  const p = idx(calls, "www.report", b);
  expect(
    [r, v, q, d, b, p].every(
      (n, i, a) => n > -1 && (i === 0 || n > (a[i - 1] as number)),
    ),
  ).toBe(true);
  expect(calls[calls.length - 1]).toBe("www.report");
}

beforeEach(() => vi.restoreAllMocks());

describe("the cell run: success, plan, create", () => {
  // card: protects=a clean run goes plan, create, bootstrap, message, poll and then the ordered teardown with the server's attempt everywhere; fails_when=the attempt differs between poll, revoke and readback or the order moves; no_claim=a live cell (IT-E1)
  it("T-ORDER / T-ATTEMPT: a completed run, attempt 7 everywhere, teardown last", async () => {
    const s = setup();
    const out = await s.executor.run(s.args);
    expect(out).toMatchObject({
      outcome: "completed",
      finalStatus: "complete",
    });
    expect(s.calls.slice(0, 4)).toEqual([
      "www.fetchPlan",
      "provider.listPrior",
      "provider.create",
      "www.egress",
    ]);
    expectTeardownOrder(s.calls);
    expect((s.www.pollOpts[0] as { cellAttempt: number }).cellAttempt).toBe(7);
    expect(s.provider.listByTags).toHaveBeenLastCalledWith({
      automata: "cell",
      stepKey: "cell-k1",
      attempt: "7",
      deployment: "www.example.org",
    });
    expect(s.www.reportBodies).toEqual([{ outcome: "clean" }]);
    expect(released).toEqual(["reservation", "slot"]);
    expect(s.www.abnormalPosts).toBe(0);
  });

  // card: protects=every route refusal fails the step with its code and touches nothing (no provider, no create, no teardown); fails_when=a provider is built or a teardown call is sent; no_claim=the code list (cell-www-client.test.ts)
  it("T-REFUSED: a refused plan throws CellPlanRefusedError and nothing else happens", async () => {
    const s = setup({
      fetchPlan: async () => ({
        ok: false,
        code: "no_model_credential",
        status: 422,
      }),
    });
    await expect(s.executor.run(s.args)).rejects.toBeInstanceOf(
      CellPlanRefusedError,
    );
    expect(s.makeProvider).not.toHaveBeenCalled();
    expect(s.calls).toEqual(["www.fetchPlan"]);
    expect(released).toEqual(["reservation", "slot"]);
    expect(s.abnormal.claimed).toBe(false);
  });

  // card: protects=retries exhausted is cell_plan_unavailable with no create; fails_when=a provider call follows; no_claim=the retry loop
  it("an unavailable plan throws CellPlanUnavailableError", async () => {
    const s = setup({
      fetchPlan: async () => ({
        ok: false,
        code: "cell_plan_unavailable",
        status: 503,
      }),
    });
    await expect(s.executor.run(s.args)).rejects.toBeInstanceOf(
      CellPlanUnavailableError,
    );
    expect(s.makeProvider).not.toHaveBeenCalled();
  });

  // card: protects=after create was sent the plan is never fetched again, success or throw; fails_when=fetchPlan is called twice; no_claim=a redelivery's new fetch
  it("T-NO-REFETCH: a failed create is torn down and the plan is fetched once", async () => {
    const s = setup({
      create: async () => {
        throw Object.assign(new Error("x"), { code: "not_ready" });
      },
    });
    await expect(s.executor.run(s.args)).rejects.toThrow(
      "cell create failed: not_ready",
    );
    expect(s.fetchPlan).toHaveBeenCalledTimes(1);
    // No cell id came back: the www revoke, the readback and the report still run.
    const r = s.calls.indexOf("www.revoke");
    const b = s.calls.indexOf("provider.listByTags");
    expect(r).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(r);
    expect(s.calls[s.calls.length - 1]).toBe("www.report");
    expect(s.www.abnormalPosts).toBe(1);
  });

  // card: protects=the provider's entrypoint is the plan host's cellEntrypoint, and a bad host fails before create with the teardown running; fails_when=a bad host reaches create; no_claim=the entry script
  it("T-ENTRY: the entrypoint follows the host; a bad host is cell_bad_deployment_host", async () => {
    const ok = setup();
    await ok.executor.run(ok.args);
    expect(ok.makeProvider.mock.calls[0]?.[0]).toMatchObject({
      entrypoint: cellEntrypoint("www.example.org"),
    });
    const bad = setup({ deployment: "Bad;Host" });
    await expect(bad.executor.run(bad.args)).rejects.toThrow(
      "cell_bad_deployment_host",
    );
    expect(bad.provider.create).not.toHaveBeenCalled();
    expect(bad.calls[bad.calls.indexOf("www.fetchPlan") + 1]).toBe(
      "www.revoke",
    );
  });

  // card: protects=a poll interval over a quarter of the stale window is refused before admission; fails_when=a slow poll reaches the plan; no_claim=the config parse
  it("refuses a poll interval over 75 s", async () => {
    const s = setup({ pollIntervalMs: 76_000 });
    await expect(s.executor.run(s.args)).rejects.toThrow(
      "cell_poll_interval_too_long",
    );
    expect(s.calls).toEqual([]);
  });
});

describe("the cell run: bootstrap and message", () => {
  // card: protects=the message file carries the placeholder token, useCredits false and the prompt, and no exec argv carries the prompt or the daemon token; fails_when=the prompt reaches argv or the real token is written; no_claim=execd's log
  it("T-MSG: placeholder token, useCredits false, prompt only in the copyIn bytes", async () => {
    const s = setup();
    await s.executor.run(s.args);
    const msg = s.files.find((f) => f.path.includes(".automata-run/msg-"));
    expect(msg).toBeDefined();
    const body = JSON.parse(msg!.text);
    expect(body).toMatchObject({
      token: "automata-cell-daemon-token",
      useCredits: false,
      prompt: PROMPT,
      threadId: "thr_1",
    });
    expect(msg!.opts).toEqual({ mode: 600, owner: "agent", group: "agent" });
    const argv = JSON.stringify(s.execs);
    expect(argv).not.toContain(PROMPT);
    expect(argv).not.toContain(DAEMON);
    expect(argv).toContain(msg!.path);
    expect(
      buildCellMessage(pulled, { threadId: "a", threadChatId: "b" }).useCredits,
    ).toBe(false);
  });

  // card: protects=the clone goes through the broker host, with no credential in any argv; fails_when=a token reaches argv or the checkout branch is wrong; no_claim=git's behaviour
  it("T-CLONE: broker clone argv, no credential, the HOME placeholder login", async () => {
    const s = setup();
    await s.executor.run({
      ...s.args,
      input: { ...s.args.input, workBranch: "fix/x" },
    });
    const clone = s.execs.find((a) => a[1] === "clone");
    expect(clone).toContain(
      "https://www.example.org/api/cell/git/acme/widgets.git",
    );
    expect(
      s.execs.some(
        (a) =>
          a[0] === "/bin/bash" && a[3] === "workbranch" && a[4] === "fix/x",
      ),
    ).toBe(true);
    expect(JSON.stringify(s.execs)).not.toMatch(/token|bearer|CANARY/i);
    const login = s.files.find((f) => f.path.endsWith("/.credentials.json"));
    expect(login?.text).not.toContain(VAULT);
    expect(login?.text).not.toContain(DAEMON);
  });

  // card: protects=a 204 is nothing-to-run with a clean teardown and no abnormal post; fails_when=the poll runs or a terminal is posted; no_claim=www's 204 rule
  it("a 204 is nothing-to-run, torn down clean", async () => {
    const s = setup({ nextMessage: async () => null });
    const out = await s.executor.run(s.args);
    expect(out.outcome).toBe("nothing-to-run");
    expect(s.calls).not.toContain("www.poll");
    expectTeardownOrder(s.calls);
    expect(s.www.abnormalPosts).toBe(0);
  });

  // card: protects=a setup exec failure fails the run, tears down once and posts one abnormal end; fails_when=a second post or no teardown; no_claim=the failure text
  it("T-ONE-TERMINAL: a failed clone posts exactly one abnormal end", async () => {
    const s = setup({ execExit: (a) => (a[1] === "clone" ? 128 : 0) });
    await expect(s.executor.run(s.args)).rejects.toThrow("git clone failed");
    expectTeardownOrder(s.calls);
    expect(s.www.abnormalPosts).toBe(1);
  });

  // card: protects=the fake provider is only asked for ICellProvider methods and none is a pause; fails_when=a pause or resume is called; no_claim=the real adapter
  it("T-NO-PAUSE: only contract methods are used", async () => {
    const s = setup();
    await s.executor.run(s.args);
    const used = Object.entries(s.provider)
      .filter(
        ([, fn]) => (fn as { mock?: { calls: unknown[] } }).mock?.calls.length,
      )
      .map(([k]) => k);
    expect(
      used.every((k) =>
        [
          "create",
          "exec",
          "copyOut",
          "copyIn",
          "revoke",
          "quarantine",
          "delete",
          "listByTags",
        ].includes(k),
      ),
    ).toBe(true);
    expect(used.join()).not.toMatch(/pause|resume/);
  });

  // card: protects=no log line carries the prompt, the vault credential or the daemon token; fails_when=any does; no_claim=other modules' logs
  it("logs none of the secrets", async () => {
    const s = setup();
    await s.executor.run(s.args);
    const all = s.logs.join("\n");
    for (const canary of [PROMPT, VAULT, DAEMON])
      expect(all).not.toContain(canary);
  });
});

describe("the cell run: prior attempts", () => {
  // card: protects=an attempt 5 removes cells 3 and 4 (vault, quarantine, delete) before create and leaves 5 alone; fails_when=a stray equal attempt is touched or the reap runs after create; no_claim=a second server
  it("T-PRIOR-REAP: older attempts are reaped before create", async () => {
    const s = setup({
      attempt: 5,
      listByTags: async () => [
        { cellId: "c3", tags: { attempt: "3" } },
        { cellId: "c4", tags: { attempt: "4" } },
        { cellId: "c5", tags: { attempt: "5" } },
      ],
    });
    await s.executor.run(s.args);
    const create = s.calls.indexOf("provider.create");
    const reap = s.calls
      .slice(0, create)
      .filter((c) => c.startsWith("provider."));
    expect(reap).toEqual([
      "provider.listPrior",
      "provider.revoke",
      "provider.quarantine",
      "provider.delete",
      "provider.revoke",
      "provider.quarantine",
      "provider.delete",
    ]);
  });

  // card: protects=a list failure logs and still creates; attempt 1 makes no provider call before create; fails_when=the create is blocked or attempt 1 lists; no_claim=the reconciler
  it("T-PRIOR-REAP control: a list failure logs and creates; attempt 1 lists nothing", async () => {
    const bad = setup({
      attempt: 5,
      listByTags: async () => {
        throw new Error("down");
      },
    });
    await bad.executor.run(bad.args);
    expect(bad.logs.some((l) => l.includes("cell.prior_reap_failed"))).toBe(
      true,
    );
    expect(bad.provider.create).toHaveBeenCalled();
    const first = setup({ attempt: 1 });
    await first.executor.run(first.args);
    expect(first.calls[first.calls.indexOf("www.fetchPlan") + 1]).toBe(
      "provider.create",
    );
  });
});

describe("the cell run: the heartbeat and the lease", () => {
  /** A run held in create so ticks land during setup. */
  /** Setup held in the clone exec: the cell exists, heartbeats land mid-setup. */
  function slowCreate() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    return { release, gate };
  }

  // card: protects=a heartbeat read with cellAttempt goes out on each tick during a slow create and a refused beat then renewed does not fail; fails_when=no beat during setup or a single refusal fails; no_claim=real time
  it("T-LEASE: beats carry the attempt; refused once then renewed does not fail", async () => {
    const slow = slowCreate();
    const leases: ThreadStatusPoll[] = [
      { kind: "status", status: "working", terminal: false, lease: "refused" },
      { kind: "status", status: "working", terminal: false, lease: "renewed" },
    ];
    const s = setup({
      execGate: slow.gate,
      pollThreadStatus: async () =>
        leases.shift() ?? {
          kind: "status",
          status: "working",
          terminal: false,
          lease: "renewed",
        },
    });
    const run = s.executor.run(s.args);
    await flush();
    await s.tick();
    await s.tick();
    slow.release();
    const out = await run;
    expect(out.outcome).toBe("completed");
    expect(
      s.calls.filter((c) => c === "www.heartbeat").length,
    ).toBeGreaterThanOrEqual(2);
  });

  // card: protects=two refused reads with no newer attempt fail loudly as cell_attempt_revoked with one abnormal end and R first; fails_when=it fences or hangs; no_claim=www's classification
  it("T-DRAIN control / E13b: refused x2 is cell_attempt_revoked", async () => {
    const slow = slowCreate();
    const s = setup({
      execGate: slow.gate,
      pollThreadStatus: async () => ({
        kind: "status",
        status: "working",
        terminal: false,
        lease: "refused",
      }),
    });
    const run = s.executor.run(s.args);
    const settled = expect(run).rejects.toThrow("cell_attempt_revoked");
    await flush();
    await s.tick();
    await s.tick();
    slow.release();
    await settled;
    expect(s.www.abnormalPosts).toBe(1);
    expectTeardownOrder(s.calls);
  });

  // card: protects=one superseded read during setup fences: the vault revoke is the first call after it, no abnormal post, own-attempt teardown, outcome fenced; fails_when=a terminal is posted or R precedes the vault revoke; no_claim=the cross-box drill (T-DRAIN-THREAD, UAT)
  it("T-DRAIN: superseded during setup fences, vault first, nothing posted", async () => {
    const slow = slowCreate();
    const s = setup({
      execGate: slow.gate,
      pollThreadStatus: async () => ({
        kind: "status",
        status: "working",
        terminal: false,
        lease: "superseded",
      }),
    });
    const run = s.executor.run(s.args);
    await flush();
    await s.tick();
    slow.release();
    const out = await run;
    expect(out.outcome).toBe("fenced");
    const afterRead = s.calls.slice(s.calls.indexOf("www.heartbeat") + 1);
    expect(
      afterRead.find((c) => c.startsWith("provider.") || c.startsWith("www.")),
    ).toBe("provider.revoke");
    expect(s.calls).not.toContain("www.abnormal");
    expect(s.calls.indexOf("www.revoke")).toBeGreaterThan(
      s.calls.indexOf("provider.revoke"),
    );
    expect(s.calls.filter((c) => c === "provider.revoke")).toHaveLength(1);
    expect(s.calls[s.calls.length - 1]).toBe("www.report");
    expect(s.abnormal.claimed).toBe(true);
  });

  // card: protects=a superseded lease seen by the poll loop fences the same way; fails_when=the poll path posts a terminal; no_claim=the loop itself (www-client.test.ts)
  it("T-DRAIN: superseded seen in the poll loop fences", async () => {
    const s = setup({
      pollUntilTerminal: async (ctx) => {
        ctx.onLease?.("superseded" as CellLease);
        return { outcome: "cancelled" };
      },
    });
    const out = await s.executor.run(s.args);
    expect(out.outcome).toBe("fenced");
    const after = s.calls.slice(s.calls.indexOf("www.poll") + 1);
    expect(after[0]).toBe("provider.revoke");
    expect(s.www.abnormalPosts).toBe(0);
  });

  // card: protects=three failed beats fail the run cell_heartbeat_lost and tear down; 401 counts the same; fails_when=it keeps waiting or a blip fails; no_claim=the 5xx taxonomy
  it("T-HEARTBEAT: three failures lose the lease; 401 x3 too", async () => {
    for (const mode of ["throw", "auth"] as const) {
      const slow = slowCreate();
      const s = setup({
        execGate: slow.gate,
        pollThreadStatus: async () => {
          if (mode === "throw") throw new Error("HTTP 502");
          return { kind: "auth-error", httpStatus: 401 };
        },
      });
      const run = s.executor.run(s.args);
      const settled = expect(run).rejects.toThrow("cell_heartbeat_lost");
      await flush();
      await s.tick();
      await s.tick();
      await s.tick();
      slow.release();
      await settled;
      expectTeardownOrder(s.calls);
    }
  });

  // card: protects=two failures then a success continue; fails_when=an early failure aborts; no_claim=timing
  it("T-HEARTBEAT control: two failed beats then a good one keep going", async () => {
    const slow = slowCreate();
    const queue: (() => Promise<ThreadStatusPoll>)[] = [
      async () => {
        throw new Error("HTTP 502");
      },
      async () => {
        throw new Error("HTTP 502");
      },
    ];
    const s = setup({
      execGate: slow.gate,
      pollThreadStatus: async () =>
        queue.length
          ? queue.shift()!()
          : {
              kind: "status",
              status: "working",
              terminal: false,
              lease: "renewed",
            },
    });
    const run = s.executor.run(s.args);
    await flush();
    await s.tick();
    await s.tick();
    await s.tick();
    slow.release();
    expect((await run).outcome).toBe("completed");
  });

  // card: protects=a finished step seen during setup completes the run with no message sent and the run recorded as retired; fails_when=a message is sent or the run is not in retiredRuns; no_claim=the poll path
  it("E12: a terminal heartbeat completes the run, nothing is sent to the daemon", async () => {
    const slow = slowCreate();
    const s = setup({
      execGate: slow.gate,
      pollThreadStatus: async () => ({
        kind: "status",
        status: "complete",
        terminal: true,
        lease: "finished",
      }),
    });
    const run = s.executor.run(s.args);
    await flush();
    await s.tick();
    slow.release();
    const out = await run;
    expect(out.outcome).toBe("completed");
    expect(s.calls).not.toContain("www.nextMessage");
    expect(s.marks.get(RUN_ID)).toBe("retired");
    expectTeardownOrder(s.calls);
  });

  // card: protects=a user stop during setup returns stopped with nothing sent; fails_when=a message is written or the outcome differs; no_claim=the user-cancelled post (workflow level)
  it("T-HEARTBEAT: stopping returns stopped and sends no message", async () => {
    const slow = slowCreate();
    const s = setup({
      execGate: slow.gate,
      pollThreadStatus: async () => ({
        kind: "status",
        status: "stopping",
        terminal: false,
        lease: "renewed",
      }),
    });
    const run = s.executor.run(s.args);
    await flush();
    await s.tick();
    slow.release();
    expect((await run).outcome).toBe("stopped");
    expect(s.calls).not.toContain("www.nextMessage");
  });
});

describe("the cell run: terminal outcomes and aborts", () => {
  // card: protects=a finished lease seen by the poll marks the run retired; fails_when=retiredRuns stays empty; no_claim=onFailure (workflow.test.ts)
  it("a finished lease records the run as retired", async () => {
    const s = setup({
      pollUntilTerminal: async (ctx) => {
        ctx.onLease?.("finished");
        return { outcome: "completed", finalStatus: "complete" };
      },
    });
    await s.executor.run(s.args);
    expect(s.marks.get(RUN_ID)).toBe("retired");
  });

  // card: protects=a 409 cell_step_conflict sends no www teardown call and no terminal, runs the local steps and records the token as gone; fails_when=R, A or P goes out; no_claim=www's alert
  it("T-409-SKIP: conflict runs T and B only", async () => {
    const s = setup({
      pollUntilTerminal: async () => {
        throw new CellStepConflictError();
      },
    });
    await expect(s.executor.run(s.args)).rejects.toBeInstanceOf(
      CellStepConflictError,
    );
    expect(s.calls).not.toContain("www.revoke");
    expect(s.calls).not.toContain("www.report");
    expect(s.calls).not.toContain("www.abnormal");
    expect(s.calls).toContain("provider.delete");
    expect(s.calls).toContain("provider.listByTags");
    expect(s.marks.get(RUN_ID)).toBe("tokenGone");
  });

  // card: protects=an agent that died (poll throws) posts one abnormal end and tears down in order; fails_when=two posts; no_claim=the poll's own 2-strike
  it("E8: a poll failure posts one abnormal end", async () => {
    const s = setup({
      pollUntilTerminal: async () => {
        throw new Error("agent died");
      },
    });
    await expect(s.executor.run(s.args)).rejects.toThrow("agent died");
    expect(s.www.abnormalPosts).toBe(1);
    expectTeardownOrder(s.calls);
  });

  // card: protects=with the run signal already aborted the teardown's www calls still go out under their own signal; fails_when=R or P is skipped or reuses the aborted signal; no_claim=Hatchet's cancel
  it("T-ABORT-SIGNAL: an aborted run still tears down on its own signals", async () => {
    const s = setup({
      pollUntilTerminal: async () => {
        s.ac.abort();
        return { outcome: "cancelled" };
      },
    });
    const out = await s.executor.run(s.args);
    expect(out.outcome).toBe("cancelled");
    expect(s.www.revokeSignals).toEqual([false]);
    expectTeardownOrder(s.calls);
  });

  // card: protects=a stopped poll outcome is returned for the outer wrapper to post; fails_when=the executor posts user-cancelled itself; no_claim=the outer post
  it("E11: a stopped poll returns stopped and posts no abnormal end", async () => {
    const s = setup({
      pollUntilTerminal: async () => ({
        outcome: "stopped",
        finalStatus: "stopping",
      }),
    });
    expect((await s.executor.run(s.args)).outcome).toBe("stopped");
    expect(s.www.abnormalPosts).toBe(0);
  });
});

describe("T-IMPORT: the worker imports one sandbox subpath only", () => {
  const SPEC = /(?:from\s+|import\()\s*["'](@terragon\/sandbox[^"']*)["']/g;
  const ALLOWED = "@terragon/sandbox/opensandbox-cell";

  function offenders(text: string): string[] {
    return [...text.matchAll(SPEC)]
      .map((m) => m[1] as string)
      .filter((spec) => spec !== ALLOWED);
  }

  // card: protects=the worker never pulls the sandbox package root (E2B and Daytona SDKs) or another subpath; fails_when=any specifier but the allowed one appears in packages/worker/src; no_claim=transitive imports of the allowed module
  it("allows only @terragon/sandbox/opensandbox-cell", () => {
    const files = execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "packages/worker/src",
      ],
      {
        encoding: "utf8",
        cwd: new URL("../../../../", import.meta.url).pathname,
      },
    )
      .split("\n")
      .filter((f) => f.endsWith(".ts") && !f.endsWith("cell-run.test.ts"));
    const root = new URL("../../../../", import.meta.url).pathname;
    const bad = files.flatMap((f) =>
      offenders(readFileSync(root + f, "utf8")).map((o) => `${f}: ${o}`),
    );
    expect(bad).toEqual([]);
  });

  // card: protects=the checker can fail; fails_when=a root or cell-reconcile specifier is not flagged; no_claim=real files
  it("negative control: the root and another subpath are flagged", () => {
    expect(offenders('import x from "@terragon/sandbox";')).toEqual([
      "@terragon/sandbox",
    ]);
    expect(
      offenders('const m = await import("@terragon/sandbox/cell-reconcile");'),
    ).toEqual(["@terragon/sandbox/cell-reconcile"]);
    expect(offenders(`import a from "${ALLOWED}";`)).toEqual([]);
  });
});

describe("the cell run: refinement (M1, M2, M4, L5, L6)", () => {
  /** Setup held in the clone exec: the cell exists, heartbeats land mid-setup. */
  function slowCreate() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    return { release, gate };
  }
  const status = (over: Partial<ThreadStatusPoll & { kind: "status" }> = {}) =>
    ({
      kind: "status",
      status: "working",
      terminal: false,
      lease: "renewed",
      ...over,
    }) as ThreadStatusPoll;
  const http = (code: string, statusCode = 500) =>
    new ThreadStatusHttpError(statusCode, "x", code);

  // card: protects=a heartbeat 500 cell_finish_failed aborts setup at once, settles on a fresh read BEFORE the teardown, and completes; fails_when=the settle runs after teardown's report or the run fails; no_claim=the poll loop's own budget (www-client.test.ts)
  it("M1: heartbeat 500 cell_finish_failed settles before the teardown", async () => {
    const slow = slowCreate();
    const reads: (() => Promise<ThreadStatusPoll>)[] = [
      async () => {
        throw http("cell_finish_failed");
      },
      async () =>
        status({ status: "complete", terminal: true, lease: "finished" }),
    ];
    const s = setup({
      execGate: slow.gate,
      pollThreadStatus: async () => (reads.shift() ?? (async () => status()))(),
    });
    const run = s.executor.run(s.args);
    await flush();
    await s.tick();
    slow.release();
    const out = await run;
    expect(out).toMatchObject({
      outcome: "completed",
      finalStatus: "complete",
    });
    expect(s.calls.filter((c) => c === "www.heartbeat")).toHaveLength(2);
    const lastRead = s.calls.lastIndexOf("www.heartbeat");
    expect(s.calls.indexOf("www.revoke")).toBeGreaterThan(lastRead);
    expect(s.marks.get(RUN_ID)).toBe("retired");
    expect(s.calls[s.calls.length - 1]).toBe("www.report");
    expect(s.calls).not.toContain("www.nextMessage");
  });

  // card: protects=a heartbeat 500 cell_retire_failed then a 401 on the settle read is confirmed through cell-teardown revoke BEFORE the report, and completes; fails_when=the confirm is skipped or lands after P; no_claim=the confirm hook's retries (cell-www-client.test.ts)
  it("M1: heartbeat 500 cell_retire_failed, 401, confirm lands before the report", async () => {
    const slow = slowCreate();
    const reads: (() => Promise<ThreadStatusPoll>)[] = [
      async () => {
        throw http("cell_retire_failed");
      },
      async () => ({ kind: "auth-error", httpStatus: 401 }),
    ];
    const s = setup({
      execGate: slow.gate,
      pollThreadStatus: async () => (reads.shift() ?? (async () => status()))(),
    });
    const run = s.executor.run(s.args);
    await flush();
    await s.tick();
    slow.release();
    expect((await run).outcome).toBe("completed");
    const revokes = s.calls.reduce<number[]>(
      (acc, c, i) => (c === "www.revoke" ? [...acc, i] : acc),
      [],
    );
    // the confirm, then teardown's own revoke: both before the report
    expect(revokes).toHaveLength(2);
    expect(revokes[0]).toBeGreaterThan(s.calls.lastIndexOf("www.heartbeat"));
    expect(revokes[1]).toBeLessThan(s.calls.indexOf("www.report"));
    expect(s.marks.get(RUN_ID)).toBe("retired");
  });

  // card: protects=a revoke that also 401s after cell_retire_failed fails cell_terminal_unconfirmed with one abnormal end; fails_when=it completes or hangs; no_claim=the 3x backoff
  it("M1 control: the confirm also 401s -> cell_terminal_unconfirmed", async () => {
    const slow = slowCreate();
    const reads: (() => Promise<ThreadStatusPoll>)[] = [
      async () => {
        throw http("cell_retire_failed");
      },
      async () => ({ kind: "auth-error", httpStatus: 401 }),
    ];
    const s = setup({
      execGate: slow.gate,
      pollThreadStatus: async () => (reads.shift() ?? (async () => status()))(),
    });
    s.www.revokeResult = "unauthorized";
    const run = s.executor.run(s.args);
    const settled = expect(run).rejects.toThrow("cell_terminal_unconfirmed");
    await flush();
    await s.tick();
    slow.release();
    await settled;
    expect(s.www.abnormalPosts).toBe(1);
  });

  // card: protects=a heartbeat 409 cell_step_conflict ends the run with the conflict, no www teardown call and no terminal; fails_when=R, A or P goes out; no_claim=www's alert
  it("M1: heartbeat 409 cell_step_conflict skips every www teardown call", async () => {
    const slow = slowCreate();
    const s = setup({
      execGate: slow.gate,
      pollThreadStatus: async () => {
        throw http("cell_step_conflict", 409);
      },
    });
    const run = s.executor.run(s.args);
    const settled = expect(run).rejects.toBeInstanceOf(CellStepConflictError);
    await flush();
    await s.tick();
    slow.release();
    await settled;
    expect(s.calls).not.toContain("www.revoke");
    expect(s.calls).not.toContain("www.report");
    expect(s.marks.get(RUN_ID)).toBe("tokenGone");
  });

  // card: protects=a fence seen while an exec hangs starts the vault revoke at once, without waiting for the exec; fails_when=the run waits on the in-flight call; no_claim=real time (the race is on the abort, not a clock)
  it("M2: a fence during a hung exec starts the vault revoke immediately", async () => {
    const s = setup({
      execHang: (a) => a[1] === "clone",
      pollThreadStatus: async () => status({ lease: "superseded" }),
    });
    const run = s.executor.run(s.args);
    await flush();
    await s.tick();
    const out = await Promise.race([
      run,
      new Promise<"stuck">((r) => setTimeout(() => r("stuck"), 1000)),
    ]);
    expect(out).toMatchObject({ outcome: "fenced" });
    expect(s.calls).toContain("provider.revoke");
    expect(s.marks.get(RUN_ID)).toBe("fenced");
    expect(s.calls).not.toContain("www.abnormal");
  });

  // card: protects=a Stop seen while a copyIn is hung returns stopped at once; fails_when=the run waits on the call; no_claim=the user-cancelled post
  it("M2: a Stop during a hung create returns stopped without waiting", async () => {
    const s = setup({
      create: () => new Promise<never>(() => {}),
      pollThreadStatus: async () => status({ status: "stopping" }),
    });
    const run = s.executor.run(s.args);
    await flush();
    await s.tick();
    const out = await Promise.race([
      run,
      new Promise<"stuck">((r) => setTimeout(() => r("stuck"), 1000)),
    ]);
    expect(out).toMatchObject({ outcome: "stopped" });
    // The teardown still ran: R first, readback, report last.
    expect(s.calls.indexOf("www.revoke")).toBeGreaterThan(-1);
    expect(s.calls[s.calls.length - 1]).toBe("www.report");
  });

  // card: protects=a run with no cell config in its input fails cells_unconfigured and never reads one itself; fails_when=the executor loads a config on its own; no_claim=selectRunExecutor (workflow.test.ts)
  it("L5: the config comes from the executor input only", async () => {
    const s = setup();
    await expect(
      s.executor.run({ ...s.args, cellConfig: undefined }),
    ).rejects.toMatchObject({ code: "cells_unconfigured" });
    expect(s.provider.create).not.toHaveBeenCalled();
    // #718: the teardown's terminal names the code, not the internal config.
    const end = s.www.abnormalEnds[0];
    expect(end?.cause).toBe("run-failed-unreported");
    const info = abnormalEndInfo(end!.cause, {
      ...end!,
      runExecutionTimeoutMs: 60_000,
    });
    expect(info).toContain("cells_unconfigured");
    expect(info).not.toContain("Send the message again");
  });

  // card: protects=the message write's failure logs the step and exit code only, never stderr that may echo the staged message; fails_when=stderr text reaches a log line; no_claim=other steps, whose stderr tail is still logged redacted
  it("L6: a failed message write logs no stderr; a failed clone still does", async () => {
    const canary = "STDERR-ECHO-CANARY";
    const w = setup({
      execExit: (a) => (a[0] === "/bin/bash" ? 1 : 0),
      execStderr: () => canary,
    });
    await expect(w.executor.run(w.args)).rejects.toThrow(
      "message write failed",
    );
    expect(w.logs.join("\n")).not.toContain(canary);
    expect(
      w.logs.some((l) => l.includes("message write failed (exit 1)")),
    ).toBe(true);
    const c = setup({
      execExit: (a) => (a[1] === "clone" ? 128 : 0),
      execStderr: () => canary,
    });
    await expect(c.executor.run(c.args)).rejects.toThrow("git clone failed");
    expect(c.logs.join("\n")).toContain(canary);
  });

  // card: protects=an abort (here a heartbeat Stop) that rejects the pending next-message read ends the run as stopped, not as a thrown error; fails_when=the AbortError is classified and thrown; no_claim=the real fetch's abort
  it("L2: a Stop while next-message is pending is the stopped outcome", async () => {
    const s = setup({
      nextMessage: (signal) =>
        new Promise<never>((_, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            { once: true },
          );
        }),
      pollThreadStatus: async () => status({ status: "stopping" }),
    });
    const run = s.executor.run(s.args);
    await flush();
    await flush();
    await s.tick();
    const out = await run;
    expect(out.outcome).toBe("stopped");
    expect(s.calls[s.calls.length - 1]).toBe("www.report");
  });

  // card: protects=control: a real 4xx on a live signal stays NonRetryable; fails_when=it is swallowed or retried; no_claim=5xx handling (retry-classification.test.ts)
  it("L2 control: a 4xx next-message on a live signal stays NonRetryable", async () => {
    const s = setup({
      nextMessage: async () => {
        throw new NextMessageHttpError(404, "next-message failed: HTTP 404");
      },
    });
    await expect(s.executor.run(s.args)).rejects.toThrow(/non-retryable/);
    expect(s.www.abnormalPosts).toBe(1);
  });
});

describe("the cell run: the owner's repo env (#706)", () => {
  const VALUE = "repo-env-canary-value-1234";
  const SHORT = "abc";
  const withRepoEnv = (
    s: ReturnType<typeof setup>,
    repoEnv: Record<string, string>,
  ) =>
    ({
      ...s.args,
      secrets: { ...s.args.secrets, repoEnv },
    }) as RunExecutorInput;
  const settingsOf = (s: ReturnType<typeof setup>) => {
    const f = s.files.find((x) => x.path.endsWith("/.claude/settings.json"));
    if (f === undefined) throw new Error("no settings.json copied in");
    return { file: f, json: JSON.parse(f.text) as Record<string, unknown> };
  };

  // card: protects=AC 1's worker half: kept names reach the agent's settings env with exact values, in a 600 agent file; fails_when=a kept name is missing, a value differs, or the mode/owner changes; no_claim=the CLI applying the block (UAT)
  it("puts the kept names in the settings env block, 600 agent", async () => {
    const s = setup();
    await s.executor.run(
      withRepoEnv(s, {
        FOO_TOKEN: VALUE,
        PLAIN: "x",
        ANTHROPIC_API_KEY: VALUE,
      }),
    );
    const { file, json } = settingsOf(s);
    expect(json.env).toEqual({ FOO_TOKEN: VALUE, PLAIN: "x" });
    expect(file.opts).toEqual({ mode: 600, owner: "agent", group: "agent" });
  });

  // card: protects=AC 2's worker half: the value travels only in the settings copyIn bytes, never in the create plan, an exec argv, another file or a log line; fails_when=any of them carries it; no_claim=execd's or docker's own records (IT-E1 e)
  it("the value is only in the settings file", async () => {
    const s = setup();
    await s.executor.run(withRepoEnv(s, { FOO_TOKEN: VALUE }));
    expect(JSON.stringify(s.provider.create.mock.calls)).not.toContain(VALUE);
    expect(JSON.stringify(s.makeProvider.mock.calls)).not.toContain(VALUE);
    expect(JSON.stringify(s.execs)).not.toContain(VALUE);
    expect(s.logs.join("\n")).not.toContain(VALUE);
    expect(JSON.stringify(s.www)).not.toContain(VALUE);
    expect(JSON.stringify(s.fetchPlan.mock.calls)).not.toContain(VALUE);
    const carriers = s.files.filter((f) => f.text.includes(VALUE));
    expect(carriers.map((f) => f.path)).toEqual([
      "/home/agent/.claude/settings.json",
    ]);
    expect(s.logs).toContain("[agent-run thr_1] cell: repo env: 1 names");
  });

  // card: protects=AC 3: a reserved name is not injected and one warn line names only the keys; fails_when=the name is set, a value is logged, or the line repeats; no_claim=the box's silent drop
  it("drops reserved names with one line naming only the keys", async () => {
    const s = setup();
    await s.executor.run(
      withRepoEnv(s, {
        ANTHROPIC_API_KEY: VALUE,
        DAEMON_TOKEN: VALUE,
        "bad-name": VALUE,
        OK: "fine",
      }),
    );
    expect(settingsOf(s).json.env).toEqual({ OK: "fine" });
    const lines = s.logs.filter((l) => l.includes("repo env names not set"));
    expect(lines).toEqual([
      "[agent-run thr_1] cell: repo env names not set (reserved): ANTHROPIC_API_KEY, DAEMON_TOKEN (+1 not an env name)",
    ]);
    expect(s.logs.join("\n")).not.toContain(VALUE);
    expect(s.logs.join("\n")).not.toContain("bad-name");
  });

  // card: protects=AC 4: an exec error tail echoing a repo env value of 4+ chars is redacted, a dropped one's too; a 3-char value is left; fails_when=the value reaches the log; no_claim=www's own scrub
  it("redacts repo env values in an exec error tail", async () => {
    const s = setup({
      execExit: (a) => (a[1] === "clone" ? 128 : 0),
      execStderr: () =>
        `fatal: ${VALUE} and ${VALUE}-dropped and ${SHORT} ghs_3211193_abcdefghijklmnop`,
    });
    await expect(
      s.executor.run(
        withRepoEnv(s, {
          FOO_TOKEN: VALUE,
          ANTHROPIC_API_KEY: `${VALUE}-dropped`,
          TINY: SHORT,
        }),
      ),
    ).rejects.toThrow("git clone failed");
    const all = s.logs.join("\n");
    expect(all).not.toContain(VALUE);
    expect(all).not.toContain("ghs_3211193");
    expect(all).toContain(`fatal: <redacted> and <redacted> and ${SHORT}`);
  });

  // card: protects=a non-Claude agent in a cell is told apart, not silently left without the repo env; fails_when=no line is logged for it, or one is for claudeCode; no_claim=the other agent's behaviour
  it("logs when the agent is not the Claude CLI", async () => {
    const s = setup({
      nextMessage: async () => ({ ...pulled, agent: "codex" }),
    });
    await s.executor.run(withRepoEnv(s, { FOO_TOKEN: VALUE }));
    expect(s.logs).toContain(
      "[agent-run thr_1] cell: repo env not delivered (agent=codex)",
    );
    const c = setup();
    await c.executor.run(withRepoEnv(c, { FOO_TOKEN: VALUE }));
    expect(c.logs.join("\n")).not.toContain("not delivered");
  });

  // card: protects=every cell log line passes the value scrub, not only exec tails; fails_when=a value echoed into another log line (a lease error, a teardown line) is logged raw; no_claim=lines other modules log
  it("scrubs a value echoed into any cell log line", async () => {
    // The deployment host is logged on the `cell: image=` line; here it
    // happens to equal the owner's value.
    const s = setup({ deployment: VALUE });
    await s.executor.run(withRepoEnv(s, { FOO_TOKEN: VALUE }));
    const line = s.logs.find((l) => l.includes("cell: image="));
    expect(line).toContain("deployment=<redacted>");
    expect(s.logs.join("\n")).not.toContain(VALUE);
  });

  // card: protects=a common short repo env value does not blank the platform's words in every log line; fails_when=`agent` or `true` is redacted out of ordinary lines; no_claim=exec tails, which still blank from 4 chars
  it("leaves ordinary log lines readable with short common values", async () => {
    const s = setup();
    await s.executor.run(withRepoEnv(s, { CI: "true", MODE: "agent" }));
    expect(s.logs).toContain(
      "[agent-run thr_1] next-message: got message (agent=claudeCode, model=m)",
    );
    expect(s.logs.join("\n")).not.toContain("<redacted>");
  });

  // card: protects=the scrub runs on the whole stderr before the 512-char cut, so a value straddling the cut leaves no half behind; fails_when=the tail is cut first and the value's second half is logged; no_claim=values under 4 chars
  it("scrubs before the tail is cut", async () => {
    const half = VALUE.slice(VALUE.length / 2);
    const s = setup({
      execExit: (a) => (a[1] === "clone" ? 128 : 0),
      // The cut lands inside VALUE: 512 chars from the end is mid-value.
      execStderr: () => `${VALUE}${"x".repeat(512 - half.length)}`,
    });
    await expect(
      s.executor.run(withRepoEnv(s, { FOO_TOKEN: VALUE })),
    ).rejects.toThrow("git clone failed");
    expect(s.logs.join("\n")).not.toContain(half);
  });

  // card: protects=no repo env is no change: the settings file has no env key and no repo env line is logged; fails_when=either appears; no_claim=none
  it("absent or fully dropped repo env leaves the settings as today", async () => {
    const s = setup();
    await s.executor.run(s.args);
    expect(settingsOf(s).json).not.toHaveProperty("env");
    expect(s.logs.join("\n")).not.toContain("repo env");
    const d = setup();
    await d.executor.run(withRepoEnv(d, { PATH: "/x" }));
    expect(settingsOf(d).json).not.toHaveProperty("env");
  });
});

describe("the cell run: a test database for TEST_SERVICES_REPOS repos (#707)", () => {
  const TEST_DB_URL = cellTestDbUrl(TEST_DB_PASSWORD);
  const dir = mkdtempSync(join(tmpdir(), "cell-tdb-"));
  const listFile = (name: string, repos: string) => {
    const p = join(dir, `${name}.env`);
    writeFileSync(p, `TEST_SERVICES_REPOS=${repos}\n`, { mode: 0o640 });
    return p;
  };
  const LISTED = listFile("listed", "other/repo, ACME/Widgets");
  const UNLISTED = listFile("unlisted", "other/repo");
  const isPg = (argv: string[]) =>
    argv.some((a) => a.includes(CELL_PG_BIN) || a.includes(CELL_TEST_DB_DIR));
  const settingsEnv = (s: ReturnType<typeof setup>) => {
    const f = s.files.find((x) => x.path.endsWith("/.claude/settings.json"));
    if (f === undefined) throw new Error("no settings.json copied in");
    return (JSON.parse(f.text) as { env?: Record<string, string> }).env;
  };

  // card: protects=AC 1's worker half: a listed repo's cell gets the dir, the password file (600 agent, the exact bytes), the start, a ready probe and the role, in that order, then the URL in the settings env; fails_when=a step is missing or reordered, the file mode/owner changes, or the URL differs; no_claim=that Postgres runs in the image (IT-E1 f, verify.sh)
  it("starts the database for a listed repo and hands the agent the URL", async () => {
    const s = setup({ testServicesPath: LISTED });
    await s.executor.run(s.args);
    expect(s.execs.filter(isPg)).toEqual([
      [...CELL_TEST_DB_MKDIR_ARGV],
      ["/bin/bash", "-c", CELL_TEST_DB_START_SH, "cell-test-db"],
      [...CELL_TEST_DB_READY_ARGV],
      ["/bin/bash", "-c", CELL_TEST_DB_ROLE_SH, "cell-test-db"],
    ]);
    const pw = s.files.find((f) => f.path === CELL_TEST_DB_PASSWORD_FILE);
    expect(pw?.text).toBe(TEST_DB_PASSWORD);
    expect(pw?.opts).toEqual({ mode: 600, owner: "agent", group: "agent" });
    expect(settingsEnv(s)).toEqual({
      TEST_DATABASE_ADMIN_URL: TEST_DB_URL,
    });
    const order = s.files.map((f) => f.path);
    expect(order.indexOf(CELL_TEST_DB_PASSWORD_FILE)).toBeLessThan(
      order.indexOf("/home/agent/.claude/settings.json"),
    );
    expect(s.logs).toContain(
      "[agent-run thr_1] cell: test database ready in 0ms",
    );
  });

  // card: protects=AC 5's worker half: the password is only in the password file and the settings file, never in an exec argv, the create plan, a www call or a log line; fails_when=any of them carries it; no_claim=execd's, docker's or the server's own records (IT-E1 f)
  it("keeps the password out of argv, the plan and the logs", async () => {
    const s = setup({ testServicesPath: LISTED });
    await s.executor.run(s.args);
    expect(JSON.stringify(s.execs)).not.toContain(TEST_DB_PASSWORD);
    expect(JSON.stringify(s.provider.create.mock.calls)).not.toContain(
      TEST_DB_PASSWORD,
    );
    expect(JSON.stringify(s.makeProvider.mock.calls)).not.toContain(
      TEST_DB_PASSWORD,
    );
    expect(JSON.stringify(s.www)).not.toContain(TEST_DB_PASSWORD);
    expect(s.logs.join("\n")).not.toContain(TEST_DB_PASSWORD);
    expect(
      s.files
        .filter((f) => f.text.includes(TEST_DB_PASSWORD))
        .map((f) => f.path),
    ).toEqual([
      CELL_TEST_DB_PASSWORD_FILE,
      "/home/agent/.claude/settings.json",
    ]);
  });

  // card: protects=AC 2: an unlisted repo, or no file at all, gets no Postgres exec, no password file and no variable; fails_when=any of them appears; no_claim=none
  it("does nothing for a repo the list does not name, or without the file", async () => {
    for (const path of [UNLISTED, undefined]) {
      const s = setup({ testServicesPath: path });
      await s.executor.run(s.args);
      expect(s.execs.filter(isPg)).toEqual([]);
      expect(s.files.map((f) => f.path)).not.toContain(
        CELL_TEST_DB_PASSWORD_FILE,
      );
      expect(settingsEnv(s)).toBeUndefined();
      expect(s.logs.join("\n")).not.toContain("test database");
    }
  });

  // card: protects=AC 3: the owner's own TEST_DATABASE_ADMIN_URL reaches the agent unchanged and no server is started for it; fails_when=the cell's URL replaces it or a Postgres exec runs; no_claim=the owner's database being reachable from a cell
  it("lets the owner's TEST_DATABASE_ADMIN_URL win and starts nothing", async () => {
    const owner = "postgresql://mine:owner-secret-value@db.example.org/x";
    const s = setup({ testServicesPath: LISTED });
    await s.executor.run({
      ...s.args,
      secrets: {
        ...s.args.secrets,
        repoEnv: { TEST_DATABASE_ADMIN_URL: owner },
      },
    } as RunExecutorInput);
    expect(settingsEnv(s)).toEqual({ TEST_DATABASE_ADMIN_URL: owner });
    expect(s.execs.filter(isPg)).toEqual([]);
    expect(s.logs).toContain(
      "[agent-run thr_1] cell: test database not started (the owner's TEST_DATABASE_ADMIN_URL wins)",
    );
    expect(s.logs.join("\n")).not.toContain("owner-secret-value");
  });

  // card: protects=the readiness wait is a loop of probes with a pause between them; fails_when=the loop stops before a 0 or never pauses; no_claim=the real server's start time (AC 4, IT-E1 f)
  it("probes until ready, pausing between probes", async () => {
    let probes = 0;
    const s = setup({
      testServicesPath: LISTED,
      execExit: (a) =>
        a[0] === CELL_TEST_DB_READY_ARGV[0] ? (++probes < 3 ? 2 : 0) : 0,
    });
    await s.executor.run(s.args);
    expect(probes).toBe(3);
    expect(s.logs).toContain(
      "[agent-run thr_1] cell: test database ready in 1000ms",
    );
    expect(settingsEnv(s)?.TEST_DATABASE_ADMIN_URL).toBe(TEST_DB_URL);
  });

  // card: protects=a database that never gets ready stops at the budget, the role is never made, and the run goes on without the variable; fails_when=the loop runs past the budget, the role step runs, the variable is set or the run fails; no_claim=the budget's size against a real server
  it("gives up at the budget and runs on without the variable", async () => {
    let probes = 0;
    const s = setup({
      testServicesPath: LISTED,
      execExit: (a) => {
        if (a[0] !== CELL_TEST_DB_READY_ARGV[0]) return 0;
        probes += 1;
        return 2;
      },
    });
    const out = await s.executor.run(s.args);
    expect(out.outcome).toBe("completed");
    expect(probes).toBe(61);
    expect(s.execs.some((a) => a[2] === CELL_TEST_DB_ROLE_SH)).toBe(false);
    expect(settingsEnv(s)).toBeUndefined();
    expect(s.logs).toContain(
      "[agent-run thr_1] cell: test database not started; the run goes on without it (cell test database not ready after 30000ms)",
    );
  });

  // card: protects=a failed start's stderr tail is logged with the password redacted, and the run goes on; fails_when=the password reaches the log, the variable is set or the run fails; no_claim=what initdb or psql print
  it("redacts the password from a failed step's stderr", async () => {
    const s = setup({
      testServicesPath: LISTED,
      execExit: (a) => (a[2] === CELL_TEST_DB_START_SH ? 1 : 0),
      execStderr: (a) =>
        a[2] === CELL_TEST_DB_START_SH
          ? `initdb: echo ${TEST_DB_PASSWORD}`
          : "",
    });
    const out = await s.executor.run(s.args);
    expect(out.outcome).toBe("completed");
    const all = s.logs.join("\n");
    expect(all).not.toContain(TEST_DB_PASSWORD);
    expect(all).toContain(
      "cell setup: test database start failed (exit 1): initdb: echo <redacted>",
    );
    expect(settingsEnv(s)).toBeUndefined();
  });

  // card: protects=a fence during the readiness probe ends the run as fenced at once, not degraded: no "not started" line, no role, no cleanup, no settings file; fails_when=the abort is swallowed into the degrade path; no_claim=the other abort kinds (they share the same catch)
  it("a fence during the readiness probe propagates", async () => {
    const s = setup({
      testServicesPath: LISTED,
      execHang: (a) => a[0] === CELL_TEST_DB_READY_ARGV[0],
      pollThreadStatus: async () => ({
        kind: "status",
        status: "working",
        terminal: false,
        lease: "superseded",
      }),
    });
    const run = s.executor.run(s.args);
    for (let i = 0; i < 5; i++) await flush();
    expect(s.execs.some((a) => a[0] === CELL_TEST_DB_READY_ARGV[0])).toBe(true);
    await s.tick();
    const out = await Promise.race([
      run,
      new Promise<"stuck">((r) => setTimeout(() => r("stuck"), 1000)),
    ]);
    expect(out).toMatchObject({ outcome: "fenced" });
    expect(s.logs.join("\n")).not.toContain("test database not started");
    expect(s.execs.some((a) => a[2] === CELL_TEST_DB_ROLE_SH)).toBe(false);
    expect(s.execs.some((a) => a[2] === CELL_TEST_DB_STOP_SH)).toBe(false);
    expect(s.files.map((f) => f.path)).not.toContain(
      "/home/agent/.claude/settings.json",
    );
  });

  // card: protects=a degraded start cleans up after itself (password file, server) and a failing cleanup does not fail the run; fails_when=no cleanup exec runs or its failure fails the run; no_claim=what pg_ctl does in the image
  it("cleans up after a failed start, ignoring the cleanup's own failure", async () => {
    const s = setup({
      testServicesPath: LISTED,
      execExit: (a) =>
        a[2] === CELL_TEST_DB_ROLE_SH || a[2] === CELL_TEST_DB_STOP_SH ? 1 : 0,
    });
    const out = await s.executor.run(s.args);
    expect(out.outcome).toBe("completed");
    expect(s.execs.filter(isPg).at(-1)).toEqual([
      "/bin/bash",
      "-c",
      CELL_TEST_DB_STOP_SH,
    ]);
    expect(settingsEnv(s)).toBeUndefined();
  });

  // card: protects=a non-Claude agent is told apart, not silently left without the URL; fails_when=no line is logged for it; no_claim=the other agent's behaviour
  it("logs when the agent is not the Claude CLI", async () => {
    const s = setup({
      testServicesPath: LISTED,
      nextMessage: async () => ({ ...pulled, agent: "codex" }),
    });
    await s.executor.run(s.args);
    expect(s.logs).toContain(
      "[agent-run thr_1] cell: test database env not delivered (agent=codex)",
    );
  });
});
