import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadWorkerConfig, type WorkerConfig } from "./config";
import { assertHardenedArgv } from "./container-argv";
import {
  ContainerDaemonProcess,
  handOverRunDir,
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

  // card: protects=teardown reads the OOM flag, rm -f -v's the container, confirms it is gone, kills the attach child and is idempotent (one removal for many callers); fails_when=a second teardown removes again or the slot could be released before the container is gone; no_claim=the 10 s bound on a real daemon (integration suite)
  it("teardown: inspect → rm → confirm gone, once", async () => {
    const rt = fakeRuntime();
    const d = make("pr", rt);
    await d.start();
    rt.calls.length = 0;
    await Promise.all([d.teardown(), d.teardown()]);
    await d.teardown();
    expect(rt.calls).toEqual([
      "inspect",
      `remove ${"c".repeat(64)}`,
      "inspect",
    ]);
    expect(rt.child.killed).toEqual(["SIGKILL"]);
  });

  // card: protects=a container that survives `docker rm -f` makes teardown REJECT, so the workflow cannot release the slot over it (ADR-013 I6); fails_when=teardown resolves; no_claim=how the workflow surfaces the rejection
  it("teardown rejects when the container is still there", async () => {
    const rt = fakeRuntime({ stillThere: true });
    const d = make("task", rt);
    await d.start();
    await expect(d.teardown()).rejects.toThrow(/still exists/);
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

describe("handOverRunDir (ADR-013 run-dir hand-over)", () => {
  // card: protects=each bind-mounted dir is chgrp'd to the hand-over gid, made group-rw and setgid on dirs; fails_when=a step is skipped or applied to another path; no_claim=that the rootless mapping grants access (box P0 step)
  it("chgrp -R, chmod -R g+rwX, setgid dirs", async () => {
    const calls: string[] = [];
    await handOverRunDir({
      dirs: ["/runs/r/repo"],
      gid: 1001,
      exec: async (f, a) => {
        calls.push([f, ...a].join(" "));
      },
    });
    expect(calls).toEqual([
      "chgrp -R 1001 /runs/r/repo",
      "chmod -R g+rwX /runs/r/repo",
      "find /runs/r/repo -type d -exec chmod g+s {} +",
    ]);
  });
});
