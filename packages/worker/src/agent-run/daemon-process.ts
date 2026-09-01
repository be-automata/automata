import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import {
  applyInheritableAces,
  applyTraverseAce,
  type AceExec,
} from "./agent-uid-fs";
import { buildDaemonEnv, type BrokerHandoff } from "./daemon-env";
import { ghBrokerConfigYaml } from "./gh-broker";
import {
  getProcessWorkerId,
  runPidPath,
  runSocketPath,
  workerRunDir,
} from "./run-namespace";
import { redactSecrets } from "./redact";
import {
  buildKillInvocation,
  buildSpawnInvocation,
} from "./spawn-as-user";
import { verifyGhAuth } from "./verify-gh-auth";
import type { WorkerConfig } from "./config";
import type { AgentRunInput, PulledDaemonMessage } from "./types";

/**
 * Spawns and controls the chassis daemon bundle (packages/daemon/dist/index.js) as
 * a subprocess for one agent run (ADR-003 run step). The daemon is a unix-socket
 * server that spawns the agent CLI and streams events to www /api/daemon-event;
 * the worker writes ONE DaemonMessage to its socket, then polls www for terminal.
 *
 * The daemon SIGKILLs its own process group on teardown (it is designed to be the
 * process-group leader of a sandbox), so it is spawned `detached` in its OWN
 * process group and torn down by signalling that group — never embedded in-process.
 *
 * Per-run socket + pidfile (Phase 0.2b): the daemon `--socket-path` flag lets each
 * run bind a DISTINCT socket under `<runNamespaceRoot>/<workerId>/<threadId>.sock`,
 * so N daemons no longer collide on the fixed default socket. The matching
 * `<threadId>.pid` records the daemon's process-group pid; boot-time reclaim (see
 * reclaim.ts) — NOT this class — reaps daemons orphaned by a worker-process death.
 * start() only cleans THIS run's own stale socket/pid (e.g. a same-threadId retry).
 */
export class DaemonProcess {
  private child: ChildProcess | null = null;
  /**
   * The process GROUP to signal at teardown. In default mode this is
   * `child.pid` (spawn is `detached`, so the child leads its own group). In
   * agent-uid mode it is the value the sudo wrapper wrote for itself — see
   * spawn-as-user.ts for why a pre-sudo pid is not usable.
   */
  private pgid: number | null = null;
  /** Bounded, redacted tail of the child's stderr, for start() diagnostics. */
  private stderrTail = "";
  private ghConfigDir: string | null = null;
  private env: NodeJS.ProcessEnv | null = null;
  private readonly runDir: string;
  private readonly socketPath: string;
  // PID of the daemon's process group, persisted under this worker's namespaced dir
  // so boot-reclaim can reap it if this worker process dies without running teardown.
  private readonly pidFilePath: string;

  constructor(
    private readonly config: WorkerConfig,
    private readonly input: AgentRunInput,
    private readonly workdir: string,
    /**
     * The run's own agent credential, already written to a per-run HOME (D1).
     * Null/omitted → this run has no delivered credential and the caller forces
     * it through the control-plane proxy instead.
     */
    private readonly credentials: {
      home: string;
      delivered: boolean;
      env: Record<string, string>;
    } | null = null,
    /**
     * The per-run egress filtering proxy's base url (#66 slice 2), when this
     * run carries an egress policy. Null → no proxy vars are injected and the
     * child's egress is unfiltered on this plane (today's behavior).
     */
    private readonly egressProxyUrl: string | null = null,
    /**
     * Per-run credential brokers (#81), when the workflow started them. Null →
     * legacy raw-token env (WORKER_CREDENTIAL_BROKER=legacy-direct rollback).
     * When set, ensureEnv() additionally writes `http_unix_socket` into the
     * isolated gh config dir so the agent's gh dials the gh broker.
     */
    private readonly broker: BrokerHandoff | null = null,
    /**
     * Injectable side-effects, for tests only. Production callers pass nothing
     * and get the real /bin/chmod. Keeping this last preserves every existing
     * call site unchanged.
     */
    private readonly deps: {
      aceExec?: AceExec;
      spawnFn?: typeof spawn;
      platform?: NodeJS.Platform;
    } = {},
  ) {
    const workerId = getProcessWorkerId();
    this.runDir = workerRunDir(config.runNamespaceRoot, workerId);
    this.socketPath = runSocketPath(
      config.runNamespaceRoot,
      workerId,
      input.threadId,
    );
    this.pidFilePath = runPidPath(
      config.runNamespaceRoot,
      workerId,
      input.threadId,
    );
  }

