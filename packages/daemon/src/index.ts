#!/usr/bin/env node

import { parseArgs } from "node:util";
import { TerragonDaemon } from "./daemon.js";
import { DaemonRuntime, writeToUnixSocket } from "./runtime.js";
import { defaultUnixSocketPath, DAEMON_VERSION } from "./shared.js";

/**
 * Terragon Daemon Service
 *
 * A daemon service that listens to a unix socket for configuration and sends messages.
 */

// Parse command line arguments
function parseCliArgs(): {
  version: boolean;
  write: boolean;
  timeout: number;
  url: string;
  outputFormat: "text" | "json";
  mcpConfigPath: string | undefined;
  skipReportingDaemonEvents: boolean;
  socketPath: string | undefined;
} {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      version: {
        type: "boolean",
        short: "v",
      },
      url: {
        type: "string",
        short: "u",
        default: "http://localhost:3000",
      },
      // Override the unix socket path (default: /tmp/terragon-daemon.sock). The
      // execution-plane worker passes a PER-RUN path so N daemons on one box no
      // longer collide on the fixed socket — the single unlock for per-run daemon
      // isolation (enterprise-hardening Phase 0.2). Additive: default unchanged.
      "socket-path": {
        type: "string",
      },
      "output-format": {
        type: "string",
        default: "text",
      },
      "skip-reporting-daemon-events": {
        type: "boolean",
        default: false,
      },
      "mcp-config-path": {
        type: "string",
      },
      write: {
        type: "boolean",
        default: false,
      },
      timeout: {
        type: "string",
        default: "2000",
      },
      help: {
        type: "boolean",
        short: "h",
      },
    },
    strict: false,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
Usage: terragon-daemon [options]
Version: v${DAEMON_VERSION}

Options:
  -v, --version                    Show version
  -u, --url <url>                  Server URL (default: http://localhost:3000)
  -w, --write                      Write a message to the unix socket (default: false)
  -t, --timeout <timeout>          Timeout in milliseconds (default: 2000)
  --socket-path <path>             Unix socket path (default: /tmp/terragon-daemon.sock)
  --skip-reporting-daemon-events   Skip reporting daemon events (default: false)
  --output-format <format>         Output format: text or json (default: text)
  --mcp-config-path <path>         MCP config path
  -h, --help                       Show this help message

The daemon will create a unix socket at /tmp/terragon-daemon.sock and listen for JSON messages with:
{
  "token": "string",
  "prompt": "string", 
  "sessionId": "string|null",
  "model": "opus|sonnet"
}

Examples:
  terragon-daemon
  terragon-daemon -u https://api.example.com
  terragon-daemon --output-format json
  terragon-daemon --skip-reporting-daemon-events
  terragon-daemon --output-format json --mcp-config-path /tmp/mcp-server.json
  
  # Send a message to the daemon:

  cat msg.json | terragon-daemon --write
  echo '{"type":"ping"}' | terragon-daemon --write
`);
    process.exit(0);
  }

  const outputFormat = values["output-format"] as string;
  if (outputFormat !== "text" && outputFormat !== "json") {
    console.error("❌ Invalid output format. Must be 'text' or 'json'");
    process.exit(1);
  }

  return {
    version: !!values["version"],
    write: !!values["write"],
    url: values["url"] as string,
    outputFormat: outputFormat as "text" | "json",
    mcpConfigPath: values["mcp-config-path"] as string | undefined,
    skipReportingDaemonEvents: !!values["skip-reporting-daemon-events"],
    socketPath: (values["socket-path"] as string | undefined) || undefined,
    timeout: parseInt(values["timeout"] as string, 10) || 2000,
  };
}

async function readStdinOrTimeout(timeoutMs: number): Promise<string> {
  const result = await Promise.race([
    new Promise<string>((resolve) => {
      let stdinData = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        stdinData += chunk;
      });
      process.stdin.on("end", () => {
        resolve(stdinData);
      });
    }),
    new Promise<{ timeout: true }>((reject) => {
      setTimeout(() => {
        reject({ timeout: true });
      }, timeoutMs);
    }),
  ]);
  if (typeof result === "object" && "timeout" in result) {
    throw new Error("Timeout reading stdin");
  }
  return result;
}

// Parse arguments and start the daemon
try {
  const cliArgs = parseCliArgs();
  if (cliArgs.version) {
    console.log(`Terragon Daemon v${DAEMON_VERSION}`);
    process.exit(0);
  }
  const unixSocketPath = cliArgs.socketPath ?? defaultUnixSocketPath;
  if (cliArgs.write) {
    const timeoutMs = cliArgs.timeout;
    const startTime = Date.now();
    readStdinOrTimeout(timeoutMs)
      .then((stdinData) => {
        return writeToUnixSocket({
          unixSocketPath,
          dataStr: stdinData,
          timeout: timeoutMs,
        });
      })
      .then(() => {
        console.log(
          `Message written to unix socket (took ${Date.now() - startTime}ms)`,
        );
        process.exit(0);
      })
      .catch((error) => {
        console.error("❌ Failed to write message to unix socket:", error);
        process.exit(1);
      });
  } else {
    const runtime = new DaemonRuntime({
      url: cliArgs.url,
      outputFormat: cliArgs.outputFormat,
      unixSocketPath,
      skipReportingDaemonEvents: cliArgs.skipReportingDaemonEvents,
    });
    const daemon = new TerragonDaemon({
      runtime,
      mcpConfigPath: cliArgs.mcpConfigPath,
    });
    daemon.start().catch((error) => {
      console.error("❌ Failed to start daemon:", error);
      process.exit(1);
    });
  }
} catch (error) {
  console.error("❌ Failed to parse arguments:", error);
  process.exit(1);
}
