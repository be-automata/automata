import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadWorkerConfig, type WorkerConfig } from "./config";
import { assertHardenedArgv } from "./container-argv";
import {
  ContainerDaemonProcess,
  handOverRunDir,
  settleDaemonTeardown,
} from "./container-daemon-process";
import type { ContainerRuntime, ContainerState } from "./container-runtime";
/** The terminal OOM failure (resourceLimitFailure: a NonRetryableError carrying the ResourceLimitError text). */
const OOM = /Out of memory: 1 process\(es\) killed by the per-run memory limit/;
import { runPaths, type RunPaths } from "./run-owned-paths";
import type { RunLane } from "./run-lane";
import type { AgentRunInput } from "./types";

const IMAGE = `ghcr.io/be-automata/automata-batteries@sha256:${"ef".repeat(32)}`;

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 31337;
  killed: string[] = [];
  kill(sig: string) {
    this.killed.push(sig);
    return true;
  }
  exit(code: number | null, signal: string | null = null) {
    this.emit("exit", code, signal);
  }
}

/** Every file under `dir`, relative path → content (read at call time). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

function fakeRuntime(
  opts: { state?: () => ContainerState | null; stillThere?: boolean } = {},
) {
  const calls: string[] = [];
  const copied: Record<string, string>[] = [];
  let created: readonly string[] = [];
  const child = new FakeChild();
  let removed = false;
  const rt = {
    calls,
    copied,
    child,
    get createdArgv() {
      return created;
    },
    remove: vi.fn(async (id: string) => {
      calls.push(`remove ${id}`);
      if (id.length === 64) removed = true;
      return id.length === 64;
    }),
    create: vi.fn(async (argv: readonly string[]) => {
      calls.push("create");
      created = argv;
      return "c".repeat(64);
    }),
    copyOut: vi.fn(async (_id: string, src: string, destDir: string) => {
      calls.push(`copyOut ${src}`);
      fs.writeFileSync(
        path.join(destDir, "settings.batteries.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "gsd" }] }],
          },
        }),
      );
      return true;
    }),
    copyIn: vi.fn(async (_id: string, src: string, dest: string) => {
      calls.push(`copyIn ${dest}`);
      copied.push(snapshot(src));
    }),
    exec: vi.fn(async (_id: string, argv: readonly string[]) => {
      calls.push(`exec ${argv.join(" ")}`);
      return { code: 0, stdout: "", stderr: "" };
    }),
    startAttached: vi.fn(() => {
      calls.push("start");
      return child as never;
    }),
    inspectState: vi.fn(async () => {
      calls.push("inspect");
      if (removed && !opts.stillThere) return null;
      return (
        opts.state?.() ?? {
          status: "running",
          running: true,
          exitCode: 0,
          oomKilled: false,
        }
      );
    }),
  };
  return rt;
}

describe("ContainerDaemonProcess (ADR-013 Run path 2-7, fake runtime)", () => {
  let root: string;
  let run: RunPaths;
  let config: WorkerConfig;
  const input = {
    threadId: "thr_test1",
    threadChatId: "chat_1",
    repoFullName: "acme/app",
    daemonCallbackUrl: "https://www.example.test",
  } as unknown as AgentRunInput;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-"));
    run = runPaths(path.join(root, "thr_test1"));
    fs.mkdirSync(run.repo, { recursive: true });
    fs.writeFileSync(path.join(run.repo, "tsconfig.json"), "{}");
    fs.mkdirSync(run.home, { recursive: true });
    fs.writeFileSync(
      path.join(run.home, ".claude.json"),
      '{"projects":{"/workspace":{}}}',
    );
    fs.writeFileSync(path.join(root, "daemon.js"), "");
    config = {
      ...loadWorkerConfig({
        WORKER_PAYLOAD_SEAL_KEY_FILE: "/nonexistent",
        WORKER_DEV_CONTAINER_RUNS: "1",
        WORKER_BATTERIES_IMAGE: IMAGE,
        WORKER_RUN_MEMORY_MAX: "2G",
        WORKER_DAEMON_DIST: path.join(root, "daemon.js"),
        ANTHROPIC_API_KEY: "sk-ant-box",
        WORKER_BOX_ID: "box-t",
      }),
      boxSlot: 0,
    };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function make(lane: RunLane, rt: ReturnType<typeof fakeRuntime>, over = {}) {
    return new ContainerDaemonProcess(
      config,
      input,
      run,
      { home: run.home, delivered: false, env: {} },
      lane,
      {
        secrets: { daemonToken: "daemon-token-secret" },
        runtime: rt as unknown as ContainerRuntime,
        probeSocket: async () => {},
        log: () => {},
        boxTestServicesEnvPath: path.join(root, "absent.env"),
        ...over,
      },
    );
  }

  // card: protects=start removes the slot's predecessor by name BEFORE creating, creates with a hardened argv, copies the policy in BEFORE start, then attaches; fails_when=the order changes (a predecessor meets its successor, or the run starts without its policy); no_claim=real daemon behaviour (integration suite)
  it("start: predecessor removed, hardened create, copy-in, then start", async () => {
    const rt = fakeRuntime();
    const d = make("task", rt);
    await d.start();
    expect(rt.calls).toEqual([
      `remove automata-run-${(rt.createdArgv[rt.createdArgv.indexOf("--name") + 1] ?? "").slice("automata-run-".length)}`,
      "create",
      "copyOut /home/agent/.claude/settings.batteries.json",
      "copyIn /home/agent",
      "start",
    ]);
    expect(() =>
      assertHardenedArgv(rt.createdArgv, {
        image: config.containerRuns!.image,
        runDir: run.runDir,
        daemonBundleHostPath: config.daemonDist,
        limits: {
          memoryBytes: 2 * 1024 ** 3,
          pidsLimit: config.tasksMax,
          cpus: 2,
          tmpBytes: 1,
          shmBytes: 1,
        },
      }),
    ).not.toThrow();
    expect(rt.createdArgv).toContain("AUTOMATA_SOMNIO_STACKS=typescript");
    expect(d.spawnedLine()).toContain(config.containerRuns!.image.digest);
  });

  // card: protects=the copy-in carries trust seed, composed settings (task: batteries hooks + guard) and the run env file with the box key — and the env file leaves the host staging dir right after the copy; the daemon token is never in it; fails_when=a policy file is missing, the token/env file lingers on the host, or the daemon token is copied; no_claim=docker cp ownership (integration suite)
  it("task copy-in: settings, env file (no daemon token), env file wiped from the host", async () => {
    const rt = fakeRuntime();
    await make("task", rt).start();
    const files = rt.copied[0] ?? {};
    expect(Object.keys(files).sort()).toEqual([
      ".automata-run/run.env",
      ".claude.json",
      ".claude/settings.json",
    ]);
    const settings = JSON.parse(files[".claude/settings.json"] ?? "{}");
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.PreToolUse.length).toBeGreaterThan(0);
    expect(files[".automata-run/run.env"]).toContain(
      "export ANTHROPIC_API_KEY='sk-ant-box'",
    );
    expect(JSON.stringify(files)).not.toContain("daemon-token-secret");
    expect(fs.existsSync(path.join(run.home, ".automata-run"))).toBe(false);
  });

  // card: protects=a review container gets deny-only settings, no batteries copy-out, and an env file with no GitHub credential; fails_when=a review gets hooks or a token; no_claim=C3 sockets (none exist yet)
  it("review copy-in: denies only, no batteries hooks, no GitHub credential", async () => {
    const rt = fakeRuntime();
    await make("review", rt).start();
    expect(rt.copyOut).not.toHaveBeenCalled();
    const files = rt.copied[0] ?? {};
    expect(JSON.parse(files[".claude/settings.json"] ?? "{}")).toEqual({
      permissions: { deny: expect.arrayContaining(["Skill(cso)"]) },
    });
    expect(files[".automata-run/run.env"]).not.toMatch(
      /GH_TOKEN|GITHUB_TOKEN|Authorization/,
    );
    expect(rt.createdArgv).toContain("automata.lane=review");
  });

  // card: protects=a container that exits before its socket is ready fails start with the cause, and an OOM-killed one is a ResourceLimitError; fails_when=start hangs to the timeout or misattributes an OOM; no_claim=the kernel's OOM decision
  it("start fails fast on an early exit, attributing an OOM", async () => {
    const rt = fakeRuntime({
      state: () => ({
        status: "exited",
        running: false,
        exitCode: 137,
        oomKilled: true,
      }),
    });
    const d = make("task", rt, {
      probeSocket: () => {
        rt.child.exit(137);
        return Promise.reject(new Error("ENOENT"));
      },
    });
    await expect(d.start()).rejects.toThrow(OOM);
  });

  // card: protects=teardown hands the workspace back (the container's own user opens it to the group) BEFORE it reads the OOM flag, rm -f -v's the container, confirms it is gone, kills the attach child, and is idempotent (one removal for many callers); fails_when=the hand-back runs after removal, a second teardown removes again, or the slot could be released before the container is gone; no_claim=the 10 s bound on a real daemon (integration suite)
  it("teardown: hand back → inspect → rm → confirm gone, once", async () => {
    const rt = fakeRuntime();
    const d = make("pr", rt);
    await d.start();
    rt.calls.length = 0;
    await Promise.all([d.teardown(), d.teardown()]);
    await d.teardown();
    expect(rt.calls).toEqual([
      "inspect",
      "exec find /workspace -user 10001 -exec chmod g+rwX {} +",
      "inspect",
      `remove ${"c".repeat(64)}`,
      "inspect",
    ]);
    expect(rt.child.killed).toEqual(["SIGKILL"]);
  });

  // card: protects=a stopped container is not exec'd (it cannot be) and the skip is logged; removal still happens; fails_when=teardown execs a stopped container or the skip is silent; no_claim=cleanup of what the stopped run left (cleanupWorkdir logs it)
  it("teardown: a stopped container skips the hand-back, logged, and is still removed", async () => {
    const lines: string[] = [];
    const rt = fakeRuntime({
      state: () => ({
        status: "exited",
        running: false,
        exitCode: 137,
        oomKilled: true,
      }),
    });
    const d = make("task", rt, { log: (l: string) => lines.push(l) });
    await d.start();
    rt.calls.length = 0;
    await d.teardown();
    expect(rt.exec).not.toHaveBeenCalled();
    expect(rt.calls).toContain(`remove ${"c".repeat(64)}`);
    expect(lines.join("\n")).toMatch(
      /container\.workspace_handback .*"skipped":"not running"/,
    );
  });

  // card: protects=a failing or throwing hand-back never blocks the removal (the slot must be released); fails_when=an exec error propagates out of teardown or skips the rm; no_claim=why the exec failed
  it("teardown: a failed hand-back is logged and the container is still removed", async () => {
    const lines: string[] = [];
    const rt = fakeRuntime();
    rt.exec.mockRejectedValueOnce(new Error("exec timed out"));
    const d = make("task", rt, { log: (l: string) => lines.push(l) });
    await d.start();
    rt.calls.length = 0;
    await d.teardown();
    expect(rt.calls).toContain(`remove ${"c".repeat(64)}`);
    expect(lines.join("\n")).toMatch(
      /container\.workspace_handback .*"error":"exec timed out"/,
    );
  });

  // card: protects=a transient `docker rm` failure is retried while the slot is still held, and teardown resolves once the container is confirmed gone; fails_when=one failed rm rejects the teardown (a leaked container) or the retry skips the confirm; no_claim=real daemon error shapes
  it("teardown retries a failing docker rm, then confirms the container is gone", async () => {
    const rt = fakeRuntime();
    const d = make("task", rt, { retryDelayMs: 1 });
    await d.start();
    rt.remove.mockClear();
    const realRemove = rt.remove.getMockImplementation();
    let failures = 2;
    rt.remove.mockImplementation(async (id: string) => {
      if (failures-- > 0) throw new Error("docker rm: daemon busy");
      return realRemove!(id);
    });
    await expect(d.teardown()).resolves.toBeUndefined();
    expect(rt.remove).toHaveBeenCalledTimes(3);
  });

  // card: protects=a `docker rm` that never succeeds ends in a REJECTION after a bounded number of attempts, so the caller can log it and let the slot go (never held forever); fails_when=teardown retries without bound or resolves over a live container; no_claim=the workflow's handling (workflow.ts)
  it("teardown gives up after a bounded number of attempts", async () => {
    const rt = fakeRuntime({ stillThere: true });
    const d = make("task", rt, { retryDelayMs: 1, removeAttempts: 3 });
    await d.start();
    rt.remove.mockClear();
    await expect(d.teardown()).rejects.toThrow(/still exists/);
    expect(rt.remove).toHaveBeenCalledTimes(3);
    expect(rt.child.killed).toEqual(["SIGKILL"]);
  });

  // card: protects=a `docker create` that failed or timed out AFTER the daemon made the container (no id came back) is still removed, by the slot's name; fails_when=teardown removes nothing when the id is unknown; no_claim=which daemon errors leave a container behind
  it("teardown removes by slot name when create returned no id", async () => {
    const rt = fakeRuntime();
    rt.create.mockImplementation(async () => {
      rt.calls.push("create");
      throw new Error("docker create timed out");
    });
    const d = make("task", rt);
    await expect(d.start()).rejects.toThrow(/timed out/);
    rt.remove.mockClear();
    rt.inspectState.mockResolvedValue(null);
    await d.teardown();
    expect(rt.remove).toHaveBeenCalledWith(
      expect.stringMatching(/^automata-run-w-\d+-[0-9a-f]+-0$/),
    );
  });

  // card: protects=teardown before start ever ran touches no container (nothing could exist); fails_when=it removes by name for a run that never tried to create; no_claim=-
  it("teardown before start removes nothing", async () => {
    const rt = fakeRuntime();
    const d = make("task", rt);
    await d.teardown();
    expect(rt.remove).not.toHaveBeenCalled();
  });

  // card: protects=mid-run: a clean exit 0 is not a failure, a SIGKILL'd exit with OOMKilled is a ResourceLimitError, and a child OOM while the container lives is memory starvation; fails_when=a good run fails or an OOM goes unattributed; no_claim=Docker's OOM event timing
  it("agentFailure / memoryStarvation read the container's exit and OOM flag", async () => {
    let oom = false;
    const rt = fakeRuntime({
      state: () => ({
        status: "running",
        running: true,
        exitCode: 0,
        oomKilled: oom,
      }),
    });
    const d = make("task", rt);
    await d.start();
    expect(d.agentFailure()).toBeNull();
    oom = true;
    d.memoryStarvation();
    await vi.waitFor(() => expect(String(d.memoryStarvation())).toMatch(OOM));
    rt.child.exit(137);
    await vi.waitFor(() => expect(String(d.agentFailure())).toMatch(OOM));
  });
});

describe("ContainerDaemonProcess C3 forwards (#430)", () => {
  // Short root: unix socket paths are capped at ~104 bytes (macOS).
  let root: string;
  let run: RunPaths;
  let config: WorkerConfig;
  let proxy: net.Server;
  let gh: net.Server;
  let proxyPort: number;
  const input = {
    threadId: "thr_c3",
    threadChatId: "chat_1",
    repoFullName: "acme/app",
    daemonCallbackUrl: "https://www.example.test",
  } as unknown as AgentRunInput;

  const listen = async (
    tag: string,
    bind: (s: net.Server, done: () => void) => void,
  ): Promise<net.Server> => {
    const s = net.createServer((sock) => {
      sock.on("data", (d) => sock.write(`${tag}:${d.toString()}`));
      sock.on("error", () => {});
    });
    await new Promise<void>((r) => bind(s, r));
    return s;
  };
  const ask = (socketPath: string, msg: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const c = net.createConnection(socketPath);
      c.once("error", reject);
      c.once("data", (d) => {
        c.end();
        resolve(d.toString());
      });
      c.write(msg);
    });

  beforeEach(async () => {
    root = fs.mkdtempSync("/tmp/c3d-");
    run = runPaths(path.join(root, "r"));
    fs.mkdirSync(run.repo, { recursive: true });
    fs.mkdirSync(run.home, { recursive: true });
    fs.writeFileSync(path.join(root, "daemon.js"), "");
    proxy = await listen("proxy", (s, d) => s.listen(0, "127.0.0.1", d));
    proxyPort = (proxy.address() as net.AddressInfo).port;
    gh = await listen("gh", (s, d) => s.listen(path.join(root, "gh.sock"), d));
    config = {
      ...loadWorkerConfig({
        WORKER_PAYLOAD_SEAL_KEY_FILE: "/nonexistent",
        WORKER_DEV_CONTAINER_RUNS: "1",
        WORKER_BATTERIES_IMAGE: IMAGE,
        WORKER_RUN_MEMORY_MAX: "2G",
        WORKER_DAEMON_DIST: path.join(root, "daemon.js"),
        ANTHROPIC_API_KEY: "sk-ant-box",
        WORKER_BOX_ID: "box-t",
      }),
      boxSlot: 0,
    };
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => gh.close(() => r()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  function make(lane: RunLane, rt: ReturnType<typeof fakeRuntime>, over = {}) {
    return new ContainerDaemonProcess(
      config,
      input,
      run,
      { home: run.home, delivered: false, env: {} },
      lane,
      {
        secrets: { daemonToken: "daemon-token-secret" },
        runtime: rt as unknown as ContainerRuntime,
        probeSocket: async () => {},
        log: () => {},
        boxTestServicesEnvPath: path.join(root, "absent.env"),
        egressProxyUrl: `http://run:proxy-secret@127.0.0.1:${proxyPort}`,
        broker: {
          gitUrl: `http://127.0.0.1:${proxyPort}`,
          ghSocketPath: path.join(root, "gh.sock"),
          bearer: "run-bearer",
          repoFullName: "acme/app",
        },
        ...over,
      },
    );
  }

  /** The sock/ entries present when `docker create` ran (the entry bridges only those). */
  function socketsAtCreate(rt: ReturnType<typeof fakeRuntime>): () => string[] {
    let seen: string[] = [];
    const create = rt.create.getMockImplementation();
    rt.create.mockImplementation(async (argv: readonly string[]) => {
      seen = fs.readdirSync(path.join(run.runDir, "sock")).sort();
      return create!(argv);
    });
    return () => seen;
  }

  // card: protects=a task container gets the proxy, git and gh broker sockets BEFORE create, each forwarding to its host listener, and an env that points at the entry's loopback ports (proxy credential kept) plus a gh config naming the mounted socket; teardown closes every forward; fails_when=a socket is missing at create, forwards elsewhere, the env names a host address, or a forward outlives teardown; no_claim=the in-container socat bridge and real brokers (box proof)
  it("task: proxy + git + gh forwarded, env on the bridge ports, closed at teardown", async () => {
    const rt = fakeRuntime();
    const seen = socketsAtCreate(rt);
    const d = make("task", rt);
    await d.start();
    expect(seen()).toEqual([
      "egress-proxy.sock",
      "gh-broker.sock",
      "git-broker.sock",
    ]);
    const sock = (n: string) => path.join(run.runDir, "sock", n);
    expect(await ask(sock("egress-proxy.sock"), "a")).toBe("proxy:a");
    expect(await ask(sock("git-broker.sock"), "b")).toBe("proxy:b");
    expect(await ask(sock("gh-broker.sock"), "c")).toBe("gh:c");
    const files = rt.copied[0] ?? {};
    const env = files[".automata-run/run.env"] ?? "";
    expect(env).toContain(
      "export HTTPS_PROXY='http://run:proxy-secret@127.0.0.1:3128'",
    );
    expect(env).toContain("export AUTOMATA_DAEMON_CALLBACK_VIA_PROXY='1'");
    expect(env).toContain("url.http://127.0.0.1:3129/.insteadOf");
    expect(env).toMatch(/GIT_CONFIG_KEY_\d+='http\.proxyAuthMethod'/);
    expect(env).toContain("export GH_TOKEN='run-bearer'");
    expect(env).not.toContain(String(proxyPort));
    expect(files[".config/gh/config.yml"]).toBe(
      "version: 1\nhttp_unix_socket: /run/automata/gh-broker.sock\n",
    );
    await d.teardown();
    await expect(ask(sock("egress-proxy.sock"), "x")).rejects.toThrow();
  });

  // card: protects=a review container gets the egress proxy only — no git or gh broker socket and no GitHub credential, even when the workflow passes a broker; fails_when=a broker socket or bearer reaches a review; no_claim=the daemon-side review strip (host path)
  it("review: proxy only, no broker socket, no credential", async () => {
    const rt = fakeRuntime();
    const seen = socketsAtCreate(rt);
    await make("review", rt).start();
    expect(seen()).toEqual(["egress-proxy.sock"]);
    const files = rt.copied[0] ?? {};
    expect(files[".automata-run/run.env"]).not.toMatch(
      /GH_TOKEN|GITHUB_TOKEN|Authorization|3129/,
    );
    expect(files[".config/gh/config.yml"]).toBeUndefined();
  });

  // card: protects=no proxy URL means no proxy socket and no proxy env (a container with no route out, never a silent direct one); fails_when=a socket or HTTPS_PROXY appears without a proxy; no_claim=that the workflow always passes one (workflow wiring)
  it("no proxy: no egress socket, no proxy env", async () => {
    const rt = fakeRuntime();
    const seen = socketsAtCreate(rt);
    await make("task", rt, { egressProxyUrl: null, broker: null }).start();
    expect(seen()).toEqual([]);
    expect(rt.copied[0]?.[".automata-run/run.env"] ?? "").not.toMatch(
      /HTTPS_PROXY|CALLBACK_VIA_PROXY/,
    );
  });

  // card: protects=an opted-in repo's test Postgres is forwarded and its URL rewritten to the entry's 25432 bridge, credentials kept; fails_when=the container gets the host address or no socket; no_claim=the box's Postgres itself
  it("test Postgres: opted-in repo gets the socket and a bridge URL", async () => {
    const pg = await listen("pg", (s, d) => s.listen(0, "127.0.0.1", d));
    const pgPort = (pg.address() as net.AddressInfo).port;
    const envPath = path.join(root, "test-services.env");
    fs.writeFileSync(
      envPath,
      `TEST_SERVICES_REPOS=acme/app\nTEST_DATABASE_ADMIN_URL=postgresql://agent:pw@127.0.0.1:${pgPort}/postgres\n`,
      { mode: 0o600 },
    );
    try {
      const rt = fakeRuntime();
      const seen = socketsAtCreate(rt);
      await make("task", rt, { boxTestServicesEnvPath: envPath }).start();
      expect(seen()).toContain("test-postgres.sock");
      expect(
        await ask(path.join(run.runDir, "sock", "test-postgres.sock"), "q"),
      ).toBe("pg:q");
      expect(rt.copied[0]?.[".automata-run/run.env"]).toContain(
        "export TEST_DATABASE_ADMIN_URL='postgresql://agent:pw@127.0.0.1:25432/postgres'",
      );
    } finally {
      await new Promise<void>((r) => pg.close(() => r()));
    }
  });
});

