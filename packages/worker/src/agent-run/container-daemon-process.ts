import type { RunSecrets } from "@terragon/utils/payload-seal";
import { type ChildProcess, execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { redactSecrets } from "@terragon/utils/redact";

import {
  readBoxTestServicesEnv,
  receivesBoxTestServices,
} from "./box-test-services";
import {
  buildContainerCreateArgv,
  CONTAINER_DAEMON_BUNDLE,
  CONTAINER_DAEMON_SOCKET,
  CONTAINER_HOME,
  containerLanePolicy,
  containerNameForSlot,
  type ContainerLanePolicy,
} from "./container-argv";
import type { ContainerRunsConfig } from "./container-config";
import { buildEntryScript, detectSomnioStacks } from "./container-entry";
import {
  buildContainerRunEnv,
  composeContainerSettings,
  serializeRunEnvFile,
} from "./container-policy";
import { ContainerRuntime, type ContainerState } from "./container-runtime";
import { writeDaemonMessage } from "./daemon-process";
import {
  classifyAgentExit,
  resourceLimitFailure,
} from "./retry-classification";
import type { WorkerConfig } from "./config";
import type { RunLane } from "./run-lane";
import type { RunPaths } from "./run-owned-paths";
import { getProcessWorkerId } from "./run-namespace";
import type { AgentRunInput, PulledDaemonMessage } from "./types";

const execFileAsync = promisify(execFile);

/**
 * What the workflow drives, on either path: the host-uid `DaemonProcess` and
 * this class both satisfy it. `teardown()` returns a promise here (a container
 * is removed through the daemon) and nothing on the host path; the workflow
 * awaits the promise, and the slot is released only after it settles
 * (ADR-007 I2, ADR-013 I6).
 */
export interface RunDaemon {
  readonly pid: number | undefined;
  preflightGhAuth(): Promise<void>;
  start(): Promise<void>;
  runCgroupDir(): string | null;
  sendMessage(pulled: PulledDaemonMessage): Promise<number>;
  teardown(): void | Promise<void>;
  agentFailure(): unknown | null;
  memoryStarvation(): unknown | null;
}

/**
 * The workflow's teardown step for either daemon. The host daemon's teardown
 * is synchronous and returns nothing, so this returns undefined and the
 * caller awaits nothing: the host path's ordering is unchanged. A container's
 * returns a promise that never rejects: a removal that kept failing is logged
 * (`container.teardown_failed`) and the run's teardown carries on. Holding
 * the slot forever would wedge the box, the brokers, proxy and credential
 * must still close, and the next run on this slot removes the leftover by
 * name before it creates its own (fail-closed), so the two never coexist.
 */
export function settleDaemonTeardown(
  daemon: Pick<RunDaemon, "teardown">,
  threadId: string,
  log: (line: string) => void,
): Promise<void> | undefined {
  const pending = daemon.teardown();
  if (!(pending instanceof Promise)) return undefined;
  return pending.catch((err: unknown) => {
    log(
      `container.teardown_failed ${JSON.stringify({ thread: threadId, error: err instanceof Error ? err.message : String(err) })}`,
    );
  });
}

/** The run dir's socket subdir, bind-mounted at /run/automata. */
export function runSocketDir(run: Pick<RunPaths, "runDir">): string {
  return path.join(run.runDir, "sock");
}

/** Where `settings.batteries.json` is copied out to, beside the HOME staging dir. */
function batteriesOutDir(run: Pick<RunPaths, "runDir">): string {
  return path.join(run.runDir, "image-out");
}

/** Max bytes of the redacted stderr tail kept for start() diagnostics. */
const STDERR_TAIL_BYTES = 4096;
/** How long the container gets to bind its daemon socket. Cold start copies HOME + Flutter volumes. */
export const CONTAINER_SOCKET_TIMEOUT_MS = 90_000;

export interface ContainerDaemonDeps {
  /** #380: the daemon token rides the socket message; never logged, never in the container env. */
  secrets: Pick<RunSecrets, "daemonToken" | "repoEnv">;
  /** The rootless daemon adapter; production builds it from the config. */
  runtime?: ContainerRuntime;
  /**
   * The bot-identity precondition (ADR-002 F3), run on the HOST against the
   * brokers before the container exists. The workflow passes the host
   * DaemonProcess's own check, so both paths prove the same thing.
   */
  hostPreflight?: () => Promise<void>;
  /**
   * What the entry execs. Production: the daemon bundle. The integration
   * suite substitutes a stand-in (the real daemon needs the control plane,
   * which a `--network none` container reaches only through C3's bridges).
   */
  command?: readonly string[];
  /** Readiness probe for the daemon socket on the host side (injectable; default: connect()). */
  probeSocket?: (socketPath: string) => Promise<void>;
  /** Override for the box test-services env file (tests). */
  boxTestServicesEnvPath?: string;
  log?: (line: string) => void;
  /** Socket wait budget (tests shorten it). */
  socketTimeoutMs?: number;
  /** `docker rm -f -v` attempts before teardown gives up (default 4). */
  removeAttempts?: number;
  /** First backoff between removal attempts, doubled each time (default 2 s; tests shorten it). */
  retryDelayMs?: number;
}

const DEFAULT_REMOVE_ATTEMPTS = 4;
const DEFAULT_REMOVE_RETRY_MS = 2_000;

/**
 * The container-run twin of `DaemonProcess` (ADR-013 "Run path" 2-7), behind
 * `WORKER_DEV_CONTAINER_RUNS=1` only. One instance per run:
 *
 *   start():    socket dir + run-dir hand-over → remove any container still
 *               holding this slot's name → `docker create` (hardened argv) →
 *               copy the per-run policy into HOME → `docker start --attach` →
 *               wait for the daemon socket.
 *   teardown(): read `.State.OOMKilled`, then `docker rm -f -v` (SIGKILL to the
 *               whole pid namespace, anonymous volumes removed), and confirm
 *               the container is gone, retried with backoff. Idempotent;
 *               resolves only once it is, rejects after the last attempt.
 *
 * Container removal replaces the uid reaper for these runs: every process of
 * the run lives in the container's pid namespace under `--init`, so a
 * `setsid` escapee dies with it.
 */
export class ContainerDaemonProcess implements RunDaemon {
  private readonly cr: ContainerRunsConfig;
  private readonly runtime: ContainerRuntime;
  private readonly policy: ContainerLanePolicy;
  private readonly name: string;
  private readonly socketDir: string;
  private readonly hostSocketPath: string;
  private readonly log: (line: string) => void;
  private containerId: string | null = null;
  private child: ChildProcess | null = null;
  private childExit: {
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  private stderrTail = "";
  private lastState: ContainerState | null = null;
  private refreshing: Promise<void> | null = null;
  private teardownPromise: Promise<void> | null = null;
  private startedAt = 0;

  constructor(
    private readonly config: WorkerConfig,
    private readonly input: AgentRunInput,
    private readonly run: RunPaths,
    /** The run's HOME staging dir (credential + trust seed), from materialiseAgentCredentials. */
    private readonly credentials: {
      home: string;
      delivered: boolean;
      env: Record<string, string>;
    },
    private readonly lane: RunLane,
    private readonly deps: ContainerDaemonDeps,
  ) {
    if (!config.containerRuns) {
      throw new Error(
        "ContainerDaemonProcess needs WORKER_DEV_CONTAINER_RUNS=1 (config.containerRuns is null)",
      );
    }
    this.cr = config.containerRuns;
    this.runtime =
      deps.runtime ??
      new ContainerRuntime({
        socketPath: this.cr.dockerSocket,
        dockerBin: this.cr.dockerBin,
      });
    this.policy = containerLanePolicy(lane);
    this.name = containerNameForSlot(getProcessWorkerId(), config.boxSlot ?? 0);
    this.socketDir = runSocketDir(run);
    this.hostSocketPath = path.join(this.socketDir, "daemon.sock");
    this.log = deps.log ?? ((line) => console.error(`[agent-run] ${line}`));
  }

  /** The container id once created (null before and after teardown's removal). */
  get id(): string | null {
    return this.containerId;
  }

  /** The `docker start --attach` child's pid (the container's lifetime on this side). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** The step line for the journal: container id, name and the image digest it runs. */
  spawnedLine(): string {
    return `daemon spawned in container: id=${this.containerId?.slice(0, 12) ?? "none"} name=${this.name} image=${this.cr.image.digest} lane=${this.lane}`;
  }

  /** No host cgroup: the container's limits are Docker's (`--memory`, `--pids-limit`). */
  runCgroupDir(): string | null {
    return null;
  }

  async preflightGhAuth(): Promise<void> {
    await this.deps.hostPreflight?.();
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    await this.prepareSocketDir();
    if (this.cr.runGid !== null) {
      await handOverRunDir({
        dirs: [this.run.repo, this.socketDir],
        gid: this.cr.runGid,
      });
    }
    const stacks = detectSomnioStacks(this.run.repo);
    // Admission backstop (ADR-013 Run path 1): a crash-redelivered run must
    // never meet its predecessor holding this slot's name.
    if (await this.runtime.remove(this.name)) {
      this.log(
        `container.predecessor_removed ${JSON.stringify({ name: this.name, thread: this.input.threadId })}`,
      );
    }
    const argv = buildContainerCreateArgv({
      image: this.cr.image,
      name: this.name,
      lane: this.lane,
      runDir: this.run.runDir,
      workspaceHostPath: this.run.repo,
      socketDirHostPath: this.socketDir,
      daemonBundleHostPath: this.config.daemonDist,
      labels: {
        workerId: getProcessWorkerId(),
        workerPid: process.pid,
        boxId: this.config.boxId,
        runId: this.input.threadId,
        threadId: this.input.threadId,
        slot: this.config.boxSlot ?? 0,
      },
      limits: {
        memoryBytes: this.config.memoryMaxBytes,
        pidsLimit: this.config.tasksMax,
        cpus: this.cr.cpus,
        tmpBytes: this.cr.tmpBytes,
        shmBytes: this.cr.shmBytes,
      },
      runGid: this.cr.runGid,
      env: {
        HOME: CONTAINER_HOME,
        TMPDIR: "/tmp",
        AUTOMATA_RUN_LANE: this.lane,
        AUTOMATA_THREAD_ID: this.input.threadId,
        AUTOMATA_SOMNIO_STACKS: stacks.join(","),
      },
      entryScript: buildEntryScript(),
      command: this.deps.command ?? [
        "node",
        CONTAINER_DAEMON_BUNDLE,
        "--url",
        this.input.daemonCallbackUrl,
        "--socket-path",
        CONTAINER_DAEMON_SOCKET,
      ],
    });
    this.containerId = await this.runtime.create(argv);
    this.log(
      `container.created ${JSON.stringify({ id: this.containerId.slice(0, 12), name: this.name, lane: this.lane, stacks, image: this.cr.image.digest })}`,
    );
    await this.copyInPolicy();
    const child = this.runtime.startAttached(this.containerId);
    this.child = child;
    // Container stdout is agent output (H2): drained, never stored.
    child.stdout?.resume();
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = redactSecrets(
        (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES),
      );
    });
    child.on("exit", (code, signal) => {
      this.childExit = { code, signal };
      void this.refreshState();
    });
    await this.waitForSocket();
    this.log(
      `container.ready ${JSON.stringify({ id: this.containerId.slice(0, 12), coldStartMs: Date.now() - this.startedAt })}`,
    );
  }

  /** Fresh socket dir every attempt (a retry must not inherit a stale socket). */
  private async prepareSocketDir(): Promise<void> {
    await fs.promises.rm(this.socketDir, { recursive: true, force: true });
    await fs.promises.mkdir(this.socketDir, { recursive: true, mode: 0o770 });
  }

  /**
   * Copy the per-run policy into the created container's HOME volume
   * (ADR-013 Decision 4: never on argv or env, never in `docker inspect`):
   * the trust seed and credential materialise wrote, the composed settings,
   * the run env file and an empty gh config dir. The env file is removed from
   * the host staging dir as soon as the copy lands.
   */
  private async copyInPolicy(): Promise<void> {
    const id = this.containerId;
    if (!id) throw new Error("copyInPolicy before create");
    const home = this.credentials.home;
    let batteries: unknown = null;
    if (this.policy.batteriesHooks) {
      const outDir = batteriesOutDir(this.run);
      await fs.promises.mkdir(outDir, { recursive: true, mode: 0o700 });
      const found = await this.runtime.copyOut(
        id,
        `${CONTAINER_HOME}/.claude/settings.batteries.json`,
        outDir,
      );
      if (found) {
        try {
          batteries = JSON.parse(
            await fs.promises.readFile(
              path.join(outDir, "settings.batteries.json"),
              "utf8",
            ),
          );
        } catch {
          this.log(
            "container.batteries_settings_unparseable (hooks not merged)",
          );
        }
      }
      await fs.promises.rm(outDir, { recursive: true, force: true });
    }
    const claudeDir = path.join(home, ".claude");
    await fs.promises.mkdir(claudeDir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(
      path.join(claudeDir, "settings.json"),
      JSON.stringify(composeContainerSettings(this.policy, batteries), null, 2),
      { mode: 0o600 },
    );
    await fs.promises.mkdir(path.join(home, ".config", "gh"), {
      recursive: true,
      mode: 0o700,
    });
    const boxTestEnv = receivesBoxTestServices(this.input, this.lane)
      ? readBoxTestServicesEnv(
          this.input.repoFullName,
          this.deps.boxTestServicesEnvPath,
        )
      : {};
    const runEnv = buildContainerRunEnv({
      policy: this.policy,
      botLogin: this.config.botLogin,
      anthropicApiKey: this.config.anthropicApiKey,
      credentialDelivered: this.credentials.delivered,
      credentialEnv: this.credentials.env,
      repoEnv: { ...boxTestEnv, ...(this.deps.secrets.repoEnv ?? {}) },
      // C3 (#430) wires the proxy and broker sockets; until then a container
      // gets neither, so it has no route out and no GitHub credential.
      egressProxyUrl: null,
      broker: null,
    });
    const envDir = path.join(home, ".automata-run");
    const envFile = path.join(envDir, "run.env");
    await fs.promises.mkdir(envDir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(envFile, serializeRunEnvFile(runEnv), {
      mode: 0o600,
    });
    try {
      await this.runtime.copyIn(id, home, CONTAINER_HOME);
    } finally {
      await fs.promises.rm(envDir, { recursive: true, force: true });
    }
  }

  private async waitForSocket(): Promise<void> {
    const timeoutMs = this.deps.socketTimeoutMs ?? CONTAINER_SOCKET_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const probe = this.deps.probeSocket ?? probeUnixSocket;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      if (this.childExit) {
        await this.refreshState();
        throw classifyAgentExit({
          exitCode: this.childExit.code,
          signal: this.childExit.signal,
          oomKills: this.lastState?.oomKilled ? 1 : 0,
          memoryMaxBytes: this.config.memoryMaxBytes,
          fallback: new Error(
            `run container exited before its daemon socket was ready (code ${this.childExit.code}, signal ${this.childExit.signal ?? "none"})` +
              (this.stderrTail ? `: ${this.stderrTail.trim()}` : ""),
          ),
        });
      }
      try {
        await probe(this.hostSocketPath);
        return;
      } catch (err) {
        lastErr = err;
        await delay(200);
      }
    }
    throw new Error(
      `run container's daemon socket not ready after ${timeoutMs}ms: ${String(lastErr)}` +
        (this.stderrTail ? ` (stderr: ${this.stderrTail.trim()})` : ""),
    );
  }

  async sendMessage(pulled: PulledDaemonMessage): Promise<number> {
    const dataStr = JSON.stringify({
      ...pulled,
      token: this.deps.secrets.daemonToken,
      threadId: this.input.threadId,
      threadChatId: this.input.threadChatId,
    });
    await writeDaemonMessage(this.hostSocketPath, dataStr);
    return dataStr.length;
  }

  /** Refresh the cached `.State` (OOM attribution). Never throws. */
  private refreshState(): Promise<void> {
    const id = this.containerId;
    if (!id) return Promise.resolve();
    this.refreshing ??= this.runtime
      .inspectState(id)
      .then((s) => {
        if (s) this.lastState = s;
      })
      .catch(() => {})
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  /**
   * The run's failure once its container has exited without the thread
   * reaching terminal, or null while it runs. Same contract as the host
   * path's: a clean exit 0 is not a failure; a SIGKILL'd exit with the OOM
   * flag set is a ResourceLimitError.
   */
  agentFailure(): unknown | null {
    const exit = this.childExit;
    if (!exit || this.teardownPromise) return null;
    if (exit.code === 0 && exit.signal == null) return null;
    return classifyAgentExit({
      exitCode: exit.code,
      signal: exit.signal,
      oomKills: this.lastState?.oomKilled ? 1 : 0,
      memoryMaxBytes: this.config.memoryMaxBytes,
      fallback: new Error(
        `the run container exited mid-run (code ${exit.code}, signal ${exit.signal ?? "none"}) without the thread reaching a terminal status` +
          (this.stderrTail ? `: ${this.stderrTail.trim()}` : ""),
      ),
    });
  }

  /**
   * Did the kernel OOM-kill anything in the container? Docker sets
   * `.State.OOMKilled` on the container's OOM event, child or main process
   * alike. Read from a cached inspect refreshed on every poll tick.
   */
  memoryStarvation(): unknown | null {
    void this.refreshState();
    return this.lastState?.oomKilled
      ? resourceLimitFailure(this.config.memoryMaxBytes, 1)
      : null;
  }

  /** The OOM flag as last observed (teardown reads it before removal). */
  oomKilled(): boolean {
    return this.lastState?.oomKilled === true;
  }

  /** The container's exit once its attach child ended (null while it runs). */
  exitStatus(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.childExit;
  }

  /** Re-read `.State` now (the OOM flag lands asynchronously after an exit). */
  async refresh(): Promise<void> {
    await this.refreshState();
  }

  /**
   * Remove the container: OOM flag first (it dies with the container), then
   * `docker rm -f -v`, then confirm it is gone, retried with backoff while the
   * caller still holds the slot. Idempotent — every caller awaits the same
   * promise. It rejects only when the container is still there after every
   * attempt: the caller logs that and lets the slot go rather than hold it
   * forever, and the next run on this slot removes the leftover by name
   * before it creates (start(), fail-closed: it cannot coexist with it).
   */
  teardown(): Promise<void> {
    this.teardownPromise ??= this.doTeardown();
    return this.teardownPromise;
  }

  private async doTeardown(): Promise<void> {
    // No id but start() ran: `docker create` may have failed or timed out
    // after the daemon made the container. The slot's name finds it.
    const target = this.containerId ?? (this.startedAt ? this.name : null);
    try {
      if (target) await this.removeConfirmed(target);
    } finally {
      try {
        this.child?.kill("SIGKILL");
      } catch {
        // the attach child is already gone with the container
      }
      this.child = null;
      await fs.promises
        .rm(this.socketDir, { recursive: true, force: true })
        .catch(() => {});
    }
  }

  private async removeConfirmed(target: string): Promise<void> {
    const t0 = Date.now();
    const attempts = Math.max(
      1,
      this.deps.removeAttempts ?? DEFAULT_REMOVE_ATTEMPTS,
    );
    const short = this.containerId ? target.slice(0, 12) : target;
    await this.refreshState();
    let lastProblem = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let removed = false;
      try {
        removed = await this.runtime.remove(target);
        const after = await this.runtime.inspectState(target);
        if (!after) {
          this.log(
            `container.removed ${JSON.stringify({ id: short, name: this.name, thread: this.input.threadId, removed, oomKilled: this.oomKilled(), attempt, ms: Date.now() - t0 })}`,
          );
          return;
        }
        lastProblem = `still exists after docker rm -f (status ${after.status})`;
      } catch (err) {
        lastProblem = err instanceof Error ? err.message : String(err);
      }
      this.log(
        `container.remove_retry ${JSON.stringify({ id: short, thread: this.input.threadId, attempt, of: attempts, problem: lastProblem })}`,
      );
      if (attempt < attempts) {
        await delay(
          (this.deps.retryDelayMs ?? DEFAULT_REMOVE_RETRY_MS) *
            2 ** (attempt - 1),
        );
      }
    }
    throw new Error(
      `run container ${short} could not be removed after ${attempts} attempts: ${lastProblem}`,
    );
  }
}

/**
 * Hand the run's bind-mounted dirs to the rootless daemon user's group
 * (ADR-013 "Daemon socket"): group = `gid` (container gid 0 under rootless),
 * group read/write, setgid dirs so files the container creates keep the
 * group. The container runs with `--group-add 0`; the worker is a member of
 * the group. P0 measures this hand-over on the box.
 */
export async function handOverRunDir(opts: {
  dirs: string[];
  gid: number;
  exec?: (file: string, args: string[]) => Promise<unknown>;
}): Promise<void> {
  const exec = opts.exec ?? ((file, args) => execFileAsync(file, args));
  for (const dir of opts.dirs) {
    await exec("chgrp", ["-R", String(opts.gid), dir]);
    await exec("chmod", ["-R", "g+rwX", dir]);
    await exec("find", [dir, "-type", "d", "-exec", "chmod", "g+s", "{}", "+"]);
  }
}

function probeUnixSocket(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    sock.once("connect", () => {
      sock.end();
      resolve();
    });
    sock.once("error", (err) => {
      sock.destroy();
      reject(err);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
