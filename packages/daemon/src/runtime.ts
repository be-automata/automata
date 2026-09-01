/**
 * Provides runtime context and system operations for the daemon.
 */

import { execSync, spawn } from "node:child_process";
import EventEmitter from "node:events";
import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";
import stripAnsi from "strip-ansi";
import { Logger, OutputFormat } from "./logger";
import { DaemonEventAPIBody } from "./shared";
import { nanoid } from "nanoid/non-secure";
import { postJson } from "./proxy-fetch";

export interface IDaemonRuntime {
  url: string;
  unixSocketPath: string;
  readonly logger: Logger;
  readonly normalizedUrl: string;

  teardown: () => Promise<void>;
  onTeardown: (callback: () => Promise<void> | void) => void;

  serverPost: (body: DaemonEventAPIBody, token: string) => Promise<void>;

  listenToUnixSocket: (callback: (data: string) => void) => Promise<void>;

  exitProcess: () => void;
  killChildProcessGroup: (pid: number) => void;
  execSync: (command: string) => string;

  writeFileSync: (path: string, data: string) => void;
  readFileSync: (path: string) => string;
  appendFileSync: (path: string, data: string) => void;

  spawnCommandLine: (
    command: string,
    {
      env,
      onStdoutLine,
      onStderr,
      onError,
      onClose,
    }: {
      env: Record<string, string | undefined>;
      onStdoutLine: (line: string) => void;
      onStderr: (data: string) => void;
      onError: (error: Error) => void;
      onClose: (code: number | null) => void;
    },
  ) => {
    processId: number | undefined;
    pollInterval: NodeJS.Timeout | undefined;
  };

  spawnCommand: (
    command: string,
    {
      env,
      onStdout,
      onStderr,
      onError,
      onClose,
    }: {
      env: Record<string, string>;
      onStdout: (data: string) => void;
      onStderr: (data: string) => void;
      onError: (error: Error) => void;
      onClose: (code: number | null) => void;
    },
  ) => {
    processId: number | undefined;
    pollInterval: NodeJS.Timeout | undefined;
  };
}

export class DaemonRuntime implements IDaemonRuntime {
  readonly url: string;
  readonly logger: Logger;
  readonly unixSocketPath: string;
  private skipReportingDaemonEvents: boolean = false;
  private isTerminated = false;
  private eventEmitter = new EventEmitter();
  private sigtermHandler: NodeJS.SignalsListener;
  private sigintHandler: NodeJS.SignalsListener;
  private unixSocketServer: net.Server | null = null;

  constructor({
    url,
    unixSocketPath,
    outputFormat,
    skipReportingDaemonEvents,
  }: {
    url: string;
    unixSocketPath: string;
    outputFormat: OutputFormat;
    skipReportingDaemonEvents?: boolean;
  }) {
    this.url = url;
    this.unixSocketPath = unixSocketPath;
    this.logger = new Logger(outputFormat);
    this.skipReportingDaemonEvents = !!skipReportingDaemonEvents;
    this.sigtermHandler = (signal) => {
      this.logger.info("SIGTERM received", { signal });
      this.teardown();
    };
    this.sigintHandler = (signal) => {
      this.logger.info("SIGINT received", { signal });
      this.teardown();
    };
    process.on("SIGTERM", this.sigtermHandler);
    process.on("SIGINT", this.sigintHandler);

    // Create the Unix socket file only if createServer is true
    this.createUnixSocket();
  }

  get normalizedUrl() {
    return this.url.replace(/\/+$/, "");
  }

  private createUnixSocket() {
    // Remove the socket file if it exists
    if (fs.existsSync(this.unixSocketPath)) {
      fs.unlinkSync(this.unixSocketPath);
    }
    // Create the Unix socket server
    this.unixSocketServer = net.createServer();
    this.unixSocketServer.listen(this.unixSocketPath);
    this.unixSocketServer.on("listening", () => {
      this.logger.info("Unix socket server listening");
    });
    this.unixSocketServer.on("error", (error) => {
      this.logger.error("Unix socket server error", { error });
    });
    // Register cleanup on teardown
    this.onTeardown(() => {
      if (this.unixSocketServer) {
        this.unixSocketServer.close();
        this.unixSocketServer = null;
      }
      if (fs.existsSync(this.unixSocketPath)) {
        fs.unlinkSync(this.unixSocketPath);
      }
    });
  }

  async teardown() {
    if (this.isTerminated) {
      return;
    }
    this.isTerminated = true;
    // Remove signal handlers to prevent memory leaks
    process.off("SIGTERM", this.sigtermHandler);
    process.off("SIGINT", this.sigintHandler);
    await Promise.allSettled(
      this.eventEmitter.listeners("teardown").map((fn) => fn()),
    );
    this.exitProcess();
  }

  execSync(command: string) {
    return execSync(command, {
      encoding: "utf-8",
    });
  }

  exitProcess() {
    // Ideally we can use process.exit(0) here, but if we have active handles
    // or requests, the process will not exit properly. So lets kill the process
    // forcefully.
    process.kill(-process.pid, "SIGKILL");
  }

