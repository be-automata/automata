import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Client } from "pg";
import {
  APIContracts,
  type Hatchet,
  type Worker,
} from "@hatchet-dev/typescript-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { materialiseAgentCredentials } from "./agent-credentials";
import { acquireBoxSlot } from "./box-lock";
import { configForSlot, loadWorkerConfig, type WorkerConfig } from "./config";
import { CONTAINER_WORKSPACE } from "./container-argv";
import { ContainerDaemonProcess } from "./container-daemon-process";
import { ContainerRuntime } from "./container-runtime";
import { AGENT_RUN_VARIANTS, buildAgentRunDefinition } from "./definition";
import {
  REST,
  bootstrapTenant,
  composeDownV,
  composeUp,
  connectPg,
  pollUntil,
} from "./hatchet-it-harness";
import { resolveRunLane, type RunLane } from "./run-lane";
import { runPaths } from "./run-owned-paths";
import { guardRunTerminal } from "./run-terminal-ledger";
import type { AgentRunInput } from "./types";

/**
 * ADR-013 C2 (#429): agent-run containers from the REAL batteries image,
 * dispatched through a REAL hatchet-lite engine (HATCHET_IT=1) on the shipped
 * agent-run definitions, under the real box lock (3 slots) and the real #386
 * terminal ledger, created/started/removed by the real runtime adapter with
 * the real hardened argv and copy-in.
 *
 * What stands in: the DAEMON. The container's entry runs the real entry step
 * (env file, Somnio rules install with the image's own CLI, git exclude) and
 * then execs a stand-in that records evidence from INSIDE the container and
 * binds the daemon socket. The real daemon needs the control plane, which a
 * `--network none` container reaches only through C3's bridges (#430).
 *
 * Gated: HATCHET_IT=1 AND CONTAINER_IT_IMAGE=<repo>@sha256:<digest> (the image
 * must already be in the daemon's store: the run path never pulls). The socket
 * is CONTAINER_IT_SOCKET (default /var/run/docker.sock); CONTAINER_IT_RUN_GID
 * turns on the run-dir hand-over (WORKER_CONTAINER_RUN_GID). Skipped otherwise, so
 * CI's worker suite stays image-free.
 */

const Status = APIContracts.V1TaskStatus;
type Status = APIContracts.V1TaskStatus;
const TERMINAL: Status[] = [Status.COMPLETED, Status.CANCELLED, Status.FAILED];

const IMAGE = process.env.CONTAINER_IT_IMAGE ?? "";
const SOCKET = process.env.CONTAINER_IT_SOCKET || "/var/run/docker.sock";
const itEnabled = process.env.HATCHET_IT === "1" && IMAGE !== "";
const execFileAsync = promisify(execFile);

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

type Mode = "complete" | "hold" | "oom" | "fork";
type CitInput = {
  threadId: string;
  threadChatId: string;
  repoFullName: string;
  daemonCallbackUrl: string;
  orgId: string;
  deliveryId: string;
  mode: Mode;
  small?: boolean;
  prKey?: string;
  supersedePolicy?: "newest-wins";
  prNumber?: number;
};

/** Everything one run's task fn observed, keyed by thread id. */
interface Record_ {
  attempts: number;
  creates: number;
  lane?: RunLane;
  slot?: number;
  containerId?: string;
  name?: string;
  inspect?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  forks?: number;
  abortAt?: number;
  removedAt?: number;
  exit?: { code: number | null; signal: string | null } | null;
  oomKilled?: boolean;
  error?: string;
  refused?: string;
}

/**
 * The stand-in daemon: evidence from inside the container, then the daemon
 * socket (and a ready marker: a unix socket on a macOS bind mount is not
 * connectable from the host), then the mode's behaviour.
 */
