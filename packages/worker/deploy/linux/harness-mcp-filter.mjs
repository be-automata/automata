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
// - client -> server `tools/call` for a name not on the list is answered with
//   a JSON-RPC error and never forwarded;
// - server -> client `tools/list` results are reduced to the list.
//
// MCP stdio frames are one JSON-RPC message per line. A frame that is not a
// JSON object (a batch array, garbage) from the client is refused rather than
// forwarded, because the filter could not inspect it. Non-JSON server stdout
// is diverted to stderr so it cannot corrupt the client's stream.

import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

const DENIED = -32601;
const INVALID = -32600;

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

const child = spawn(command, commandArgs, {
  stdio: ["pipe", "pipe", "inherit"],
});
/** Ids of client tools/list requests whose responses must be reduced. */
const listRequests = new Set();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const refuse = (id, code, message) => {
  if (id !== undefined && id !== null) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }
};
const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
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
  if (message.method === "tools/list" && message.id !== undefined) {
    listRequests.add(JSON.stringify(message.id));
  }
  child.stdin.write(`${line}\n`);
});
process.stdin.on("end", () => child.stdin.end());

readline.createInterface({ input: child.stdout }).on("line", (line) => {
  if (line.trim() === "") return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write(`mcp-filter: server stdout (not JSON): ${line}\n`);
    return;
  }
  if (isObject(message) && message.id !== undefined) {
    const key = JSON.stringify(message.id);
    if (listRequests.delete(key) && Array.isArray(message.result?.tools)) {
      message.result.tools = message.result.tools.filter(
        (tool) => isObject(tool) && allowed.has(tool.name),
      );
    }
  }
  send(message);
});

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
