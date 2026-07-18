import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { defaultUnixSocketPath } from "@terragon/daemon/shared";
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
 * Single shared socket path: the daemon bundle binds a FIXED socket
 * (defaultUnixSocketPath) with no override flag, so two daemons on one box would
 * collide. The agent-run workflow serialises runs (Hatchet concurrency, maxRuns 1)
 * to keep exactly one daemon alive at a time. Lifting that requires a daemon
 * `--socket-path` flag (tracked for post-pilot).
 */
export class DaemonProcess {
  private child: ChildProcess | null = null;
  private readonly socketPath = defaultUnixSocketPath;

  constructor(
    private readonly config: WorkerConfig,
    private readonly input: AgentRunInput,
    private readonly workdir: string,
  ) {}

  /** Spawn the daemon (own process group) and wait until its socket accepts. */
  async start(): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ANTHROPIC_API_KEY: this.config.anthropicApiKey,
    };
    if (this.config.claudeBinDir) {
      env.PATH = `${this.config.claudeBinDir}:${process.env.PATH ?? ""}`;
    }

    this.child = spawn(
      this.config.nodeBin,
      [this.config.daemonDist, "--url", this.input.daemonCallbackUrl],
      {
        cwd: this.workdir,
        env,
        detached: true, // own process group — see class doc
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // Daemon stdout/stderr is agent output; it flows to www via events. We do not
    // forward or store it here (H2: keep prompt/agent content off the worker box).
    this.child.stdout?.resume();
    this.child.stderr?.resume();

    await this.waitForSocket();
  }

  /**
   * Assemble the full DaemonMessage (pulled body + the ids/token the daemon still
   * needs) and write it to the daemon's socket to start the run. Never logs the
   * message (H2 — it carries the prompt).
   */
  async sendMessage(pulled: PulledDaemonMessage): Promise<void> {
    const message = {
      ...pulled,
      token: this.input.daemonToken,
      threadId: this.input.threadId,
      threadChatId: this.input.threadChatId,
    };
    await this.writeToSocket(JSON.stringify(message));
  }

  /** SIGKILL the daemon's process group. Best-effort and idempotent. */
  teardown(): void {
    const pid = this.child?.pid;
    if (pid == null) {
      return;
    }
    try {
      process.kill(-pid, "SIGKILL"); // negative pid → the whole process group
    } catch {
      // already gone
    }
    this.child = null;
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
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      sock.once("connect", () => {
        sock.write(dataStr, (err) => {
          if (err) {
            reject(err);
            return;
          }
          sock.end();
        });
      });
      sock.once("end", () => resolve());
      sock.once("close", () => resolve());
      sock.once("error", (err) => {
        sock.destroy();
        reject(err);
      });
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