const STANDIN = String.raw`set -u
mode="$1"
cat >/tmp/ev.js <<'JS'
const fs = require("fs"), cp = require("child_process");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const status = read("/proc/self/status") || "";
const field = (k) => (status.match(new RegExp("^" + k + ":\\s*(\\S+)", "m")) || [])[1];
const tryWrite = (p) => { try { fs.writeFileSync(p, "x"); fs.unlinkSync(p); return "ok"; } catch (e) { return e.code; } };
const sh = (c) => { try { return cp.execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return "ERR:" + e.status; } };
const home = process.env.HOME;
const ev = {
  uid: process.getuid(), groups: process.getgroups(),
  capEff: field("CapEff"), capBnd: field("CapBnd"), noNewPrivs: field("NoNewPrivs"),
  netIfaces: (read("/proc/net/dev") || "").split("\n").slice(2).map((l) => l.split(":")[0].trim()).filter(Boolean),
  rootfsWrite: tryWrite("/usr/local/it-probe"),
  workspaceWrite: tryWrite("/workspace/.it-probe"),
  homeWrite: tryWrite(home + "/.it-probe"),
  runAutomata: fs.readdirSync("/run/automata").sort(),
  env: {
    lane: process.env.AUTOMATA_RUN_LANE, home,
    hasGhToken: "GH_TOKEN" in process.env, hasGithubToken: "GITHUB_TOKEN" in process.env,
    anthropicKey: process.env.ANTHROPIC_API_KEY || null,
    stacks: process.env.AUTOMATA_SOMNIO_STACKS,
    daemonToken: Object.values(process.env).some((v) => v === "it-daemon-token-secret"),
  },
  runEnvFileLeft: fs.existsSync(home + "/.automata-run/run.env"),
  settings: JSON.parse(read(home + "/.claude/settings.json") || "null"),
  claudeJson: JSON.parse(read(home + "/.claude.json") || "null"),
  skills: fs.readdirSync(home + "/.claude/skills").length,
  gitStatus: sh("git -C /workspace status --porcelain"),
  exclude: read("/workspace/.git/info/exclude"),
  claudeMd: read("/workspace/CLAUDE.md"),
  rulesDir: fs.existsSync("/workspace/.claude/rules"),
  pid1: (read("/proc/1/cmdline") || "").split("\0")[0],
};
fs.writeFileSync("/run/automata/evidence.tmp", JSON.stringify(ev));
fs.renameSync("/run/automata/evidence.tmp", "/run/automata/evidence.json");
JS
node /tmp/ev.js
node -e 'require("net").createServer((s) => s.end()).listen("/run/automata/daemon.sock", () => require("fs").writeFileSync("/run/automata/daemon.ready", ""))' &
# Act only once the worker side can have seen readiness (its probe polls 200 ms).
until [ -e /run/automata/daemon.ready ]; do sleep 0.1; done
sleep 2
case "$mode" in
  complete) sleep 3; exit 0 ;;
  hold) sleep 600 ;;
  oom) python3 -c 'b = bytearray(1024 * 1024 * 1024)'; exit $? ;;
  fork) python3 - <<'PY'
import os, time
n = 0
for _ in range(300):
    try:
        pid = os.fork()
    except OSError:
        break
    if pid == 0:
        time.sleep(60)
        os._exit(0)
    n += 1
open("/run/automata/forks", "w").write(str(n))
PY
    exit 0 ;;
esac
`;

