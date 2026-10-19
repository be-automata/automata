// Stdio MCP filter proxy for a harness pack's MCP server (install-batteries.sh
// copies it into the pack as lib/mcp-filter.mjs; the pack's root-owned wrapper
// execs it).
//
//   node mcp-filter.mjs <allowlist.json> -- <server command> [args...]
//
// Why a proxy: the upstream server's own tool selection (`mcp start --tools`,
// CLAUDE_FLOW_MCP_TOOLS in ruflo 3.56.7) only trims the ADVERTISED catalogue —
// "Execution remains registered internally", so a client that names a hidden
// tool still runs it. Here the allowlist is enforced on both paths:
//
// - client -> server: only the METHODS an MCP tool client needs pass
//   (initialize, ping, tools/list, tools/call, notifications/*, and responses
//   to server requests); any other request is answered -32601 and never
//   forwarded, and a `tools/call` for a name not on the list is refused the
//   same way;
// - server -> client `tools/list` results are reduced to the list.
//
// What is forwarded is the re-serialised object the filter inspected, never the
// raw client bytes. MCP stdio frames are one JSON-RPC message per line; a frame
// that is not a JSON object (a batch array, garbage) or is longer than
// MAX_LINE is refused. Non-JSON server stdout is diverted to stderr so it
// cannot corrupt the client's stream.
//
// This is a GUARDRAIL for the agent's MCP channel, not a sandbox: an agent with
// a shell can still run the server binary (or its node modules) directly and
// reach every tool. The fence against that is the run's uid, cgroup and egress
// policy, not this proxy.

import { spawn } from "node:child_process";
import fs from "node:fs";

const DENIED = -32601;
const INVALID = -32600;
/** Longest frame accepted in either direction (a full tools/list fits easily). */
const MAX_LINE = 16 * 1024 * 1024;
const ALLOWED_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
]);

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
if (separator !== 1 || argv.length < 3) {
  process.stderr.write(
    "usage: mcp-filter.mjs <allowlist.json> -- <command> [args...]\n",
  );
  process.exit(2);
}
const allowlistPath = argv[0];
const [command, ...commandArgs] = argv.slice(2);

const parsed = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === "string")) {
  process.stderr.write(`mcp-filter: ${allowlistPath} is not a string array\n`);
  process.exit(2);
}
const allowed = new Set(parsed);

// The server's environment is built HERE, exhaustively, from an allowlist —
// never inherited. The wrapper's shell scrub is belt and braces: `unset`
// cannot remove a variable whose name is not a shell identifier (`BASH_FUNC_x%%`,
// names with `-` or `.`), and such entries pass straight through an exec. Only
// PATH/HOME/LANG, the proxy settings (#205: HTTPS_PROXY carries the run's proxy
// credential at N > 1, which is why none of this ever goes through an argv) and
// the pack's own mcpServe.env names (AUTOMATA_MCP_ENV_KEYS, comma-separated,
// written by install-batteries.sh) reach the server.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BASE_ENV_NAMES = [
  "PATH",
  "HOME",
  "LANG",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
];
const packEnvNames = (process.env.AUTOMATA_MCP_ENV_KEYS ?? "")
  .split(",")
  .map((k) => k.trim())
  .filter((k) => k !== "" && ENV_NAME.test(k));
const childEnv = {};
for (const name of [...BASE_ENV_NAMES, ...packEnvNames]) {
  const value = process.env[name];
  if (value !== undefined) childEnv[name] = value;
}

const child = spawn(command, commandArgs, {
  stdio: ["pipe", "pipe", "inherit"],
  env: childEnv,
});
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const refuse = (id, code, message) => {
  if (id !== undefined && id !== null) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }
};
const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isAllowedMethod = (method) =>
  typeof method === "string" &&
  (ALLOWED_METHODS.has(method) || method.startsWith("notifications/"));

/** Calls onLine per newline-terminated line; an over-long line is dropped whole. */
function onLines(stream, onLine, onOversize) {
  let buffer = "";
  let skipping = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    let start = 0;
    let index;
    while ((index = chunk.indexOf("\n", start)) !== -1) {
      const piece = chunk.slice(start, index);
      start = index + 1;
      if (skipping) {
        skipping = false;
        buffer = "";
        continue;
      }
      const line = buffer + piece;
      buffer = "";
      if (line.length > MAX_LINE) {
        onOversize();
      } else {
        onLine(line);
      }
    }
    if (skipping) return;
    buffer += chunk.slice(start);
    if (buffer.length > MAX_LINE) {
      buffer = "";
      skipping = true;
      onOversize();
    }
  });
}

onLines(
  process.stdin,
  (line) => {
    if (line.trim() === "") return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write("mcp-filter: dropped a non-JSON client frame\n");
      return;
    }
    if (!isObject(message)) {
      for (const item of Array.isArray(message) ? message : []) {
        refuse(
          isObject(item) ? item.id : undefined,
          INVALID,
          "batches are not supported",
        );
      }
      return;
    }
    if (message.method === undefined) {
      // A response to a server-initiated request.
      if (message.id === undefined) return;
    } else if (!isAllowedMethod(message.method)) {
      refuse(
        message.id,
        DENIED,
        `method ${String(message.method)} is not allowed on this box`,
      );
      return;
    }
    if (message.method === "tools/call") {
      const name = isObject(message.params) ? message.params.name : undefined;
      if (typeof name !== "string" || !allowed.has(name)) {
        refuse(
          message.id,
          DENIED,
          `tool ${String(name)} is not allowed on this box`,
        );
        return;
      }
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  },
  () => process.stderr.write("mcp-filter: dropped an over-long client frame\n"),
);
process.stdin.on("end", () => child.stdin.end());

onLines(
  child.stdout,
  (line) => {
    if (line.trim() === "") return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`mcp-filter: server stdout (not JSON): ${line}\n`);
      return;
    }
    // Every RESPONSE (no `method`) that carries a tool list is reduced, whatever
    // its id: matching responses to pending tools/list ids let a server-initiated
    // request with a colliding id consume the entry and pass the real list
    // through unfiltered (#330 review). No other MCP result has `tools`.
    if (
      isObject(message) &&
      message.method === undefined &&
      isObject(message.result) &&
      Array.isArray(message.result.tools)
    ) {
      message.result.tools = message.result.tools.filter(
        (tool) => isObject(tool) && allowed.has(tool.name),
      );
    }
    send(message);
  },
  () => process.stderr.write("mcp-filter: dropped an over-long server frame\n"),
);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
child.on("error", (error) => {
  process.stderr.write(
    `mcp-filter: cannot start the server: ${error.message}\n`,
  );
  process.exit(1);
});