  /**
   * Build the sanitized child env once (idempotent). Creates the isolated EMPTY gh
   * config dir so the agent's `gh` can't read the operator's stored OAuth (hosts.yml)
   * and post as the human — it must use the installation token → the App bot. The dir
   * is cleaned up in teardown.
   */
  private ensureEnv(): NodeJS.ProcessEnv {
    if (this.env) {
      return this.env;
    }
    this.ghConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-gh-"));
    if (this.broker) {
      // #81: `http_unix_socket` has NO env-var equivalent — it is a config.yml
      // key only. Writing it into the per-run dir routes every gh API call
      // through the gh broker; teardown's ghConfigDir removal cleans it up.
      // The agent CAN edit this file to drop the socket — then gh dials
      // api.github.com directly with the bearer, which GitHub rejects.
      // Self-inflicted breakage, never a credential leak.
      fs.writeFileSync(
        path.join(this.ghConfigDir, "config.yml"),
        ghBrokerConfigYaml(this.broker.ghSocketPath),
      );
    }
    this.env = buildDaemonEnv({
      baseEnv: process.env,
      anthropicApiKey: this.config.anthropicApiKey,
      claudeBinDir: this.config.claudeBinDir,
      installationToken: this.input.installationToken,
      ghConfigDir: this.ghConfigDir,
      botLogin: this.config.botLogin,
      runHome: this.credentials?.home ?? null,
      credentialDelivered: this.credentials?.delivered ?? false,
      credentialEnv: this.credentials?.env ?? {},
      egressProxyUrl: this.egressProxyUrl,
      broker: this.broker,
      agentUser: this.config.agentUser,
      // Inside the workdir, so it inherits the run's ACE. Provisioning created
      // it in the same `if (agentUser)` branch that applied that ACE.
      runTmpDir: this.config.agentUser
        ? path.join(this.workdir, "tmp")
        : null,
    });
    return this.env;
  }

  /**
   * Fail-closed gh-auth precondition (ADR-002 F3). Run BEFORE start(): confirm `gh`
   * authenticates (as the bot, via the injected token + isolated config) inside the
   * workdir with the sanitized env. Throws if it can't — the run is blocked rather
   * than spawning an agent that would post as the wrong identity or fail to push.
   */
  async preflightGhAuth(
    exec?: Parameters<typeof verifyGhAuth>[0]["exec"],
  ): Promise<void> {
    const result = await verifyGhAuth({
      workdir: this.workdir,
      env: this.ensureEnv(),
      exec,
    });
    if (!result.ok) {
      throw new Error(
        `gh auth precondition failed — blocking run (agent would post as the wrong identity): ${result.detail}`,
      );
    }
  }

  /** Spawn the daemon (own process group) and wait until its socket accepts. */
  async start(): Promise<void> {
    // Ensure this worker's namespaced run dir exists, then clean only THIS run's
    // own stale socket/pid (a prior crashed run of the SAME threadId under this
    // worker). Cross-worker orphans are handled by boot-reclaim (reclaim.ts), never
    // here — this method must never touch another run's or worker's resources.
    fs.mkdirSync(this.runDir, { recursive: true });
    this.cleanOwnStaleFiles();

    // #108: TWO grants on this worker's run-namespace dir, because it is a
    // CROSS-UID RENDEZVOUS in both directions. The agent uid must be able to
    // BIND the daemon socket and write the wrapper's pidfile here; the worker's
    // own login must be able to CONNECT to a socket the agent uid created.
    // Darwin enforces unix-socket permissions (unix(4); XNU unp_connect →
    // vnode_authorize(KAUTH_VNODE_WRITE_DATA)) and node binds sockets 0755, so
    // without the second grant writeDaemonMessage() cannot reach the daemon at
    // all. bind(2)-created sockets DO inherit ACEs (verified on 15.7.3/APFS),
    // so neither the daemon's bind nor gh-broker.ts needs to change.
    //
    // NAMED AND DELIBERATE: this also exposes the UNAUTHENTICATED daemon socket
    // (daemon/src/runtime.ts) to the agent uid. The agent already holds
    // DAEMON_TOKEN, so this widens no trust boundary that was closed before.
    if (this.config.agentUser) {
      await applyTraverseAce({
        dir: this.config.runNamespaceRoot,
        users: [this.config.agentUser],
        exec: this.deps.aceExec,
        platform: this.deps.platform,
      });
      await applyInheritableAces({
        dir: this.runDir,
        users: [this.config.agentUser, os.userInfo().username],
        exec: this.deps.aceExec,
        platform: this.deps.platform,
      });
    }

    const env = this.ensureEnv();

    // #108: with agentUser empty this returns the command UNCHANGED and an empty
    // env — byte-for-byte today's spawn.
    const invocation = buildSpawnInvocation({
      agentUser: this.config.agentUser,
      file: this.config.nodeBin,
      args: [
        this.config.daemonDist,
        "--url",
        this.input.daemonCallbackUrl,
        "--socket-path",
        this.socketPath,
      ],
      pidFilePath: this.pidFilePath,
    });

    this.child = (this.deps.spawnFn ?? spawn)(invocation.file, invocation.args, {
      cwd: this.workdir,
      // sudo -E forwards THIS env (spawn's `env` REPLACES the child's), not the
      // operator's ambient one — buildDaemonEnv already whitelisted it.
      env: { ...env, ...invocation.env },
      detached: true, // own process group — see class doc
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Daemon stdout is agent output; it flows to www via events. We do not
    // forward or store it here (H2: keep prompt/agent content off the worker box).
    this.child.stdout?.resume();
    // stderr is kept as a BOUNDED, REDACTED tail only, and only to explain a
    // failed start. Without it a missing SETENV in sudoers ("sorry, you are not
    // allowed to preserve the environment") surfaces as a bare 15s socket
    // timeout naming nothing.
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = redactSecrets(
        (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES),
      );
    });
    this.child.stderr?.resume();

    this.pgid = await this.resolvePgid();

    await this.waitForSocket();
  }