  onTeardown(callback: () => Promise<void> | void) {
    this.eventEmitter.on("teardown", callback);
  }

  async serverPost(body: any, token: string) {
    const url = `${this.url}/api/daemon-event`;
    const logArgs = { url, body: JSON.stringify(body) };
    if (this.skipReportingDaemonEvents) {
      this.logger.info(`[SKIPPED] POST to ${url}`, logArgs);
      return;
    }
    this.logger.info(`POST to ${url}`, logArgs);
    // #108 D1: this POST must survive a host-level 443 block on the agent uid.
    // postJson is plain `fetch` — today's exact behaviour — unless the worker
    // set AUTOMATA_DAEMON_CALLBACK_VIA_PROXY=1, which it does ONLY in agent-uid
    // mode (F5). A run that merely carries an egress policy is unaffected.
    const response = await postJson({
      url,
      headers: {
        "Content-Type": "application/json",
        "X-Daemon-Token": token,
      },
      body: JSON.stringify(body),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  }

  async listenToUnixSocket(
    callback: (dataStr: string) => Promise<void> | void,
  ) {
    if (this.isTerminated) {
      return;
    }
    if (!this.unixSocketServer) {
      throw new Error("Unix socket server is not initialized");
    }
    // Remove all previous listeners to avoid duplicate handlers
    this.unixSocketServer.removeAllListeners("connection");
    this.unixSocketServer.on("connection", (socket) => {
      let buffer = "";

      socket.on("data", async (socketData) => {
        buffer += socketData.toString();
        // Try to parse accumulated buffer as JSON
        let parsedPayload: { id: string; data: string } | null = null;
        try {
          parsedPayload = JSON.parse(buffer);
          // Successfully parsed - clear buffer
          buffer = "";
        } catch (e) {
          // Ignore continue to accumulate buffer
        }
        if (!parsedPayload) {
          return;
        }
        const { id, data: payloadData } = parsedPayload;
        try {
          await callback(payloadData);
          const ack = JSON.stringify({ status: "ACK", id });
          socket.write(ack, () => {});
        } catch (e) {
          this.logger.error("Error handling unix socket message", {
            error: e,
            payloadData,
          });
          const error = JSON.stringify({ status: "ERROR", id, error: e + "" });
          socket.write(error, () => {});
        }
      });
      socket.on("end", () => {
        this.logger.info("Unix socket connection ended");
        this.listenToUnixSocket(callback);
      });
      socket.on("error", (error) => {
        this.logger.error("Unix socket connection error", { error });
        this.listenToUnixSocket(callback);
      });
    });

    // Wait for the server to be ready
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  killChildProcessGroup(pid: number) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      this.logger.error("Error killing child process group", { error });
    }
  }

  spawnCommandLine(
    command: string,
    {
      env,
      onStdoutLine,
      onStderr,
      onError,
      onClose,
    }: {
      env: Record<string, string | undefined>;
      onStdoutLine: (line: string) => void;
      onStderr: (data: string) => void;
      onError: (error: Error) => void;
      onClose: (code: number | null) => void;
    },
  ): {
    processId: number | undefined;
    pollInterval: NodeJS.Timeout | undefined;
  } {
    const child = spawn("bash", ["-lc", command], {
      env,
      detached: true,
      stdio: ["inherit", "pipe", "pipe"],
    });

    let closeHandled = false;
    let pollInterval: NodeJS.Timeout | undefined;
    let rl: readline.Interface | undefined;
    let errorToReport: Error | null = null;
    const handleClose = (
      code: number | null,
      source: string,
      error?: Error,
    ) => {
      if (closeHandled) {
        return;
      }
      closeHandled = true;
      if (pollInterval) {
        clearInterval(pollInterval);
      }
      // Close readline interface to ensure cleanup happens promptly
      if (rl) {
        rl.close();
      }
      this.logger.info("Process close handled", {
        pid: child.pid,
        code,
        source,
      });
      // Call onError after cleanup, if there was an error
      if (error || errorToReport) {
        onError(error || errorToReport!);
      }
      onClose(code);
    };

    // Use readline to process output line by line
    if (child.stdout) {
      rl = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity, // Handle Windows line endings properly
      });
      rl.on("line", (line) => {
        if (line.trim()) {
          onStdoutLine(stripAnsi(line));
        }
      });
      // Handle stdout stream closing
      child.stdout.on("end", () => {
        if (rl) {
          rl.close();
        }
      });
    } else {
      this.logger.warn("No stdout available");
    }
    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        const output = data.toString();
        onStderr(output);
      });
    } else {
      this.logger.warn("No stderr available");
    }

    // Listen for both 'exit' and 'close' events
    // 'exit' fires when the process exits (more reliable for detached processes)
    // 'close' fires when all stdio streams are closed
    child.on("exit", (code) => {
      handleClose(code, "exit");
    });
    child.on("close", (code) => {
      handleClose(code, "close");
    });
    child.on("error", (error) => {
      handleClose(null, "error", error);
    });

    // Fallback: Poll every 2 seconds to check if process is still alive
    // This handles the case where neither 'exit' nor 'close' fires
    const pid = child.pid;
    if (pid) {
      pollInterval = setInterval(() => {
        try {
          // Sending signal 0 checks if process exists without killing it
          process.kill(pid, 0);
        } catch (error) {
          // Process doesn't exist anymore
          this.logger.warn("Process no longer exists (detected via polling)", {
            pid,
          });
          handleClose(null, "poll");
        }
      }, 2000);
    }
    return { processId: child.pid, pollInterval };
  }

  spawnCommand(
    command: string,
    {
      env,
      onStdout,
      onStderr,
      onError,
      onClose,
    }: {
      env: Record<string, string>;
      onStdout: (data: string) => void;
      onStderr: (data: string) => void;
      onError: (error: Error) => void;
      onClose: (code: number | null) => void;
    },
  ): {
    processId: number | undefined;
    pollInterval: NodeJS.Timeout | undefined;
  } {
    const child = spawn("bash", ["-lc", command], {
      env,
      detached: true,
      stdio: ["inherit", "pipe", "pipe"],
    });

    let closeHandled = false;
    let pollInterval: NodeJS.Timeout | undefined;
    let errorToReport: Error | null = null;
    const handleClose = (
      code: number | null,
      source: string,
      error?: Error,
    ) => {
      if (closeHandled) {
        return;
      }
      closeHandled = true;
      if (pollInterval) {
        clearInterval(pollInterval);
      }
      this.logger.info("Process close handled", {
        pid: child.pid,
        code,
        source,
      });
      // Call onError after cleanup, if there was an error
      if (error || errorToReport) {
        onError(error || errorToReport!);
      }
      onClose(code);
    };

    // Stream raw data as it comes in
    if (child.stdout) {
      child.stdout.on("data", (data: Buffer) => {
        const output = stripAnsi(data.toString());
        onStdout(output);
      });
    } else {
      this.logger.warn("No stdout available");
    }
    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        const output = data.toString();
        onStderr(output);
      });
    } else {
      this.logger.warn("No stderr available");
    }

    // Listen for both 'exit' and 'close' events
    // 'exit' fires when the process exits (more reliable for detached processes)
    // 'close' fires when all stdio streams are closed
    child.on("exit", (code) => {
      handleClose(code, "exit");
    });
    child.on("close", (code) => {
      handleClose(code, "close");
    });
    child.on("error", (error) => {
      handleClose(null, "error", error);
    });

    // Fallback: Poll every 2 seconds to check if process is still alive
    // This handles the case where neither 'exit' nor 'close' fires
    const pid = child.pid;
    if (pid) {
      pollInterval = setInterval(() => {
        try {
          // Sending signal 0 checks if process exists without killing it
          process.kill(pid, 0);
        } catch (error) {
          // Process doesn't exist anymore
          this.logger.warn("Process no longer exists (detected via polling)", {
            pid,
          });
          handleClose(null, "poll");
        }
      }, 2000);
    }

    return { processId: child.pid, pollInterval };
  }

  readFileSync(path: string) {
    return fs.readFileSync(path, "utf8");
  }

  writeFileSync(path: string, data: string) {
    return fs.writeFileSync(path, data, "utf8");
  }

  appendFileSync(path: string, data: string) {
    return fs.appendFileSync(path, data);
  }
}