describe.skipIf(!itEnabled)(
  "ADR-013 C2: container runs from the real image against hatchet-lite (HATCHET_IT=1, CONTAINER_IT_IMAGE)",
  () => {
    let pg: Client;
    let tenantId = "";
    let token = "";
    let hatchet: Hatchet;
    let worker: Worker;
    let root = "";
    let fixture = "";
    let baseConfig: WorkerConfig;
    let smallConfig: WorkerConfig;
    const records = new Map<string, Record_>();
    const sfx = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const LEGACY = `cit-legacy-${sfx}`;
    const NEWEST = `cit-newest-${sfx}`;
    const runtime = new ContainerRuntime({ socketPath: SOCKET });
    const uid = (p: string) =>
      `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    const recordFor = (threadId: string): Record_ => {
      let r = records.get(threadId);
      if (!r) {
        r = { attempts: 0, creates: 0 };
        records.set(threadId, r);
      }
      return r;
    };

    /** The run fn: the container-path slice of runAgentInner, on real parts. */
    async function containerTask(
      input: CitInput,
      ctx: {
        cancelled: boolean;
        abortController?: AbortController;
        workflowRunId?: () => string;
      },
    ): Promise<{ ok: boolean }> {
      const rec = recordFor(input.threadId);
      rec.attempts += 1;
      const nsRoot = path.join(root, "ns");
      try {
        return await guardRunTerminal(
          { root: nsRoot, runId: ctx.workflowRunId?.() ?? "", log: () => {} },
          async () => {
            const lane = resolveRunLane(input);
            rec.lane = lane;
            const signal = ctx.abortController?.signal;
            const lock = await acquireBoxSlot({
              root: nsRoot,
              slots: 3,
              holder: input.threadId,
              signal,
            });
            rec.slot = lock.slot;
            const run = runPaths(path.join(root, "runs", input.threadId));
            let d: ContainerDaemonProcess | null = null;
            try {
              const cfg = configForSlot(
                input.small ? smallConfig : baseConfig,
                lock.slot,
              );
              await execFileAsync("git", ["clone", "-q", fixture, run.repo]);
              const mat = await materialiseAgentCredentials({
                credentials: { type: "built-in-credits" },
                agent: "claude",
                run,
                trustWorkdir: CONTAINER_WORKSPACE,
              });
              const counting = Object.assign(
                Object.create(
                  Object.getPrototypeOf(runtime),
                ) as ContainerRuntime,
                runtime,
                {
                  create: async (argv: readonly string[]) => {
                    rec.creates += 1;
                    return runtime.create(argv);
                  },
                },
              );
              d = new ContainerDaemonProcess(
                cfg,
                input as unknown as AgentRunInput,
                run,
                mat,
                lane,
                {
                  secrets: { daemonToken: "it-daemon-token-secret" },
                  runtime: counting,
                  command: ["bash", "-c", STANDIN, "standin", input.mode],
                  // A unix socket on a macOS bind mount is not connectable
                  // from the host (Docker runs in a VM): read the marker.
                  probeSocket:
                    process.platform === "linux"
                      ? undefined
                      : async (sock) => {
                          if (
                            !fs.existsSync(
                              path.join(path.dirname(sock), "daemon.ready"),
                            )
                          )
                            throw new Error("not ready");
                        },
                  socketTimeoutMs: 300_000,
                  log: () => {},
                },
              );
              await d.start();
              rec.containerId = d.id ?? undefined;
              rec.name = String(
                (
                  await execFileAsync("docker", [
                    "-H",
                    `unix://${SOCKET}`,
                    "inspect",
                    "--format",
                    "{{.Name}}",
                    d.id ?? "",
                  ])
                ).stdout,
              ).trim();
              const inspected = await execFileAsync("docker", [
                "-H",
                `unix://${SOCKET}`,
                "inspect",
                "--format",
                "{{json .}}",
                d.id ?? "",
              ]);
              rec.inspect = JSON.parse(String(inspected.stdout));
              const sock = path.join(run.runDir, "sock");
              const readEvidence = () => {
                try {
                  rec.evidence = JSON.parse(
                    fs.readFileSync(path.join(sock, "evidence.json"), "utf8"),
                  );
                } catch {
                  // not written yet
                }
              };
              readEvidence();
              for (;;) {
                if (ctx.cancelled || signal?.aborted) {
                  rec.abortAt = Date.now();
                  break;
                }
                if (d.exitStatus()) break;
                await new Promise((r) => setTimeout(r, 100));
              }
              readEvidence();
              const forks = path.join(sock, "forks");
              if (fs.existsSync(forks)) {
                rec.forks = Number(fs.readFileSync(forks, "utf8"));
              }
              rec.exit = d.exitStatus();
              if (rec.exit && rec.exit.code !== 0) {
                // The OOM flag lands asynchronously after the exit.
                for (let i = 0; i < 50 && !d.oomKilled(); i++) {
                  await d.refresh();
                  await new Promise((r) => setTimeout(r, 100));
                }
              }
              rec.oomKilled = d.oomKilled();
              const failure = d.agentFailure();
              if (failure) throw failure;
              return { ok: true };
            } finally {
              if (d) {
                await d.teardown();
                rec.removedAt = Date.now();
              }
              fs.rmSync(run.runDir, { recursive: true, force: true });
              await lock.release();
            }
          },
        );
      } catch (err) {
        rec.error =
          err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        if (err instanceof Error && err.name === "RunAlreadyTerminalError") {
          rec.refused = err.message;
        }
        throw err;
      }
    }

    async function dispatch(
      workflowName: string,
      input: Omit<
        CitInput,
        | "threadChatId"
        | "repoFullName"
        | "daemonCallbackUrl"
        | "deliveryId"
        | "orgId"
      > & {
        orgId?: string;
      },
    ): Promise<{ id: string; at: number }> {
      const full: CitInput = {
        threadChatId: "chat",
        repoFullName: "acme/fixture",
        daemonCallbackUrl: "http://127.0.0.1:9",
        deliveryId: uid("d"),
        orgId: "org-a",
        ...input,
      };
      const at = Date.now();
      const res = await fetch(
        `${REST}/api/v1/stable/tenants/${tenantId}/workflow-runs/trigger`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ workflowName, input: full }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        run?: { metadata?: { id?: string } };
      };
      expect(res.status).toBe(200);
      return { id: body.run?.metadata?.id ?? "", at };
    }

    const statusOf = async (id: string): Promise<Status> => {
      try {
        return await hatchet.runs.get_status(id);
      } catch (e) {
        if ((e as { response?: { status?: number } }).response?.status === 404)
          return Status.QUEUED;
        throw e;
      }
    };
    const waitStatus = (id: string, wanted: Status[], budgetMs = 420_000) =>
      pollUntil(
        `${id} ∈ ${wanted.join("|")}`,
        () => statusOf(id),
        (s) => wanted.includes(s),
        budgetMs,
        500,
      );

    /** Containers of this suite's thread still known to the daemon. */
    const containersOf = async (threadId: string): Promise<string[]> => {
      const r = await execFileAsync("docker", [
        "-H",
        `unix://${SOCKET}`,
        "ps",
        "-a",
        "-q",
        "--filter",
        `label=automata.thread=${threadId}`,
      ]);
      return String(r.stdout).split("\n").filter(Boolean);
    };

    beforeAll(async () => {
      root = await mkdtemp(path.join(tmpdir(), "cit-"));
      fs.mkdirSync(path.join(root, "ns"));
      fs.mkdirSync(path.join(root, "runs"));
      // A fixture repo tracking its own CLAUDE.md (the installer rewrites it)
      // and a tsconfig.json (stack: typescript).
      fixture = path.join(root, "fixture");
      fs.mkdirSync(fixture);
      fs.writeFileSync(
        path.join(fixture, "CLAUDE.md"),
        "# the repo's own CLAUDE.md\n",
      );
      fs.writeFileSync(path.join(fixture, "tsconfig.json"), "{}\n");
      const git = (...a: string[]) =>
        execFileAsync("git", ["-C", fixture, ...a]);
      await git("init", "-q", ".");
      await git("add", ".");
      await git(
        "-c",
        "user.name=it",
        "-c",
        "user.email=it@it",
        "commit",
        "-qm",
        "fixture",
      );
      fs.writeFileSync(path.join(root, "daemon-bundle.js"), "// stand-in\n");
      const env = {
        WORKER_PAYLOAD_SEAL_KEY_FILE: "/nonexistent",
        WORKER_BATTERIES_IMAGE: IMAGE,
        WORKER_CONTAINER_DOCKER_SOCKET: SOCKET,
        WORKER_RUN_MEMORY_MAX: "2G",
        WORKER_RUN_TASKS_MAX: "128",
        WORKER_CONTAINER_TMP_SIZE: "64M",
        WORKER_CONTAINER_SHM_SIZE: "64M",
        WORKER_BOX_SLOTS: "3",
        WORKER_GLOBAL_MAX_RUNS: "3",
        WORKER_PER_ORG_MAX_RUNS: "2",
        WORKER_DAEMON_DIST: path.join(root, "daemon-bundle.js"),
        WORKER_BOX_ID: `cit-${sfx}`,
        ANTHROPIC_API_KEY: "sk-ant-it-sentinel",
        // The box: the rootless daemon user's gid, to exercise the hand-over.
        WORKER_CONTAINER_RUN_GID: process.env.CONTAINER_IT_RUN_GID ?? "",
      };
      baseConfig = loadWorkerConfig(env);
      smallConfig = loadWorkerConfig({ ...env, WORKER_RUN_MEMORY_MAX: "256M" });
      expect(await runtime.imagePresent(IMAGE)).toBe(true);

      await composeUp();
      pg = await connectPg();
      ({ tenantId, token } = await bootstrapTenant(pg));
      process.env.HATCHET_CLIENT_TOKEN = token;
      process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";
      const sdk = await import("@hatchet-dev/typescript-sdk");
      hatchet = sdk.Hatchet.init();
      const caps = { globalMaxRuns: 3, perOrgMaxRuns: 2 };
      // The SHIPPED shapes (per-org + global keys; newest-wins per PR on the
      // variant), under suite-unique names so no other suite's worker on
      // the shared tenant can pick these runs up.
      const workflows = [
        [LEGACY, null],
        [NEWEST, AGENT_RUN_VARIANTS["agent-run-newest"]],
      ].map(([name, strategy]) => {
        const def = buildAgentRunDefinition(
          name as string,
          strategy as Parameters<typeof buildAgentRunDefinition>[1],
          caps,
        );
        const wf = hatchet.workflow<CitInput>(def.workflow);
        wf.task({
          ...def.task,
          retries: 0,
          fn: (i: CitInput, c) =>
            containerTask(
              i,
              c as unknown as Parameters<typeof containerTask>[1],
            ),
        });
        return wf;
      });
      worker = await hatchet.worker(`cit-worker-${sfx}`, {
        workflows,
        slots: 3,
      });
      void worker.start();
      await worker.waitUntilReady(60_000);
    });

    afterAll(async () => {
      await worker?.stop().catch(() => {});
      await pg?.end().catch(() => {});
      await composeDownV();
      // Belt and braces: nothing of this suite may outlive it.
      const left = await execFileAsync("docker", [
        "-H",
        `unix://${SOCKET}`,
        "ps",
        "-a",
        "-q",
        "--filter",
        `label=automata.box=cit-${sfx}`,
      ]).catch(() => ({ stdout: "" }));
      for (const id of String(left.stdout).split("\n").filter(Boolean)) {
        await runtime.remove(id).catch(() => {});
      }
      if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    const taskThread = uid("thr_task");

    // card: protects=task, pr and review lanes each complete end-to-end in a fresh container from the pinned image, dispatched by the engine, in three DISTINCT box slots at once (3 slots ≤ 2/org), every container hardened (none network, ALL caps dropped, no-new-privileges, read-only rootfs, init, the tuple's memory/pids/cpus) and removed after; fails_when=a lane fails, two runs share a slot or a name, a hardening field differs in `docker inspect`, or a container survives its run; no_claim=the real daemon talking to www (C3), rootless enforcement (box P0), Linux host-to-container socket connect on this host if it is macOS
    it("task, pr and review lanes run concurrently in hardened containers and are removed", async () => {
      const prThread = uid("thr_pr");
      const reviewThread = uid("thr_review");
      const runs = await Promise.all([
        dispatch(LEGACY, { threadId: taskThread, mode: "complete" }),
        dispatch(LEGACY, {
          threadId: prThread,
          mode: "complete",
          prNumber: 7,
          orgId: "org-b",
        }),
        dispatch(NEWEST, {
          threadId: reviewThread,
          mode: "complete",
          prNumber: 8,
          prKey: uid("org-a/acme/fixture/8"),
          supersedePolicy: "newest-wins",
        }),
      ]);
      for (const r of runs)
        expect(await waitStatus(r.id, TERMINAL)).toBe(Status.COMPLETED);

      const recs = [taskThread, prThread, reviewThread].map(
        (t) => records.get(t)!,
      );
      expect(recs.map((r) => r.lane)).toEqual(["task", "pr", "review"]);
      expect(new Set(recs.map((r) => r.slot)).size).toBe(3);
      expect(new Set(recs.map((r) => r.name)).size).toBe(3);
      for (const [i, r] of recs.entries()) {
        const host = r.inspect?.HostConfig as Record<string, unknown>;
        const cfg = r.inspect?.Config as Record<string, unknown>;
        expect(host.NetworkMode).toBe("none");
        expect(host.CapDrop).toEqual(["ALL"]);
        expect(host.SecurityOpt).toEqual(["no-new-privileges"]);
        expect(host.ReadonlyRootfs).toBe(true);
        expect(host.Init).toBe(true);
        expect(host.Privileged).toBe(false);
        expect(host.Memory).toBe(2 * 1024 ** 3);
        expect(host.MemorySwap).toBe(2 * 1024 ** 3);
        expect(host.PidsLimit).toBe(128);
        expect(host.NanoCpus).toBe(2e9);
        expect(cfg.User).toBe("10001:10001");
        expect(cfg.Image).toBe(IMAGE);
        expect((cfg.Labels as Record<string, string>)["automata.lane"]).toBe(
          r.lane,
        );
        expect(r.exit).toEqual({ code: 0, signal: null });
        expect(
          await containersOf([taskThread, prThread, reviewThread][i]!),
        ).toEqual([]);
      }
    });

    // card: protects=from INSIDE the container: non-root uid 10001, zero effective/bounding capabilities, NoNewPrivs, only loopback, EROFS on the rootfs while /workspace and HOME are writable, tini as pid 1, the image's batteries intact in the HOME volume, the box key from the env file (deleted before the daemon), no GitHub credential, no daemon token in env, trust seeded for /workspace; fails_when=any of those differs; no_claim=probes 1/2/6/7 of ADR-013 (egress, engine ports, push, cross-run) which need C3/C4
    it("inside the container: identity, capabilities, network, filesystem and env are the baseline", () => {
      const ev = records.get(taskThread)?.evidence as Record<string, any>;
      expect(ev.uid).toBe(10001);
      expect(ev.capEff).toBe("0000000000000000");
      expect(ev.capBnd).toBe("0000000000000000");
      expect(ev.noNewPrivs).toBe("1");
      expect(ev.netIfaces).toEqual(["lo"]);
      expect(ev.rootfsWrite).toBe("EROFS");
      expect(ev.workspaceWrite).toBe("ok");
      expect(ev.homeWrite).toBe("ok");
      expect(ev.pid1).toMatch(/docker-init|tini/);
      expect(ev.skills).toBeGreaterThanOrEqual(25);
      expect(ev.runEnvFileLeft).toBe(false);
      expect(ev.env.anthropicKey).toBe("sk-ant-it-sentinel");
      expect(ev.env.hasGhToken).toBe(false);
      expect(ev.env.hasGithubToken).toBe(false);
      expect(ev.env.daemonToken).toBe(false);
      expect(ev.env.home).toBe("/home/agent");
      expect(ev.claudeJson.projects["/workspace"].hasTrustDialogAccepted).toBe(
        true,
      );
    });

    // card: protects=the REAL Somnio CLI in the image installs the TypeScript rules into the checkout, the repo's tracked CLAUDE.md wins, every installed path is git-excluded and the checkout is clean when the daemon starts; fails_when=no rules land, CLAUDE.md is the installer's, or `git status` is not empty; no_claim=other stacks' rule sets
    it("the per-run Somnio rules install leaves the rules in place and the checkout clean", () => {
      const ev = records.get(taskThread)?.evidence as Record<string, any>;
      expect(ev.env.stacks).toBe("typescript");
      expect(ev.rulesDir).toBe(true);
      expect(ev.claudeMd).toBe("# the repo's own CLAUDE.md\n");
      expect(ev.gitStatus).toBe("");
      expect(ev.exclude).toMatch(/^\/\.claude\/rules\//m);
    });

    // card: protects=the lane policy as run-time inputs: the review container gets deny-only settings (no hooks) and NOTHING mounted in /run/automata before its daemon binds, task/pr get the image's batteries hooks plus the foreground-only guard; fails_when=a review gets hooks or a socket, or a task loses its hooks/guard; no_claim=Claude honouring the settings
    it("lane policy: review is deny-only with an empty socket dir; task and pr carry hooks + the guard", () => {
      const byLane = new Map(
        [...records.values()]
          .filter((r) => r.evidence)
          .map((r) => [r.lane, r.evidence as Record<string, any>]),
      );
      const review = byLane.get("review")!;
      expect(review.runAutomata).toEqual([]);
      expect(review.settings.hooks).toBeUndefined();
      expect(review.settings.permissions.deny).toContain("Skill(cso)");
      expect(review.env.hasGhToken).toBe(false);
      for (const lane of ["task", "pr"] as const) {
        const ev = byLane.get(lane)!;
        expect(Object.keys(ev.settings.hooks).length).toBeGreaterThan(1);
        expect(JSON.stringify(ev.settings.hooks.PreToolUse)).toContain(
          "run_in_background",
        );
        expect(ev.settings.permissions).toBeUndefined();
      }
    });

    // card: protects=#386 with containers: a redelivered attempt of a run id that already reached a terminal is refused by the ledger before admission, and NO container is created for it; fails_when=the replay re-executes or creates a container; no_claim=the SDK drain race that motivated #386 (replay is the engine's own re-execution of the same run id)
    it("a redelivered (replayed) run is refused by the terminal ledger and creates no container", async () => {
      const threadId = uid("thr_redeliver");
      const r = await dispatch(LEGACY, { threadId, mode: "complete" });
      expect(await waitStatus(r.id, TERMINAL)).toBe(Status.COMPLETED);
      const rec = records.get(threadId)!;
      expect(rec.creates).toBe(1);
      await hatchet.runs.replay({ ids: [r.id] });
      await pollUntil(
        "replayed attempt observed",
        async () => rec.attempts,
        (n) => n >= 2,
        120_000,
        250,
      );
      await pollUntil(
        "replay refused",
        async () => rec.refused ?? "",
        (s) => s.length > 0,
        60_000,
        250,
      );
      expect(rec.refused).toMatch(
        /redelivered attempt refused, not re-executed/,
      );
      expect(rec.creates).toBe(1);
      expect(await containersOf(threadId)).toEqual([]);
    });

    // card: protects=newest-wins supersession on a container run: the engine cancels the live run, the run fn sees the abort, and its container is REMOVED within 10 s of the abort (and within 10 s of the superseding dispatch), while the newer run completes; fails_when=the old container outlives 10 s, survives at all, or the newer run does not complete; no_claim=the www `superseded` terminal post (needs www)
    it("supersession cancels the running container and removes it within 10 s", async () => {
      const prKey = uid("org-a/acme/fixture/9");
      const oldThread = uid("thr_old");
      const old = await dispatch(NEWEST, {
        threadId: oldThread,
        mode: "hold",
        prNumber: 9,
        prKey,
        supersedePolicy: "newest-wins",
      });
      await pollUntil(
        "old container running",
        async () => records.get(oldThread)?.containerId ?? "",
        (id) => id.length > 0,
        300_000,
        250,
      );
      expect(await containersOf(oldThread)).toHaveLength(1);
      const fresh = await dispatch(NEWEST, {
        threadId: uid("thr_new"),
        mode: "complete",
        prNumber: 9,
        prKey,
        supersedePolicy: "newest-wins",
      });
      expect(await waitStatus(old.id, TERMINAL)).toBe(Status.CANCELLED);
      const rec = await pollUntil(
        "old container removed",
        async () => records.get(oldThread)!,
        (r) => r.removedAt !== undefined,
        30_000,
        100,
      );
      expect(rec.abortAt).toBeDefined();
      const sinceAbort = rec.removedAt! - rec.abortAt!;
      const sinceDispatch = rec.removedAt! - fresh.at;
      console.log(
        `[cit] supersession: container removed ${sinceAbort} ms after the abort, ${sinceDispatch} ms after the superseding dispatch`,
      );
      expect(sinceAbort).toBeLessThanOrEqual(10_000);
      expect(sinceDispatch).toBeLessThanOrEqual(10_000);
      expect(await containersOf(oldThread)).toEqual([]);
      expect(await waitStatus(fresh.id, TERMINAL)).toBe(Status.COMPLETED);
    });

    // card: protects=--memory is enforced on a run container: allocating past the ceiling is OOM-killed, `.State.OOMKilled` is read before removal, and the run fails with the ResourceLimit cause; fails_when=the allocation survives, the OOM is unattributed, or the container survives; no_claim=enforcement under the ROOTLESS daemon (this host's daemon is rootful; box P0 step)
    it("--memory is enforced: an allocation past the ceiling is OOM-killed and attributed", async () => {
      const threadId = uid("thr_oom");
      const r = await dispatch(LEGACY, { threadId, mode: "oom", small: true });
      expect(await waitStatus(r.id, TERMINAL)).toBe(Status.FAILED);
      const rec = records.get(threadId)!;
      expect((rec.inspect?.HostConfig as Record<string, unknown>).Memory).toBe(
        256 * 1024 ** 2,
      );
      expect(rec.exit?.code).toBe(137);
      expect(rec.oomKilled).toBe(true);
      expect(rec.error).toMatch(
        /Out of memory: 1 process\(es\) killed by the per-run memory limit \(memory\.max=256M\)/,
      );
      expect(await containersOf(threadId)).toEqual([]);
    });

    // card: protects=--pids-limit is enforced on a run container: a fork loop of 300 stops below the 128-task limit; fails_when=300 forks succeed; no_claim=enforcement under the ROOTLESS daemon (box P0 step); --cpus (prove-container-limits.sh covers it)
    it("--pids-limit is enforced: a fork loop stops below the limit", async () => {
      const threadId = uid("thr_fork");
      const r = await dispatch(LEGACY, { threadId, mode: "fork" });
      expect(await waitStatus(r.id, TERMINAL)).toBe(Status.COMPLETED);
      const rec = records.get(threadId)!;
      expect(
        (rec.inspect?.HostConfig as Record<string, unknown>).PidsLimit,
      ).toBe(128);
      expect(rec.forks).toBeGreaterThan(0);
      expect(rec.forks).toBeLessThan(128);
      expect(await containersOf(threadId)).toEqual([]);
    });
  },
);
