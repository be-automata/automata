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
import {
  CELL_SESSION_SCHEMA,
  computeManifestId,
  sha256Hex,
  type CellSessionManifest,
} from "@terragon/types/cell-session-checkpoint";

import { BoundedRunMap } from "./run-end-marks";
import {
  buildCellMessage,
  createCellExecutor,
  CELL_CAPTURE_IDLE_PULL_MS,
  CELL_CAPTURE_POLL_MS,
  CELL_MEMORY_SAMPLE_MS,
  CELL_SETUP_STAMP_MS,
  CELL_TIMEOUT_CAPTURE_BUDGET_MS,
  type CellExecutorDeps,
} from "./cell-run";
import { CELL_FREEZE_ARGV } from "./cell-salvage";
import { cellEntrypoint, cellGhSetup } from "./cell-image";
import { flutterWrapperArgv } from "./flutter-sdk";
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
/** #749: the getter the cell run hands the headroom reservation. */
const observed: { current: (() => number | null) | null } = { current: null };
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
      observe: (current: () => number | null) => {
        observed.current = current;
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
    execStdout?: (argv: string[]) => string;
    execThrow?: (argv: string[]) => boolean;
    execHang?: (argv: string[]) => boolean;
    /** Holds the clone exec until released (setup stays busy, the cell exists). */
    execGate?: Promise<void>;
    /** The box test-services file (#707); default a path that does not exist. */
    testServicesPath?: string;
    /** #743 phase 6: turns the per-turn session capture on (default off, like production). */
    capture?: boolean;
    /** What the checkpoint route's commit answers; default ok with the next version. */
    commit?: (expectedVersion: number) => Promise<unknown>;
    putBlob?: () => Promise<unknown>;
    /** #743 phase 8: the restore's reads; both unset = no restore reads wired. */
    readHead?: () => Promise<unknown>;
    readBlob?: (sha256: string) => Promise<unknown>;
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
  const sampleWaiters: (() => void)[] = [];
  const captureWaiters: (() => void)[] = [];
  const checkpoint = {
    puts: [] as { sha256: string; text: string }[],
    commits: [] as { manifest: { turn: number }; expected: number }[],
    probesAtRevoke: -1,
  };
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
      if (over.execThrow?.(argv)) throw new Error("exec transport down");
      if (over.execGate && argv[1] === "clone") await over.execGate;
      return {
        exitCode: over.execExit?.(argv) ?? 0,
        stdout: over.execStdout?.(argv) ?? "",
        stderr: over.execStderr?.(argv) ?? "",
      };
    }),
    copyOut: vi.fn(async (_id: string, _path: string): Promise<Uint8Array> => {
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
        checkpoint.probesAtRevoke = execs.filter(isCaptureProbe).length;
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
    ...(over.capture === true
      ? { sessionContinuation: () => true }
      : { sessionContinuation: () => false }),
    checkpoint: {
      putBlob: async (_o, sha256, bytes) => {
        if (over.putBlob) return (await over.putBlob()) as never;
        checkpoint.puts.push({ sha256, text: new TextDecoder().decode(bytes) });
        return { ok: true, created: true };
      },
      commit: async (_o, manifest, expected) => {
        if (over.commit) return (await over.commit(expected)) as never;
        checkpoint.commits.push({
          manifest: manifest as unknown as { turn: number },
          expected,
        });
        return { ok: true, version: expected + 1 };
      },
      ...(over.readHead && over.readBlob
        ? {
            readHead: async () => (await over.readHead?.()) as never,
            readBlob: async (_o: unknown, sha256: string) =>
              (await over.readBlob?.(sha256)) as never,
          }
        : {}),
    },
    sleep: async (ms, signal) => {
      // #743: the capture loop has its own interval and waits like the sampler.
      if (ms === CELL_CAPTURE_POLL_MS) {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          captureWaiters.push(resolve);
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }
      // #749: the memory sampler's interval waits for the run to stop, like
      // the heartbeat, so its loop never spins on this instant clock.
      if (ms === CELL_MEMORY_SAMPLE_MS) {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          sampleWaiters.push(resolve);
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }
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
  /** #749: one memory-sampler tick: wake its sleep and let the read land. */
  const sampleTick = async () => {
    sampleWaiters.splice(0).forEach((r) => r());
    await flush();
    await flush();
  };
  /** #743: one capture-loop tick: wake its sleep and let the pull land. */
  const captureTick = async () => {
    await flush();
    captureWaiters.splice(0).forEach((r) => r());
    await flush();
    await flush();
  };
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
    sampleTick,
    captureTick,
    advance: (ms: number) => {
      clock += ms;
    },
    checkpoint,
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

/** #743: the capture loop's transcript probe (F6: every project dir at depth 2). */
const isCaptureProbe = (a: string[]) =>
  a[0] === "/usr/bin/find" && a.includes("-printf");
/** #743 F9: the re-check right before the read. */
const isRegularFileCheck = (a: string[]) =>
  a[0] === "/usr/bin/find" && a.includes("-print") && a.includes("-quit");

/** The bootstrap's existence probe for the user memory file (#727 B). */
const isMemoryProbe = (a: string[]) =>
  a[0] === "/usr/bin/test" &&
  a[1] === "-e" &&
  a[2] === "/home/agent/.claude/CLAUDE.md";

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

/** The gh setup every cell's settings env carries (#727 B); repo-env and test-db tests read the rest. */
const GH = cellGhSetup({
  brokerHost: "www.example.org",
  repoFullName: "acme/widgets",
  botLogin: "bot[bot]",
});
const GH_ENV = GH.env;

describe("the cell run: success, plan, create", () => {
  // card: protects=#749 a live cell's own cgroup memory (anon + shmem from /sys/fs/cgroup/memory.stat inside the cell) feeds the headroom reservation, so a busy cell is not counted twice; fails_when=the sampler never runs, reads the wrong file, or hands admission no getter; no_claim=the kernel's accounting on a real box
  it("#749 samples the cell's memory.stat and hands admission its anon + shmem", async () => {
    observed.current = null;
    const s = setup({
      execStdout: (argv) =>
        argv.join(" ") === "cat /sys/fs/cgroup/memory.stat"
          ? "anon 3221225472\nfile 999\nshmem 1048576\n"
          : "",
    });
    await s.executor.run(s.args);
    expect(
      s.execs.some((a) => a.join(" ") === "cat /sys/fs/cgroup/memory.stat"),
    ).toBe(true);
    const getter = observed.current as (() => number | null) | null;
    expect(getter?.()).toBe(3221225472 + 1048576);
  });

  // card: protects=#749 the sampler keeps reading through the agent's work (the poll loop), not only during setup, so the reservation follows a cell that grows; fails_when=it stops with the setup heartbeat at the message write; no_claim=the CELL_MEMORY_SAMPLE_MS (4 s) cadence on a real clock
  it("#749 keeps sampling during the poll loop: a cell that grows mid-run is observed", async () => {
    observed.current = null;
    let stat = "anon 1073741824\n";
    let midRun: number | null | undefined;
    let risingOnce: number | null | undefined;
    const s = setup({
      execStdout: (argv) =>
        argv.join(" ") === "cat /sys/fs/cgroup/memory.stat" ? stat : "",
      pollUntilTerminal: async () => {
        stat = "anon 5368709120\nshmem 0\n";
        await s.sampleTick();
        const getter = observed.current as (() => number | null) | null;
        // A rise counts once seen twice (the lower of the last two samples).
        risingOnce = getter?.();
        await s.sampleTick();
        midRun = getter?.();
        return { outcome: "completed", finalStatus: "complete" };
      },
    });
    await s.executor.run(s.args);
    expect(risingOnce).toBe(1073741824);
    expect(midRun).toBe(5368709120);
  });

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

  // card: protects=#727 B (AC-5, AC-7 worker half): an absent user CLAUDE.md gets the note alone, unread; gh's host login is the broker host with the placeholder, 600 agent, and no file carries the vault bearer or daemon token; the agent note says reads only; fails_when=a real credential lands in a gh file, the host differs from the clone's, or the note is missing; no_claim=gh honouring the files (IT)
  it("writes gh's host login with the placeholder only, and the read-only note", async () => {
    const s = setup({ execExit: (a) => (isMemoryProbe(a) ? 1 : 0) });
    await s.executor.run(s.args);
    expect(s.execs).toContainEqual([
      "/bin/mkdir",
      "-p",
      "-m",
      "700",
      "/home/agent/.claude",
      "/home/agent/.config/gh",
    ]);
    const hosts = s.files.find(
      (f) => f.path === "/home/agent/.config/gh/hosts.yml",
    );
    expect(hosts?.text).toBe(
      cellGhSetup({
        brokerHost: "www.example.org",
        repoFullName: "acme/widgets",
        botLogin: s.args.config.botLogin,
      }).hostsYml,
    );
    expect(hosts?.text).toContain("oauth_token: automata-cell-gh-placeholder");
    expect(hosts?.opts).toEqual({ mode: 600, owner: "agent", group: "agent" });
    const note = s.files.find(
      (f) => f.path === "/home/agent/.claude/CLAUDE.md",
    );
    // Absent (the probe exits 1): the note alone, and nothing was read.
    expect(note?.text.startsWith("# GitHub access in this run")).toBe(true);
    expect(note?.text).toContain("read-only broker");
    expect(note?.text).toContain("refused with a 403");
    expect(
      s.provider.copyOut.mock.calls.some(
        ([, path]) => path === "/home/agent/.claude/CLAUDE.md",
      ),
    ).toBe(false);
    for (const f of s.files) {
      expect(f.text).not.toContain(VAULT);
      expect(f.text).not.toContain(DAEMON);
    }
  });

  // card: protects=#727 B: an image's own ~/.claude/CLAUDE.md is kept and the gh note appended; fails_when=the image's memory is overwritten or the note is missing; no_claim=the CLI loading it
  it("appends the gh note to an existing user CLAUDE.md", async () => {
    const s = setup();
    s.provider.copyOut.mockImplementation(async (_id: string, path: string) => {
      if (path === "/home/agent/.claude/CLAUDE.md") {
        return new TextEncoder().encode("# image memory\n\nkeep me\n");
      }
      throw new Error("absent");
    });
    await s.executor.run(s.args);
    const note = s.files.find(
      (f) => f.path === "/home/agent/.claude/CLAUDE.md",
    );
    expect(
      note?.text.startsWith(
        "# image memory\n\nkeep me\n\n# GitHub access in this run",
      ),
    ).toBe(true);
  });

  // card: protects=#727 B: a ~/.claude/CLAUDE.md that exists but cannot be read is left as it is (the note is skipped and said so), never overwritten by the note alone; fails_when=the file is written after a failed read, or the run fails on it; no_claim=why the read failed
  it("leaves an existing CLAUDE.md it could not read untouched, and says so", async () => {
    const s = setup();
    s.provider.copyOut.mockImplementation(async () => {
      throw new Error("http_error");
    });
    const out = await s.executor.run(s.args);
    expect(out.outcome).toBe("completed");
    expect(
      s.files.some((f) => f.path === "/home/agent/.claude/CLAUDE.md"),
    ).toBe(false);
    expect(s.logs.join("\n")).toContain(
      "cell: gh note not added (~/.claude/CLAUDE.md could not be read)",
    );
  });

  // card: protects=#727 B ordering: the gh files are in place before settings.json (whose env names them) and before the daemon socket wait; fails_when=settings or the socket wait comes first; no_claim=the entry's own start
  it("writes the gh files before settings.json and before the socket wait", async () => {
    const s = setup({ execExit: (a) => (isMemoryProbe(a) ? 1 : 0) });
    await s.executor.run(s.args);
    const execAt = (pred: (a: string[]) => boolean) => {
      const i = s.provider.exec.mock.calls.findIndex(([, a]) => pred(a));
      return s.provider.exec.mock.invocationCallOrder[i] ?? -1;
    };
    const fileAt = (path: string) => {
      const i = s.provider.copyIn.mock.calls.findIndex(([, p]) => p === path);
      return s.provider.copyIn.mock.invocationCallOrder[i] ?? -1;
    };
    const mkdirGh = execAt((a) => a.includes("/home/agent/.config/gh"));
    const hosts = fileAt("/home/agent/.config/gh/hosts.yml");
    const note = fileAt("/home/agent/.claude/CLAUDE.md");
    const settings = fileAt("/home/agent/.claude/settings.json");
    const socket = execAt((a) => a[0] === "/usr/bin/test" && a[1] === "-S");
    expect([mkdirGh, hosts, note, settings].every((n) => n > 0)).toBe(true);
    expect(mkdirGh).toBeLessThan(hosts);
    expect(hosts).toBeLessThan(settings);
    expect(note).toBeLessThan(settings);
    expect(settings).toBeLessThan(socket);
  });

  // card: protects=#727 B: a failed gh config mkdir or hosts.yml write ends the run like any bootstrap step: one abnormal end, one ordered teardown, no settings.json and no socket wait; fails_when=the run goes on, posts twice or skips the teardown; no_claim=the message text
  it("a failed gh mkdir or hosts.yml write fails the run once, torn down", async () => {
    const m = setup({
      execExit: (a) => (a.includes("/home/agent/.config/gh") ? 1 : 0),
    });
    await expect(m.executor.run(m.args)).rejects.toThrow("mkdir home failed");
    const h = setup();
    const copyIn = h.provider.copyIn.getMockImplementation();
    h.provider.copyIn.mockImplementation(async (id, path, bytes, opts) => {
      if (path.endsWith("/hosts.yml")) throw new Error("upload failed");
      return copyIn?.(id, path, bytes, opts);
    });
    await expect(h.executor.run(h.args)).rejects.toThrow("upload failed");
    for (const s of [m, h]) {
      expectTeardownOrder(s.calls);
      expect(s.www.abnormalPosts).toBe(1);
      expect(s.files.some((f) => f.path.endsWith("/settings.json"))).toBe(
        false,
      );
      expect(
        s.execs.some((a) => a[0] === "/usr/bin/test" && a[1] === "-S"),
      ).toBe(false);
    }
  });

  // card: protects=#727 B AC-7: nothing gh-related is logged with a value (the host login, the placeholder, GH_REPO); fails_when=a log line carries one; no_claim=other modules' logs
  it("logs no gh value", async () => {
    const s = setup();
    await s.executor.run(s.args);
    const all = s.logs.join("\n");
    for (const v of [
      "automata-cell-gh-placeholder",
      "oauth_token",
      "www.example.org/acme/widgets",
      "GH_REPO",
    ]) {
      expect(all).not.toContain(v);
    }
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
    expect(json.env).toEqual({ FOO_TOKEN: VALUE, PLAIN: "x", ...GH_ENV });
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
    expect(settingsOf(s).json.env).toEqual({ OK: "fine", ...GH_ENV });
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

  // card: protects=no repo env is no change: the settings env holds the gh names only and no repo env line is logged; fails_when=another name appears; no_claim=none
  it("absent or fully dropped repo env leaves only the gh names", async () => {
    const s = setup();
    await s.executor.run(s.args);
    expect(settingsOf(s).json.env).toEqual(GH_ENV);
    expect(s.logs.join("\n")).not.toContain("repo env");
    const d = setup();
    await d.executor.run(withRepoEnv(d, { PATH: "/x" }));
    expect(settingsOf(d).json.env).toEqual(GH_ENV);
  });

  // card: protects=#727 B: an owner's GH_* names never reach the env (reserved prefix), so they cannot repoint gh; fails_when=the owner's GH_HOST or GH_REPO wins; no_claim=gh honouring the env (IT)
  it("an owner's GH_HOST or GH_REPO is dropped, the broker's stays", async () => {
    const s = setup();
    await s.executor.run(
      withRepoEnv(s, { GH_HOST: "github.com", GH_REPO: "evil/repo" }),
    );
    expect(settingsOf(s).json.env).toEqual(GH_ENV);
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
      ...GH_ENV,
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
      expect(settingsEnv(s)).toEqual(GH_ENV);
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
    expect(settingsEnv(s)).toEqual({
      ...GH_ENV,
      TEST_DATABASE_ADMIN_URL: owner,
    });
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
    expect(settingsEnv(s)).toEqual(GH_ENV);
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
    expect(settingsEnv(s)).toEqual(GH_ENV);
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
    expect(settingsEnv(s)).toEqual(GH_ENV);
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

describe("the cell run: the project's Flutter SDK (#742)", () => {
  const DEFAULT_SDK = "3.47.7";
  const isWrapper = (a: string[]) => a[0] === "bash" && a[1] === "-c";
  const PINS_PATH = "/opt/automata/pins.env";
  const flutterLogs = (s: ReturnType<typeof setup>) =>
    s.logs.filter((l) => l.includes("cell: flutter"));
  /** The image's pins file; an older image has no FLUTTER_EXTRA_VERSIONS. */
  const pinsEnv = (extras: string | null = "3.41.2") =>
    `NODE_VERSION=24.21.0\nFLUTTER_VERSION=${DEFAULT_SDK}\n${
      extras === null ? "" : `FLUTTER_EXTRA_VERSIONS='${extras}'\n`
    }`;
  /** ~/.claude/CLAUDE.md is absent in the image: the note is written whole. */
  const absentMemory = (a: string[]) => (isMemoryProbe(a) ? 1 : 0);
  const note = (s: ReturnType<typeof setup>) =>
    s.files.find((f) => f.path === "/home/agent/.claude/CLAUDE.md")?.text ?? "";

  /** Marker files in the clone and the image's pins file. */
  function withProject(
    s: ReturnType<typeof setup>,
    markers: Record<string, string>,
    // Markers present in the clone but not regular files under the cap
    // (a symlink, a device, oversized): the find probe does not list them.
    unreadable: readonly string[] = [],
    pins: string = pinsEnv(),
  ) {
    const exec = s.provider.exec.getMockImplementation();
    if (exec === undefined) throw new Error("exec has no implementation");
    s.provider.exec.mockImplementation(async (id: string, argv: string[]) =>
      argv[0] === "/usr/bin/find"
        ? {
            exitCode: 0,
            stdout: Object.keys(markers)
              .filter((rel) => !unreadable.includes(rel))
              .map((rel) => `/workspace/${rel}\n`)
              .join(""),
            stderr: "",
          }
        : exec(id, argv),
    );
    s.provider.copyOut.mockImplementation(async (_id: string, path: string) => {
      if (path === PINS_PATH) return new TextEncoder().encode(pins);
      const text = markers[path.replace(/^\/workspace\//, "")];
      if (path.startsWith("/workspace/") && text !== undefined) {
        return new TextEncoder().encode(text);
      }
      throw new Error("absent");
    });
  }

  /** One run over a project: the setup, the markers and the image, then the run. */
  async function flutterRun(
    markers: Record<string, string>,
    over: {
      setup?: Parameters<typeof setup>[0];
      unreadable?: readonly string[];
      pins?: string;
    } = {},
  ) {
    const s = setup({ execExit: absentMemory, ...over.setup });
    withProject(s, markers, over.unreadable, over.pins);
    const out = await s.executor.run(s.args);
    return { s, out };
  }
  const fvmrc = (flutter: string) => ({
    ".fvmrc": JSON.stringify({ flutter }),
  });

  // card: protects=#742 refinement: a marker the find probe does not list (a symlink to /dev/zero, a FIFO, an oversized file) is never copied out, so a hostile repo cannot stall the bootstrap; fails_when=copyOut is called for it; no_claim=find's own -P/-type f semantics (coreutils)
  it("a marker that is not a regular file under the cap is never read", async () => {
    const { s, out } = await flutterRun(fvmrc("3.41.2"), {
      unreadable: [".fvmrc"],
    });
    expect(out.outcome).toBe("completed");
    expect(
      s.provider.copyOut.mock.calls.some(([, path]) =>
        String(path).endsWith("/.fvmrc"),
      ),
    ).toBe(false);
    expect(s.execs.filter(isWrapper)).toEqual([]);
  });

  // card: protects=a pin is decided from the one pins file: an SDK the image bakes gets wrappers (and the journal and note say so), one it lacks, or any pin on an image that predates the cache, keeps /opt/flutter, installs nothing and says so (F9); fails_when=a shim blocks the run, a line differs, the note is missing, or a missing list fails the run; no_claim=the box path's exit-69 shims (unchanged)
  it.each([
    [
      "an SDK the image has",
      "3.41.2",
      pinsEnv(),
      [flutterWrapperArgv("3.41.2")],
      "cell: flutter 3.41.2 (pinned by .fvmrc)",
      "this run uses SDK 3.41.2",
    ],
    [
      "an SDK the image lacks",
      "3.35.0",
      pinsEnv(),
      [],
      "cell: flutter pin 3.35.0 not in the image; using 3.47.7",
      "NOT in this image",
    ],
    [
      "an older image without extras",
      "3.41.2",
      pinsEnv(null),
      [],
      "cell: flutter pin 3.41.2 not in the image; using 3.47.7",
      "NOT in this image",
    ],
  ])("a pin on %s", async (_n, version, pins, wrappers, line, noteText) => {
    const { s, out } = await flutterRun(fvmrc(version), { pins });
    expect(out.outcome).toBe("completed");
    expect(s.execs.filter(isWrapper)).toEqual(wrappers);
    expect(flutterLogs(s)).toEqual([`[agent-run thr_1] ${line}`]);
    expect(note(s)).toContain(noteText);
    expect(note(s).startsWith("# GitHub access in this run")).toBe(true);
  });

  // card: protects=the wrapper script is exec'd once, after the clone and before the first message, and names FLUTTER_ROOT; fails_when=the exec is repeated, mis-ordered or missing; no_claim=the wrapper's behaviour (flutter-sdk.test.ts) and the image (batteries verify.sh)
  it("the wrappers are installed once, after the clone and before the first message", async () => {
    const { s } = await flutterRun(fvmrc("3.41.2"));
    const wrappers = s.execs.filter(isWrapper);
    expect(wrappers).toHaveLength(1);
    expect(wrappers[0]![2]).toContain("FLUTTER_ROOT");
    const cloneAt = s.execs.findIndex((a) => a[1] === "clone");
    expect(s.execs.findIndex(isWrapper)).toBeGreaterThan(cloneAt);
    expect(s.calls.indexOf("www.nextMessage")).toBeGreaterThan(
      s.calls.indexOf("provider.exec"),
    );
  });

  // card: protects=CELL-ONLY pubspec reading: a constraint the default satisfies installs nothing; fails_when=a constraint is ignored or always installs a wrapper; no_claim=the box path (it never reads pubspec.yaml)
  it("reads the pubspec constraint: the default satisfying it keeps the default", async () => {
    const { s } = await flutterRun({
      "pubspec.yaml": "name: a\nenvironment:\n  flutter: ^3.40.0\n",
    });
    expect(s.execs.filter(isWrapper)).toEqual([]);
    expect(flutterLogs(s)).toEqual([
      "[agent-run thr_1] cell: flutter 3.47.7 (default satisfies pubspec)",
    ]);
    expect(note(s)).toContain("the image default SDK 3.47.7");
  });

  // card: protects=a pubspec constraint only a baked SDK satisfies selects that SDK; fails_when=the baked SDK is not selected; no_claim=the default-satisfies path
  it("reads the pubspec constraint: a constraint only a baked SDK satisfies selects it", async () => {
    const { s } = await flutterRun({
      "pubspec.yaml": 'name: a\nenvironment:\n  flutter: ">=3.41.0 <3.42.0"\n',
    });
    expect(s.execs.filter(isWrapper)).toEqual([flutterWrapperArgv("3.41.2")]);
    expect(flutterLogs(s)).toEqual([
      "[agent-run thr_1] cell: flutter 3.41.2 (satisfies pubspec)",
    ]);
  });

  // card: protects=a project with no Flutter requirement costs nothing: no pins read, no wrapper, no journal line, the note is the gh note alone; fails_when=any extra read, exec or line appears; no_claim=Flutter projects
  it("no requirement: nothing is read, installed, logged or noted", async () => {
    const { s } = await flutterRun({ "README.md": "x" });
    expect(s.provider.copyOut.mock.calls.map(([, p]) => p)).not.toContain(
      PINS_PATH,
    );
    expect(s.execs.filter(isWrapper)).toEqual([]);
    expect(flutterLogs(s)).toEqual([]);
    expect(note(s)).not.toContain("Flutter");
  });

  // card: protects=an unsafe version in a marker never reaches a log line, an argv or the note; fails_when=the raw text is used; no_claim=every other parser input (flutter-sdk.test.ts)
  it("an unsafe version in a marker is ignored entirely", async () => {
    const { s } = await flutterRun(fvmrc("3.41.2\nforged: line"));
    expect(s.execs.filter(isWrapper)).toEqual([]);
    expect(s.logs.join("\n")).not.toContain("forged");
  });

  // card: protects=a wrapper install that fails never fails the run: the default stays, the failure is journaled and the note says selection failed; fails_when=the run fails or the note claims the pinned SDK; no_claim=why the install failed
  it("a failing wrapper install fails open to the default SDK", async () => {
    const { s, out } = await flutterRun(fvmrc("3.41.2"), {
      setup: { execExit: (a) => (isWrapper(a) ? 65 : absentMemory(a)) },
    });
    expect(out.outcome).toBe("completed");
    // One line, the failure: never a "flutter 3.41.2" claim it then retracts.
    expect(flutterLogs(s)).toEqual([
      "[agent-run thr_1] cell: flutter 3.41.2 wrapper install failed (exit 65); using 3.47.7",
    ]);
    expect(note(s)).toContain("selecting it failed");
    expect(note(s)).not.toContain("this run uses SDK");
  });

  // card: protects=an exec transport error during selection fails open: the run goes on and the line says so; fails_when=the error fails the run; no_claim=aborts (they still stop the setup)
  it("an exec error during selection never fails the run", async () => {
    const { s, out } = await flutterRun(fvmrc("3.41.2"), {
      setup: { execThrow: isWrapper },
    });
    expect(out.outcome).toBe("completed");
    expect(s.logs.join("\n")).toContain(
      "cell: flutter selection failed; using the image default SDK",
    );
  });

  // card: protects=a transport error reading a marker fails the WHOLE selection open: it never falls through to a lower-precedence marker and picks a different SDK; fails_when=pubspec.yaml selects an SDK after .fvmrc failed to read; no_claim=aborts
  it("a transport error on .fvmrc never falls through to pubspec.yaml", async () => {
    const s = setup({ execExit: absentMemory });
    withProject(s, {
      ...fvmrc("3.41.2"),
      "pubspec.yaml": 'name: a\nenvironment:\n  flutter: ">=3.41.0 <3.42.0"\n',
    });
    const read = s.provider.copyOut.getMockImplementation();
    if (read === undefined) throw new Error("copyOut has no implementation");
    s.provider.copyOut.mockImplementation(async (id: string, path: string) => {
      if (path.endsWith("/.fvmrc")) throw new Error("copyOut transport down");
      return read(id, path);
    });
    const out = await s.executor.run(s.args);
    expect(out.outcome).toBe("completed");
    expect(s.execs.filter(isWrapper)).toEqual([]);
    expect(flutterLogs(s)).toEqual([
      "[agent-run thr_1] cell: flutter selection failed; using the image default SDK",
    ]);
  });
});

describe("the per-turn session capture (#743 phase 6)", () => {
  const SID = "11111111-1111-4111-8111-111111111111";
  const NEWER = "22222222-2222-4222-8222-222222222222";
  const enc = (t: string) => new TextEncoder().encode(t);
  const turn = (n: number) =>
    `${JSON.stringify({
      type: "assistant",
      uuid: `u${n}`,
      message: {
        id: `msg_${n}`,
        content: [{ type: "text", text: `answer ${n}` }],
      },
    })}\n`;
  const openToolCall = `${JSON.stringify({
    type: "assistant",
    uuid: "up",
    message: {
      id: "msg_open",
      content: [{ type: "tool_use", id: "tu1", name: "Bash", input: {} }],
    },
  })}\n`;
  const completed = { outcome: "completed", finalStatus: "complete" };

  interface Cell {
    text: string;
    dir: string;
    id: string;
    /** Extra probe lines, as the agent could leave them. */
    extra: string;
    /** The regular-file re-check answers nothing: the path is now a symlink. */
    swapped: boolean;
    /** The probe lists no session file at all. */
    unlisted: boolean;
  }

  /** A cell whose transcript lives in `cell`, answering the real probe and re-check argv shapes. */
  function capturing(
    scenario: (
      s: ReturnType<typeof setup>,
      cell: Cell,
    ) => Promise<unknown> | unknown,
    over: Parameters<typeof setup>[0] = {},
    init: Partial<Cell> = {},
  ) {
    const cell: Cell = {
      text: "",
      dir: "-workspace",
      id: SID,
      extra: "",
      swapped: false,
      unlisted: false,
      ...init,
    };
    const path = () =>
      `/home/agent/.claude/projects/${cell.dir}/${cell.id}.jsonl`;
    const s: ReturnType<typeof setup> = setup({
      capture: true,
      execStdout: (argv) => {
        if (isCaptureProbe(argv)) {
          const own = cell.unlisted
            ? ""
            : `${enc(cell.text).length} 1700000000.5 ${cell.dir}/${cell.id}.jsonl\n`;
          return own + cell.extra;
        }
        if (isRegularFileCheck(argv)) return cell.swapped ? "" : `${path()}\n`;
        return "";
      },
      pollUntilTerminal: async () => {
        await scenario(s, cell);
        return completed;
      },
      ...over,
    });
    s.provider.copyOut.mockImplementation(async () => enc(cell.text));
    return { s, cell, path };
  }
  const probes = (s: { execs: string[][] }) =>
    s.execs.filter(isCaptureProbe).length;
  /** The copyOut paths under ~/.claude/projects (the bootstrap reads other files). */
  const sessionReads = (s: ReturnType<typeof setup>) =>
    s.provider.copyOut.mock.calls
      .map((c) => c[1])
      .filter((p) => p.includes("/.claude/projects/"));
  const checkLogs = (s: { logs: string[] }) =>
    s.logs.filter((l) => l.includes("cell: checkpoint"));

  // card: protects=#743 a completed turn is redacted in the worker and written through the checkpoint route (blobs, then a commit from version 0), and the next turn appends from the new head with only its own bytes; fails_when=nothing is written, a later turn restarts from version 0, or the whole transcript is re-uploaded; no_claim=the redaction rules (phase 5) or the www route
  it("captures a completed turn, then the next one from the new head", async () => {
    const { s, cell } = capturing(async (s, cell) => {
      cell.text = turn(1);
      await s.captureTick();
      cell.text = turn(1) + turn(2);
      await s.captureTick();
    });
    const out = await s.executor.run(s.args);
    expect(out.outcome).toBe("completed");
    expect(
      s.checkpoint.commits.map((c) => [c.manifest.turn, c.expected]),
    ).toEqual([
      [1, 0],
      [2, 1],
    ]);
    const natives = s.checkpoint.puts.filter((p) => p.text.includes("answer"));
    expect(natives.some((p) => p.text.includes("answer 2"))).toBe(true);
    // The second pull uploads only its own turn.
    expect(
      s.checkpoint.puts.filter((p) => p.text.includes("answer 1")).length,
    ).toBeGreaterThan(0);
    expect(
      s.checkpoint.puts.some(
        (p) => p.text.includes("answer 2") && p.text.includes("answer 1"),
      ),
    ).toBe(false);
    expect(checkLogs(s).join("\n")).toMatch(
      /cell: checkpoint turn=2 native=\d+ chunks=2 hits=0 v=2 in \d+ms/,
    );
    expect(cell.text.length).toBeGreaterThan(0);
  });

  // card: protects=#743 an unchanged transcript commits nothing, an unfinished tool call is not a turn, and a pull with no new bytes (the 60 s idle pull) writes nothing (A-12); fails_when=a commit is sent for the same bytes or for a half turn; no_claim=the idle cadence on a real clock
  it("writes nothing without a new completed turn or new bytes", async () => {
    const { s, cell } = capturing(async (s, cell) => {
      cell.text = openToolCall;
      await s.captureTick(); // grew, but the turn is not complete
      cell.text = openToolCall + turn(1);
      await s.captureTick(); // one commit
      await s.captureTick(); // same size: no pull
      s.advance(CELL_CAPTURE_IDLE_PULL_MS);
      await s.captureTick(); // idle pull: nothing new
    });
    await s.executor.run(s.args);
    expect(s.checkpoint.commits).toHaveLength(1);
    expect(cell.text).toBe(openToolCall + turn(1));
    // The idle tick did pull (read the file) but wrote nothing.
    expect(sessionReads(s).length).toBeGreaterThanOrEqual(3);
  });

  // card: protects=#743 F6: the probe searches every project dir at depth 2 for regular files with no hard-coded dir, picks the file named after the pulled session over a newer one, and copies out from the dir it found; fails_when=-workspace is hard-coded, the newest file wins over the session id, or a symlink is listed; no_claim=which dir a real run uses (AC-8)
  it("F6 finds the session by id in a dir other than -workspace", async () => {
    const other = `/home/agent/.claude/projects/-home-agent-proj/${SID}.jsonl`;
    const { s, cell } = capturing(
      async (s, cell) => {
        cell.text = turn(1);
        await s.captureTick();
      },
      {
        nextMessage: async () =>
          ({ ...pulled, sessionId: SID }) as unknown as typeof pulled,
      },
      {
        dir: "-home-agent-proj",
        extra: `1 1800000000.0 -workspace/${NEWER}.jsonl\nnot-a-session.jsonl\n9 1 -bad dir/${SID}.jsonl\n`,
      },
    );
    await s.executor.run(s.args);
    const probe = s.execs.find(isCaptureProbe) as string[];
    expect(probe.slice(0, 3)).toEqual([
      "/usr/bin/find",
      "-P",
      "/home/agent/.claude/projects",
    ]);
    expect(probe.join(" ")).toContain("-mindepth 2 -maxdepth 2 -type f");
    expect(probe.join(" ")).not.toContain("-workspace");
    expect(sessionReads(s)).toEqual([other]);
    expect(s.checkpoint.commits).toHaveLength(1);
    expect(cell.dir).toBe("-home-agent-proj");
  });

  // card: protects=#743 F9: a file swapped for a symlink after the probe fails the regular-file re-check and is never copied out; a fresh run (no session id) takes the newest UUID file; fails_when=copyOut runs on a path the re-check refused; no_claim=the residual gap between the re-check and copyOut (spec 2.3)
  it("F9 refuses a symlink: the re-check fails and copyOut is not called", async () => {
    const { s } = capturing(
      async (s, cell) => {
        cell.text = turn(1);
        await s.captureTick();
      },
      {},
      { swapped: true },
    );
    await s.executor.run(s.args);
    expect(sessionReads(s)).toEqual([]);
    expect(s.execs.some(isRegularFileCheck)).toBe(true);
    expect(s.checkpoint.commits).toHaveLength(0);
    expect(checkLogs(s)).toContain(
      "[agent-run thr_1] cell: checkpoint skipped (not a regular file)",
    );
  });

  // card: protects=#743 a symlink the probe does not list is never read; fails_when=an unlisted path is pulled anyway; no_claim=the probe's own -type f filtering (find)
  it("pulls nothing when the probe lists no session file", async () => {
    const { s } = capturing(
      async (s, cell) => {
        cell.text = turn(1);
        await s.captureTick();
      },
      {},
      { unlisted: true },
    );
    await s.executor.run(s.args);
    expect(sessionReads(s)).toEqual([]);
    expect(probes(s)).toBeGreaterThan(1);
  });

  // card: protects=#743 a failed read, a failed write and a thrown error never fail the run, and each logs one line naming the cause class only (no transcript bytes, no token, no error text); fails_when=the run fails, or a canary reaches a log; no_claim=the www client's own error handling
  it("fails open and logs the cause class only", async () => {
    const CANARY = "TRANSCRIPT-CANARY-do-not-log";
    const copyFail = capturing(async (s, cell) => {
      cell.text = turn(1);
      s.provider.copyOut.mockRejectedValue(new Error(CANARY));
      await s.captureTick();
    });
    expect((await copyFail.s.executor.run(copyFail.s.args)).outcome).toBe(
      "completed",
    );
    expect(checkLogs(copyFail.s)).toContain(
      "[agent-run thr_1] cell: checkpoint skipped (copy-out failed)",
    );

    const putFail = capturing(
      async (s, cell) => {
        cell.text = turn(1);
        await s.captureTick();
      },
      {
        putBlob: async () => ({
          ok: false,
          code: "no_open_cell_step",
          status: 403,
        }),
      },
    );
    expect((await putFail.s.executor.run(putFail.s.args)).outcome).toBe(
      "completed",
    );
    expect(checkLogs(putFail.s).join("\n")).toContain(
      "fenced; capture stopped",
    );

    const thrown = capturing(
      async (s, cell) => {
        cell.text = turn(1);
        await s.captureTick();
        await s.captureTick();
      },
      {
        commit: async () => {
          throw new Error(CANARY);
        },
      },
    );
    expect((await thrown.s.executor.run(thrown.s.args)).outcome).toBe(
      "completed",
    );
    const lines = checkLogs(thrown.s);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => /\(error Error\)$/.test(l))).toBe(true);

    const soft = capturing(
      async (s, cell) => {
        cell.text = turn(1);
        await s.captureTick();
      },
      { commit: async () => ({ ok: false, code: "transport", status: 0 }) },
    );
    await soft.s.executor.run(soft.s.args);
    expect(checkLogs(soft.s)).toContain(
      "[agent-run thr_1] cell: checkpoint skipped (www transport)",
    );

    const all = [copyFail, putFail, thrown, soft]
      .flatMap((c) => c.s.logs)
      .join("\n");
    expect(all).not.toContain(CANARY);
    expect(all).not.toContain(DAEMON);
  });

  // card: protects=#743 a lost head CAS stops the capture for the rest of the run; fails_when=the loop keeps probing after head_moved; no_claim=restoring the head (phase 8)
  it("stops after head_moved", async () => {
    const { s } = capturing(
      async (s, cell) => {
        cell.text = turn(1);
        await s.captureTick();
        const before = probes(s);
        cell.text = turn(1) + turn(2);
        await s.captureTick();
        expect(probes(s)).toBe(before);
      },
      {
        commit: async () => ({
          ok: false,
          code: "head_moved",
          status: 409,
          version: 3,
        }),
      },
    );
    await s.executor.run(s.args);
    expect(checkLogs(s)).toContain(
      "[agent-run thr_1] cell: checkpoint skipped (head moved; capture stopped)",
    );
  });

  // card: protects=#743 the capture loop stops before the teardown starts, so no probe or write runs against a cell that is being revoked; fails_when=a probe runs after www.revoke, or the loop outlives the run; no_claim=an in-flight pull at the cancel (phase 7b)
  it("stops before teardown", async () => {
    const { s, cell } = capturing(async (s, cell) => {
      cell.text = turn(1);
      await s.captureTick();
    });
    await s.executor.run(s.args);
    const atRevoke = s.checkpoint.probesAtRevoke;
    expect(atRevoke).toBeGreaterThan(0);
    await s.captureTick();
    expect(probes(s)).toBe(atRevoke);
    expect(cell.text).toBe(turn(1));
  });

  // card: protects=#743 the capture is off unless its gate says yes (phase 11 wires the flag): no probe, no read, no write, and a non-claude agent never captures; fails_when=a probe or a copyOut runs with the gate off; no_claim=the flag itself
  it("is disabled by default", async () => {
    const off = setup({
      execStdout: (argv) =>
        isCaptureProbe(argv) ? `5 1 -workspace/${SID}.jsonl\n` : "",
    });
    off.provider.copyOut.mockImplementation(async () => enc(turn(1)));
    await off.executor.run(off.args);
    expect(probes(off)).toBe(0);
    expect(sessionReads(off)).toEqual([]);
    expect(off.checkpoint.commits).toHaveLength(0);

    const codex = setup({
      capture: true,
      nextMessage: async () =>
        ({ ...pulled, agent: "codex" }) as unknown as typeof pulled,
    });
    await codex.executor.run(codex.args);
    expect(probes(codex)).toBe(0);
  });
});

describe("the timeout capture order (#743 phase 7b)", () => {
  const SID = "11111111-1111-4111-8111-111111111111";
  const enc = (t: string) => new TextEncoder().encode(t);
  const TURN = `${JSON.stringify({
    type: "assistant",
    uuid: "u1",
    message: { id: "msg_1", content: [{ type: "text", text: "answer 1" }] },
  })}\n`;
  const isFreeze = (a: string[]) =>
    a[0] === "/bin/sh" && a[2] === CELL_FREEZE_ARGV[2];
  const isSalvage = (a: string[]) => a[0] === "/usr/bin/env";

  /**
   * A run whose poll ends on the run's own abort, `ago` ms after it started:
   * past the 30 minute limit it is the typed `timeout`, inside it a plain cancel.
   */
  function ending(
    over: Parameters<typeof setup>[0] = {},
    {
      timedOut = true,
      onPoll,
    }: { timedOut?: boolean; onPoll?: () => Promise<void> | void } = {},
  ) {
    // The transcript is listed only once the poll ends, so the loop never sees it.
    let listed = false;
    const s: ReturnType<typeof setup> = setup({
      execStdout: (argv) => {
        if (argv[0] === "/usr/bin/find" && argv.includes("-printf")) {
          if (!listed) return "";
          return `${enc(TURN).length} 1700000000.5 -workspace/${SID}.jsonl\n`;
        }
        if (argv[0] === "/usr/bin/find" && argv.includes("-quit")) {
          return `/home/agent/.claude/projects/-workspace/${SID}.jsonl\n`;
        }
        return "";
      },
      pollUntilTerminal: async () => {
        listed = true;
        await onPoll?.();
        if (!timedOut) s.abnormal.runStartedAt = Date.now();
        s.ac.abort();
        return { outcome: "cancelled", finalStatus: undefined };
      },
      ...over,
    });
    s.provider.copyOut.mockImplementation(async (_id, path) => {
      if (path.includes("/.claude/projects/")) return enc(TURN);
      throw new Error("absent");
    });
    // Record the steps of the timeout capture in the call order.
    const inner = s.provider.exec.getMockImplementation() as (
      id: string,
      argv: string[],
    ) => Promise<unknown>;
    s.provider.exec.mockImplementation((async (id: string, argv: string[]) => {
      if (isFreeze(argv)) s.calls.push("freeze");
      else if (isSalvage(argv)) s.calls.push("salvage");
      else if (argv[0] === "/usr/bin/find" && argv.includes("-printf")) {
        s.calls.push("probe");
      }
      return inner(id, argv);
    }) as never);
    const withBranch = {
      ...s.args,
      input: { ...s.args.input, workBranch: "fix/x" },
    } as typeof s.args;
    return { s, args: withBranch };
  }

  // card: protects=#743 7b OQ-4/F2 order: on a typed timeout the agent is frozen, the final pull writes the transcript, the salvage runs, and only then the teardown starts with the bearer revoke; the capture loop does not probe after the stop; fails_when=any step moves after www.revoke or the order changes; no_claim=the real cell, the salvage's git steps (cell-salvage.test.ts)
  it("freeze, then the final pull, then the salvage, all before the revoke", async () => {
    const { s, args } = ending({ capture: true });
    const out = await s.executor.run(args);
    expect(out.outcome).toBe("cancelled");
    const at = (name: string) => s.calls.lastIndexOf(name);
    const revoke = s.calls.indexOf("www.revoke");
    expect(s.calls.indexOf("freeze")).toBeGreaterThan(-1);
    // The loop's last probe (if any) is before the freeze; the final pull's is after.
    expect(at("probe")).toBeGreaterThan(s.calls.indexOf("freeze"));
    expect(at("salvage")).toBeGreaterThan(at("probe"));
    expect(revoke).toBeGreaterThan(at("salvage"));
    // The final pull wrote the turn the loop never saw.
    expect(s.checkpoint.commits.map((c) => c.manifest.turn)).toEqual([1]);
    expect(s.logs.some((l) => l.includes("salvage:"))).toBe(true);
    // No probe after the stop: nothing runs between the revoke and the end.
    expect(s.calls.slice(revoke).includes("probe")).toBe(false);
    // The worker's cause is the typed timeout.
    expect(s.www.abnormalEnds[0]?.cause).toBe("timeout");
  });

  // card: protects=#743 7b: the freeze and the salvage run on a timeout even with the capture gate off (like the box's), but nothing is pulled or written; fails_when=a probe, a copy-out or a write happens with the gate off, or the salvage is skipped; no_claim=the flag wiring (phase 11)
  it("with the gate off, still freezes and salvages and pulls nothing", async () => {
    const { s, args } = ending({ capture: false });
    await s.executor.run(args);
    expect(s.calls).toContain("freeze");
    expect(s.calls).toContain("salvage");
    expect(s.calls).not.toContain("probe");
    expect(s.checkpoint.commits).toHaveLength(0);
    expect(s.calls.indexOf("www.revoke")).toBeGreaterThan(
      s.calls.lastIndexOf("salvage"),
    );
  });

  // card: protects=#743 7b: WORKER_TIMEOUT_SALVAGE=off (the box's switch) turns off the freeze and the salvage on a cell too; fails_when=either still runs; no_claim=the final pull, which the capture gate owns
  it("honours WORKER_TIMEOUT_SALVAGE=off", async () => {
    const { s, args } = ending({ capture: false });
    await s.executor.run({
      ...args,
      config: { ...args.config, timeoutSalvage: "off" },
    } as typeof args);
    expect(s.calls).not.toContain("freeze");
    expect(s.calls).not.toContain("salvage");
    expect(s.calls).toContain("www.revoke");
  });

  // card: protects=#743 7b: only the typed timeout triggers the capture; a completed run, a cancel inside the limit and a run that threw keep today's teardown with no freeze, no extra probe and no salvage; fails_when=any of them freezes, pulls once more or salvages; no_claim=the cause classification (abnormal-end.test.ts)
  it("a non-timeout end skips all of it", async () => {
    const done = setup({
      capture: true,
      execStdout: (argv) =>
        argv[0] === "/usr/bin/find" && argv.includes("-printf")
          ? `${enc(TURN).length} 1700000000.5 -workspace/${SID}.jsonl\n`
          : "",
    });
    await done.executor.run({
      ...done.args,
      input: { ...done.args.input, workBranch: "fix/x" },
    } as typeof done.args);
    expect(done.execs.some(isFreeze)).toBe(false);
    expect(done.execs.some(isSalvage)).toBe(false);

    const early = ending({ capture: true }, { timedOut: false });
    const out = await early.s.executor.run(early.args);
    expect(out.outcome).toBe("cancelled");
    expect(early.s.calls).not.toContain("freeze");
    expect(early.s.calls).not.toContain("salvage");
    expect(early.s.checkpoint.commits).toHaveLength(0);
    expect(early.s.www.abnormalEnds).toHaveLength(0);

    const failed = ending({
      capture: true,
      pollUntilTerminal: async () => {
        throw new Error("poll broke");
      },
    });
    await expect(failed.s.executor.run(failed.args)).rejects.toThrow();
    expect(failed.s.calls).not.toContain("freeze");
    expect(failed.s.calls).not.toContain("salvage");
    expect(failed.s.www.abnormalEnds[0]?.cause).not.toBe("timeout");
  });

  // card: protects=#743 7b F2/OQ-4: a per-turn pull still in flight at the timeout is waited for inside the 40 s budget and abandoned when it is spent, a hung final pull is abandoned at 40 s, the salvage is skipped, and the teardown (the revoke) still starts by 40 s; fails_when=the revoke starts after the budget or the run hangs; no_claim=real wall time (fake timers drive it)
  it("abandons hung steps at the 40 s budget and still tears down", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const hang = new Promise<Uint8Array>(() => {});
      const { s, args } = ending(
        { capture: true },
        {
          onPoll: async () => {
            // A turn in the file and a pull that never returns: in flight at the cancel.
            await s.captureTick();
          },
        },
      );
      s.provider.copyOut.mockImplementation(async (_id, path) => {
        if (path.includes("/.claude/projects/")) return hang;
        throw new Error("absent");
      });
      const startedAt = Date.now();
      let revokedAfter: number | null = null;
      const run = s.executor.run(args);
      let done = false;
      void run.finally(() => {
        done = true;
      });
      for (let t = 0; t <= 60_000 && !done; t += 500) {
        await flush();
        if (revokedAfter === null && s.calls.includes("www.revoke")) {
          revokedAfter = Date.now() - startedAt;
        }
        await vi.advanceTimersByTimeAsync(500);
        await flush();
        if (revokedAfter === null && s.calls.includes("www.revoke")) {
          revokedAfter = Date.now() - startedAt;
        }
      }
      await run;
      expect(revokedAfter).not.toBeNull();
      expect(revokedAfter as number).toBeGreaterThanOrEqual(39_000);
      expect(revokedAfter as number).toBeLessThanOrEqual(
        CELL_TIMEOUT_CAPTURE_BUDGET_MS + 1_000,
      );
      const log = s.logs.join("\n");
      expect(log).toContain("in-flight pull abandoned");
      expect(log).toContain("final pull abandoned");
      expect(log).toContain("salvage skipped (budget spent)");
      expect(s.calls).not.toContain("salvage");
      expect(s.calls).toContain("www.report");
    } finally {
      vi.useRealTimers();
    }
  });

  // card: protects=#743 7b nit: the capture loop's interval is not the run's default poll interval (7 s) nor another sleep in the run, the #749 collision class; fails_when=it equals any of them; no_claim=the loop's behaviour
  it("the capture interval is distinct from every other sleep", () => {
    expect(CELL_CAPTURE_POLL_MS).not.toBe(7_000);
    expect(CELL_CAPTURE_POLL_MS).not.toBe(CELL_MEMORY_SAMPLE_MS);
    expect(CELL_CAPTURE_POLL_MS).not.toBe(CELL_SETUP_STAMP_MS);
    expect(CELL_CAPTURE_POLL_MS).not.toBe(5_000); // CELL_TERMINAL_RETRY.delayMs
  });
});

describe("the session restore (#743 phase 8)", () => {
  const SID = "11111111-1111-4111-8111-111111111111";
  const PATH = `/home/agent/.claude/projects/-workspace/${SID}.jsonl`;
  const enc = (t: string) => new TextEncoder().encode(t);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  const turn = (n: number) =>
    `${JSON.stringify({
      type: "assistant",
      uuid: `u${n}`,
      message: {
        id: `msg_${n}`,
        content: [{ type: "text", text: `answer ${n}` }],
      },
    })}\n`;
  const withSession = (id: string | null = SID) =>
    (async () => ({ ...pulled, sessionId: id })) as never;

  /** A hand-built head: `chunks` pieces of a transcript, addressed by their hash. */
  function head(chunks: string[], over: Partial<CellSessionManifest> = {}) {
    const parts = chunks.map(enc);
    const whole = enc(chunks.join(""));
    const body: Omit<CellSessionManifest, "id"> = {
      schema: CELL_SESSION_SCHEMA,
      threadId: "thr_1",
      threadChatId: "tc_1",
      sessionId: SID,
      parent: null,
      turn: chunks.length,
      runExternalId: "run-0",
      createdAt: "2026-01-02T03:04:05.000Z",
      harness: { name: "claude-code", nativeFormat: "claude-jsonl" },
      projectDir: "-workspace",
      git: null,
      native: {
        sha256: sha256Hex(whole),
        bytes: whole.length,
        chunks: parts.map((p) => ({ sha256: sha256Hex(p), bytes: p.length })),
      },
      events: { count: 0, chunks: [] },
      redaction: { rulesDigest: "d", hits: 0 },
      ...over,
    };
    const manifest = { ...body, id: computeManifestId(body) };
    const blobs = new Map(parts.map((p) => [sha256Hex(p), p]));
    return { manifest, blobs, whole };
  }

  function restoring(
    h: ReturnType<typeof head> | null,
    over: Parameters<typeof setup>[0] = {},
  ) {
    return setup({
      capture: true,
      nextMessage: withSession(),
      readHead: async () =>
        h === null
          ? { ok: true, head: { found: false, reason: "none" } }
          : {
              ok: true,
              head: { found: true, manifest: h.manifest, version: 5 },
            },
      readBlob: async (sha) => {
        const bytes = h?.blobs.get(sha);
        return bytes
          ? { ok: true, bytes }
          : { ok: false, code: "not_found", status: 404 };
      },
      ...over,
    });
  }

  /** The message file the daemon was handed. */
  const sentMessage = (s: ReturnType<typeof setup>) => {
    const f = s.files.find((x) => x.path.includes("/msg-"));
    return JSON.parse(f?.text ?? "{}") as {
      sessionId: string | null;
      prompt: string;
    };
  };
  const restoreLogs = (s: { logs: string[] }) =>
    s.logs.filter((l) => l.includes("restore"));

  // card: protects=#743 a restore writes the exact checkpointed bytes at the recorded project dir (mode 600, owner agent) BEFORE the message, and the message keeps the session id so the daemon resumes; fails_when=the bytes differ, the path or mode is wrong, the file lands after the message, or the id is dropped; no_claim=a real claude --resume (the OPENSANDBOX_IT and AC-8)
  it("copies the transcript in before the message and keeps the session id", async () => {
    const h = head([turn(1), turn(2), turn(3)]);
    const s = restoring(h);
    await s.executor.run(s.args);
    const written = s.files.find((f) => f.path === PATH);
    expect(written?.text).toBe(h.whole && dec(h.whole));
    expect(written?.opts).toEqual({
      mode: 600,
      owner: "agent",
      group: "agent",
    });
    expect(s.files.findIndex((f) => f.path === PATH)).toBeLessThan(
      s.files.findIndex((f) => f.path.includes("/msg-")),
    );
    expect(sentMessage(s).sessionId).toBe(SID);
    expect(
      s.execs.some((a) => a.join(" ") === `/usr/bin/test -s ${PATH}`),
    ).toBe(true);
    expect(restoreLogs(s).join("\n")).toMatch(
      /cell: session restore: restored turn=3 native=\d+ dir=-workspace in \d+ms/,
    );
  });

  // card: protects=#743 F6: the file goes into the project dir the manifest recorded, and an unsafe recorded dir falls back to -workspace; fails_when=a hard-coded dir or a path-traversing dir is used; no_claim=which dir a real run records
  it("writes into the recorded project dir, and refuses an unsafe one", async () => {
    const good = head([turn(1)], { projectDir: "-home-agent-app" });
    const a = restoring(good);
    await a.executor.run(a.args);
    expect(
      a.files.some((f) => f.path.includes("/projects/-home-agent-app/")),
    ).toBe(true);
    const bad = head([turn(1)], { projectDir: "../../etc" });
    const b = restoring(bad);
    await b.executor.run(b.args);
    expect(b.files.some((f) => f.path === PATH)).toBe(true);
    expect(b.files.some((f) => f.path.includes(".."))).toBe(false);
  });

  // card: protects=#743 AC-2 (OQ-1): a chunk that fails its hash starts fresh, said in the journal and the prompt, and the message never carries the id; fails_when=the id is sent, nothing is logged, or the bad bytes are written; no_claim=the daemon's own fallback
  it("a hash mismatch starts fresh and says so", async () => {
    const h = head([turn(1), turn(2)]);
    const first = [...h.blobs.keys()][0] as string;
    h.blobs.set(first, enc("tampered\n"));
    const s = restoring(h);
    await s.executor.run(s.args);
    expect(sentMessage(s).sessionId).toBeNull();
    expect(sentMessage(s).prompt).toContain("could not be restored");
    expect(s.files.some((f) => f.path === PATH)).toBe(false);
    expect(restoreLogs(s)).toContain(
      "[agent-run thr_1] continuation: restore failed (hash-mismatch), starting fresh",
    );
  });

  // card: protects=#743 AC-2: no head, an unreadable blob, a head error and a copy-in failure each start fresh; fails_when=any of them keeps the session id; no_claim=the route
  it.each([
    ["no head", null, {}, "no-head"],
    ["a missing blob", "blobless", {}, "fetch-error"],
    [
      "a head read error",
      "ok",
      { readHead: async () => ({ ok: false, code: "transport", status: 0 }) },
      "head-error",
    ],
    [
      "a copy-in failure",
      "ok",
      {
        execExit: (argv: string[]) =>
          argv[0] === "/usr/bin/test" && argv[2]?.endsWith(".jsonl") ? 1 : 0,
      },
      "copy-in-failed",
    ],
  ] as const)("%s starts fresh", async (_name, kind, over, cls) => {
    const h = kind === null ? null : head([turn(1)]);
    if (kind === "blobless" && h) h.blobs.clear();
    const s = restoring(h, over as never);
    await s.executor.run(s.args);
    expect(sentMessage(s).sessionId).toBeNull();
    expect(restoreLogs(s)).toContain(
      `[agent-run thr_1] continuation: restore failed (${cls}), starting fresh`,
    );
  });

  it("a session id that is not a UUID is never turned into a path", async () => {
    const s = restoring(head([turn(1)]), { nextMessage: withSession("../x") });
    await s.executor.run(s.args);
    expect(sentMessage(s).sessionId).toBeNull();
    expect(s.files.some((f) => f.path.includes(".."))).toBe(false);
  });

  // card: protects=#743 A-12: a restore fetches at most 8 chunks at once; fails_when=more than 8 reads overlap or the reads are serial; no_claim=real network timing
  it("fetches at most 8 chunks at a time", async () => {
    const h = head(Array.from({ length: 20 }, (_, i) => turn(i)));
    let inFlight = 0;
    let peak = 0;
    const s = restoring(h, {
      readBlob: async (sha) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await flush();
        inFlight -= 1;
        return { ok: true, bytes: h.blobs.get(sha) };
      },
    });
    await s.executor.run(s.args);
    expect(peak).toBe(8);
    expect(sentMessage(s).sessionId).toBe(SID);
  });

  // card: protects=#743 phase 6 limitation resolved: after a restore the capture continues the restored chain (parent = restored head, expected version = its version, only the new turn uploaded), not from version 0; fails_when=the next commit expects 0, has no parent, or re-uploads the restored turns; no_claim=a real second cell
  it("the capture continues the restored chain", async () => {
    const h = head([turn(1)]);
    const s = restoring(h, {
      execStdout: (argv) =>
        isCaptureProbe(argv)
          ? `${enc(turn(1) + turn(2)).length} 1700000000.5 -workspace/${SID}.jsonl\n`
          : isRegularFileCheck(argv)
            ? `${PATH}\n`
            : "",
      pollUntilTerminal: async () => {
        await s.captureTick();
        return { outcome: "completed", finalStatus: "complete" };
      },
    });
    s.provider.copyOut.mockImplementation(async () => enc(turn(1) + turn(2)));
    await s.executor.run(s.args);
    expect(s.checkpoint.commits).toHaveLength(1);
    const commit = s.checkpoint.commits[0] as unknown as {
      manifest: { turn: number; parent: string };
      expected: number;
    };
    expect(commit.expected).toBe(5);
    expect(commit.manifest.parent).toBe(h.manifest.id);
    expect(commit.manifest.turn).toBe(2);
    expect(s.checkpoint.puts.some((p) => p.text.includes("answer 2"))).toBe(
      true,
    );
    expect(s.checkpoint.puts.some((p) => p.text.includes("answer 1"))).toBe(
      false,
    );
  });

  // card: protects=#743 the restore is off by default and when its reads are unwired: the message passes through untouched, no read, no copy-in; fails_when=a session id is dropped or a file is written with the gate off; no_claim=the flag itself (phase 11)
  it("is off by default", async () => {
    let reads = 0;
    const h = head([turn(1)]);
    const s = setup({
      nextMessage: withSession(),
      readHead: async () => {
        reads += 1;
        return {
          ok: true,
          head: { found: true, manifest: h.manifest, version: 1 },
        };
      },
      readBlob: async () => ({ ok: false, code: "x", status: 500 }),
    });
    await s.executor.run(s.args);
    expect(reads).toBe(0);
    expect(sentMessage(s).sessionId).toBe(SID);
    expect(s.files.some((f) => f.path === PATH)).toBe(false);
    expect(restoreLogs(s)).toEqual([]);

    const unwired = setup({ capture: true, nextMessage: withSession() });
    await unwired.executor.run(unwired.args);
    expect(sentMessage(unwired).sessionId).toBe(SID);
    expect(unwired.files.some((f) => f.path === PATH)).toBe(false);

    const noId = restoring(h, { nextMessage: withSession(null) });
    await noId.executor.run(noId.args);
    expect(noId.files.some((f) => f.path === PATH)).toBe(false);
    expect(sentMessage(noId).sessionId).toBeNull();
  });
});