export async function writeToUnixSocket({
  unixSocketPath,
  dataStr,
  timeout = 100,
}: {
  unixSocketPath: string;
  dataStr: string;
  timeout?: number;
}) {
  await Promise.race([
    new Promise((_, reject) =>
      setTimeout(() => {
        reject(
          new Error(
            `Timeout after ${timeout}ms. It is likely that the unix socket is not ready to be written to. This is probably because the server is not running.`,
          ),
        );
      }, timeout),
    ),
    new Promise<void>((resolve, reject) => {
      const msgId = nanoid();
      let resolved = false;
      const client = net.createConnection({ path: unixSocketPath }, () => {
        const payloadStr = JSON.stringify({
          id: msgId,
          data: dataStr,
        });
        client.write(payloadStr, () => {});
      });
      client.on("data", (buffer) => {
        try {
          const response = JSON.parse(buffer.toString());
          if (response.id === msgId) {
            if (response.status === "ACK") {
              resolved = true;
              client.end();
              resolve();
            } else if (response.status === "ERROR") {
              reject(new Error(response.error));
            } else {
              reject(
                new Error(`Unexpected response: ${JSON.stringify(response)}`),
              );
            }
          }
        } catch (e) {
          console.error("Error parsing message", {
            error: e,
            bufferStr: buffer.toString(),
          });
        }
      });
      client.on("error", (err) => {
        console.error("Error on unix socket", { error: err });
        reject(err);
      });

      client.on("close", () => {
        if (!resolved) {
          reject(new Error("Unix socket closed before ACK received"));
        }
      });
    }),
  ]);
}