describe("settleDaemonTeardown (the workflow's teardown step)", () => {
  // card: protects=switch OFF: the host daemon's synchronous teardown runs once and NOTHING is returned to await, so the host path's finally keeps its exact ordering; fails_when=a promise (an extra await tick) is returned for the host daemon or teardown is skipped; no_claim=the rest of the finally block
  it("host daemon: teardown runs synchronously, nothing to await", () => {
    let calls = 0;
    const out = settleDaemonTeardown(
      { teardown: () => void calls++ },
      "thr_1",
      () => {},
    );
    expect(out).toBeUndefined();
    expect(calls).toBe(1);
  });

  // card: protects=a container whose removal kept failing is LOGGED and the teardown carries on (brokers, credential wipe and slot release still run), never thrown out of the finally; fails_when=the rejection propagates or goes unlogged; no_claim=the next admission's by-name removal (start() tests)
  it("container daemon: a failed removal is logged, never thrown", async () => {
    const lines: string[] = [];
    const out = settleDaemonTeardown(
      { teardown: () => Promise.reject(new Error("rm kept failing")) },
      "thr_1",
      (l) => lines.push(l),
    );
    await expect(out).resolves.toBeUndefined();
    expect(lines).toEqual([
      expect.stringMatching(
        /^container\.teardown_failed .*"thread":"thr_1".*rm kept failing/,
      ),
    ]);
  });
});

describe("handOverRunDir (ADR-013 run-dir hand-over)", () => {
  // card: protects=the run dir gets group search only, and each bind-mounted dir is chgrp'd to the hand-over gid, made group-rw and setgid on dirs; fails_when=a step is skipped, the run dir is opened recursively or for read, or a step hits another path; no_claim=that the rootless mapping grants access (box P0 step)
  it("run dir g=x only; bind dirs chgrp -R, chmod -R g+rwX, setgid dirs", async () => {
    const calls: string[] = [];
    await handOverRunDir({
      runDir: "/runs/r",
      dirs: ["/runs/r/repo"],
      gid: 1001,
      exec: async (f, a) => {
        calls.push([f, ...a].join(" "));
      },
    });
    expect(calls).toEqual([
      "chgrp 1001 /runs/r",
      "chmod g=x /runs/r",
      "chgrp -R 1001 /runs/r/repo",
      "chmod -R g+rwX /runs/r/repo",
      "find /runs/r/repo -type d -exec chmod g+s {} +",
    ]);
  });
});
