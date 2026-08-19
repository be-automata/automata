import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import { buildDaemonEnv } from "./daemon-env";
import {
  getProcessWorkerId,
  runPidPath,
  runSocketPath,
  workerRunDir,
} from "./run-namespace";
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
      home: string | null;
      delivered: boolean;
      env: Record<string, string>;
    } | null = null,
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

    const env = this.ensureEnv();

    this.child = spawn(
      this.config.nodeBin,
      [
        this.config.daemonDist,
        "--url",
        this.input.daemonCallbackUrl,
        "--socket-path",
        this.socketPath,
      ],
      {
        cwd: this.workdir,
        env,
        detached: true, // own process group — see class doc
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // TEMP DEBUG (uncommitted): tee daemon output to a local file to catch a
    // fast agent crash whose stderr is otherwise dropped. Operator's own box.
    const dbg = fs.createWriteStream("/tmp/automata-daemon-debug.log", { flags: "a" });
    dbg.write(`\n===== run ${this.input.threadId} ${new Date().toISOString()} =====\n`);
    this.child.stdout?.on("data", (d) => dbg.write(d));
    this.child.stderr?.on("data", (d) => dbg.write(d));

    if (this.child.pid != null) {
      try {
        fs.writeFileSync(this.pidFilePath, String(this.child.pid));
      } catch {
        // best-effort — reclaim just won't fire if we can't persist the pid
      }
    }

    await this.waitForSocket();
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

  /** The spawned daemon's pid (undefined before start / after teardown). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** SIGKILL the daemon's process group. Best-effort and idempotent. */
  teardown(): void {
    const pid = this.child?.pid;
    this.child = null;
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
          `daemon exited before its socket was ready (code ${this.child.exitCode})`,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
