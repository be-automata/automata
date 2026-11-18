import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { newAbnormalEndState } from "./abnormal-end";
import {
  buildCellMessage,
  createCellExecutor,
  CELL_SETUP_STAMP_MS,
  type CellExecutorDeps,
} from "./cell-run";
import { cellEntrypoint } from "./cell-image";
import {
  CellPlanRefusedError,
  CellPlanUnavailableError,
} from "./cell-www-client";
import type { RunExecutorInput } from "./run-executor";
import {
  CellStepConflictError,
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
    nextMessage?: () => Promise<typeof pulled | null>;
    pollThreadStatus?: () => Promise<ThreadStatusPoll>;
    pollUntilTerminal?: (ctx: PollContext) => Promise<unknown>;
    execExit?: (argv: string[]) => number;
    execStderr?: (argv: string[]) => string;
    execHang?: (argv: string[]) => boolean;
    /** Holds the clone exec until released (setup stays busy, the cell exists). */
    execGate?: Promise<void>;
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
    revokeResult: "ok" as "ok" | "unauthorized" | "failed",
    reportBodies: [] as unknown[],
  };
  let hbWaiters: (() => void)[] = [];
  let clock = 0;
  const retiredRuns = new Set<string>();
  const tokenGoneRuns = new Set<string>();
  const fencedRuns = new Set<string>();
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
      nextMessage: async () => {
        calls.push("www.nextMessage");
        return over.nextMessage ? over.nextMessage() : pulled;
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
      postAbnormal: async () => {
        calls.push("www.abnormal");
        www.abnormalPosts += 1;
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
    retiredRuns,
    tokenGoneRuns,
    fencedRuns,
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
    retiredRuns,
    tokenGoneRuns,
    fencedRuns,
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
    expect(s.execs.some((a) => a.join(" ").includes("checkout -B fix/x"))).toBe(
      true,
    );
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
    expect(s.retiredRuns.has(RUN_ID)).toBe(true);
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
    expect(s.retiredRuns.has(RUN_ID)).toBe(true);
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
    expect(s.tokenGoneRuns.has(RUN_ID)).toBe(true);
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
    expect(s.retiredRuns.has(RUN_ID)).toBe(true);
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
    expect(s.retiredRuns.has(RUN_ID)).toBe(true);
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
    expect(s.tokenGoneRuns.has(RUN_ID)).toBe(true);
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
    expect(s.fencedRuns.has(RUN_ID)).toBe(true);
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
});