  /**
   * Determine the process group to signal at teardown, and make sure the
   * pidfile holds it (boot-reclaim reads that file).
   *
   * Default mode: `child.pid` IS the group leader (detached spawn); the worker
   * writes the pidfile, exactly as before.
   *
   * Agent-uid mode: the sudo wrapper wrote its own `$$` there before exec'ing,
   * because sudo may fork a monitor that setsid()s and setpgid()s the command
   * into a group the pre-sudo pid names neither of. We WAIT for that value
   * rather than overwrite it.
   */
  private async resolvePgid(): Promise<number | null> {
    if (!this.config.agentUser) {
      const pid = this.child?.pid ?? null;
      if (pid != null) {
        try {
          fs.writeFileSync(this.pidFilePath, String(pid));
        } catch {
          // best-effort — reclaim just won't fire if we can't persist the pid
        }
      }
      return pid;
    }
    const deadline = Date.now() + WRAPPER_PIDFILE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child?.exitCode != null) {
        break; // the spawn already failed; waitForSocket reports why
      }
      try {
        const raw = fs.readFileSync(this.pidFilePath, "utf8").trim();
        const pid = Number(raw);
        if (Number.isInteger(pid) && pid > 0) {
          return pid;
        }
      } catch {
        // not written yet
      }
      await delay(50);
    }
    // No pgid means teardown cannot reap the group. Surface it rather than
    // leaking a live agent silently.
    throw new Error(
      `daemon wrapper never recorded its process group in ${this.pidFilePath}` +
        (this.stderrTail ? `: ${this.stderrTail.trim()}` : ""),
    );
  }

  /**
   * Assemble the full DaemonMessage (pulled body + the ids/token the daemon still
   * needs) and write it to the daemon's socket to start the run. Never logs the
   * message (H2 — it carries the prompt).
   */
  async sendMessage(pulled: PulledDaemonMessage): Promise<number> {
    const message = {
      ...pulled,
      token: this.input.daemonToken,
      threadId: this.input.threadId,
      threadChatId: this.input.threadChatId,
    };
    const dataStr = JSON.stringify(message);
    await this.writeToSocket(dataStr);
    return dataStr.length; // byte count for step logging (not the content — H2)
  }

  /**
   * The daemon's process-GROUP pid (undefined before start / after teardown).
   * In default mode this is the spawned child's own pid.
   */
  get pid(): number | undefined {
    return this.pgid ?? this.child?.pid;
  }

  /** SIGKILL the daemon's process group. Best-effort and idempotent. */
  teardown(): void {
    const pid = this.pgid ?? this.child?.pid ?? null;
    this.child = null;
    this.pgid = null;
    // Clear this run's own pid + socket file first so a later reclaim doesn't target
    // a recycled pid and the next same-threadId run binds clean.
    try {
      fs.rmSync(this.pidFilePath, { force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(this.socketPath, { force: true });
    } catch {
      // ignore
    }
    if (this.ghConfigDir) {
      try {
        fs.rmSync(this.ghConfigDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      this.ghConfigDir = null;
    }
    this.env = null;
    if (pid == null) {
      return;
    }
    const killInvocation = buildKillInvocation({
      agentUser: this.config.agentUser,
      pgid: pid,
    });
    if (killInvocation) {
      // Cross-uid: process.kill(-pid) from the worker's uid is EPERM. Shell out
      // as the agent account so the kernel's own kill(2) check permits it.
      // Fire-and-forget — teardown() is sync and best-effort by contract.
      try {
        (this.deps.spawnFn ?? spawn)(
          killInvocation.file,
          killInvocation.args,
          { stdio: "ignore" },
        ).unref();
      } catch {
        // already gone
      }
      return;
    }
    try {
      process.kill(-pid, "SIGKILL"); // negative pid → the whole process group
    } catch {
      // already gone
    }
  }

  /**
   * Remove only THIS run's own stale socket/pid before spawning — e.g. a prior
   * crashed run of the SAME threadId under this worker left files behind. It must
   * NOT touch any other run's or worker's resources; cross-worker orphan reaping is
   * boot-reclaim's job (reclaim.ts, which group-SIGKILLs a dead worker's daemons).
   */
  private cleanOwnStaleFiles(): void {
    try {
      fs.rmSync(this.pidFilePath, { force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(this.socketPath, { force: true });
    } catch {
      // the daemon unlinks/rebinds the socket itself; this is belt-and-suspenders
    }
  }

  private async waitForSocket(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      if (this.child?.exitCode != null) {
        throw new Error(
          `daemon exited before its socket was ready (code ${this.child.exitCode})` +
            (this.stderrTail ? `: ${this.stderrTail.trim()}` : ""),
        );
      }
      try {
        await this.probeSocket();
        return;
      } catch (err) {
        lastErr = err;
        await delay(200);
      }
    }
    throw new Error(
      `daemon socket not ready after ${timeoutMs}ms: ${String(lastErr)}`,
    );
  }

  private probeSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
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

  private writeToSocket(dataStr: string): Promise<void> {
    return writeDaemonMessage(this.socketPath, dataStr);
  }
}

/**
 * Write one DaemonMessage over the daemon's unix-socket protocol and wait for its
 * ACK. The daemon's socket server (DaemonRuntime.listenToUnixSocket) expects a
 * WRAPPED envelope `{ id, data }` where `data` is the STRINGIFIED DaemonMessage —
 * it JSON.parses the frame, hands the inner `data` to the message parser, and
 * replies `{ status: "ACK"|"ERROR", id }`. Writing the raw message instead makes
 * the daemon read `payloadData: undefined` → it never runs the agent and the run
 * idles to the schedule timeout. This mirrors the daemon's own writeToUnixSocket.
 */
export function writeDaemonMessage(
  socketPath: string,
  dataStr: string,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const msgId = randomUUID();
    let settled = false;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      finish(() =>
        reject(new Error(`daemon socket write timed out after ${timeoutMs}ms`)),
      );
    }, timeoutMs);

    sock.once("connect", () => {
      sock.write(JSON.stringify({ id: msgId, data: dataStr }));
    });
    sock.on("data", (buffer) => {
      let response: { id?: string; status?: string; error?: string };
      try {
        response = JSON.parse(buffer.toString());
      } catch {
        return; // partial/other frame — keep waiting
      }
      if (response.id !== msgId) {
        return;
      }
      clearTimeout(timer);
      sock.end();
      if (response.status === "ACK") {
        finish(resolve);
      } else {
        // #6: the daemon rejecting the message is a terminal contract error (the
        // message won't parse/run), not a transient blip → NonRetryableError so it
        // routes straight to onFailure instead of burning a retry.
        finish(() =>
          reject(
            new NonRetryableError(
              `daemon rejected the message: ${response.error ?? response.status ?? "unknown"}`,
            ),
          ),
        );
      }
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      sock.destroy();
      finish(() => reject(err));
    });
    sock.once("close", () => {
      clearTimeout(timer);
      finish(() =>
        reject(new Error("daemon socket closed before ACK was received")),
      );
    });
  });
}

/** Cap on the retained stderr tail (bytes). Diagnostics only, never content. */
const STDERR_TAIL_BYTES = 4096;

/** How long the sudo wrapper gets to record its own pgid. */
const WRAPPER_PIDFILE_TIMEOUT_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
