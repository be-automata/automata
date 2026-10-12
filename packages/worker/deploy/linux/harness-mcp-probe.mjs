// A minimal MCP stdio client for the harness installer and doctor
// (install-batteries.sh copies it to <root>/harness-tools/mcp-probe.mjs).
//
//   node mcp-probe.mjs warmup <calls.json> -- <server command> [args...]
//     initialize, list every tool the (unfiltered) server registers, then
//     call each {"tool", "arguments"} once. Used at BUILD time, with network,
//     so a tool's first-use downloads (an embedding model) land inside the
//     pack instead of at run time.
//
//   node mcp-probe.mjs verify <allowlist.json> <denied tool> -- <command> [args...]
//     initialize; tools/list must be non-empty and inside the allowlist;
//     memory_store then memory_retrieve must round-trip a fresh nonce when both
//     are listed; a tools/call of <denied tool> (a name no server registers)
//     and a resources/list request must be refused BY THE FILTER (-32601).
//
// Prints one JSON summary line on stdout; exit 0 only when every check held.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";

const TIMEOUT_MS = 180_000;

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
const mode = argv[0];
if (
  separator === -1 ||
  !(
    (mode === "warmup" && separator === 2) ||
    (mode === "verify" && separator === 3)
  )
) {
  process.stderr.write(
    "usage: mcp-probe.mjs warmup <calls.json> -- <cmd...> | verify <allowlist.json> <denied tool> -- <cmd...>\n",
  );
  process.exit(2);
}
const [command, ...commandArgs] = argv.slice(separator + 1);
const child = spawn(command, commandArgs, {
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map();
let nextId = 1;

readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const resolve = pending.get(message?.id);
  if (resolve !== undefined) {
    pending.delete(message.id);
    resolve(message);
  }
});

const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(
      () => reject(new Error(`${method} timed out`)),
      TIMEOUT_MS,
    );
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
  });

/** The text of a tools/call result, or undefined when it is an error. */
const callText = (message) =>
  message.error === undefined && message.result?.isError !== true
    ? (message.result?.content ?? [])
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n")
    : undefined;

const summary = { mode, ok: false, checks: [] };
const check = (name, ok, detail) => summary.checks.push({ name, ok, detail });

async function main() {
  const started = Date.now();
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "automata-batteries", version: "1" },
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  summary.server = init.result?.serverInfo ?? null;
  summary.startupMs = Date.now() - started;
  check("initialize", init.result !== undefined, init.error?.message);

  const listed = await rpc("tools/list", {});
  const names = (listed.result?.tools ?? []).map((tool) => tool.name);
  summary.toolCount = names.length;
  if (mode === "warmup") summary.tools = names;

  if (mode === "warmup") {
    const calls = JSON.parse(fs.readFileSync(argv[1], "utf8"));
    for (const { tool, arguments: args } of calls) {
      const text = callText(
        await rpc("tools/call", { name: tool, arguments: args }),
      );
      check(`warmup ${tool}`, text !== undefined, text?.slice(0, 200));
    }
    return;
  }

  const allowlist = new Set(JSON.parse(fs.readFileSync(argv[1], "utf8")));
  const outside = names.filter((name) => !allowlist.has(name));
  check("tools/list non-empty", names.length > 0, `${names.length} tools`);
  check(
    "tools/list inside the allowlist",
    outside.length === 0,
    outside.join(","),
  );
  if (names.includes("memory_store") && names.includes("memory_retrieve")) {
    const nonce = `nonce-${randomBytes(8).toString("hex")}`;
    const key = `automata-verify-${nonce}`;
    const stored = callText(
      await rpc("tools/call", {
        name: "memory_store",
        arguments: { key, value: nonce },
      }),
    );
    check("memory_store", stored !== undefined, stored?.slice(0, 200));
    const retrieved = callText(
      await rpc("tools/call", { name: "memory_retrieve", arguments: { key } }),
    );
    check(
      "memory_retrieve round-trips the nonce",
      retrieved?.includes(nonce) === true,
    );
  }
  // The refusal must come from the FILTER (its code and wording), so a missing
  // filter fails here instead of the server running the call: <denied tool>
  // should be a name no server registers, and a non-allowlisted METHOD is
  // checked the same way.
  const denied = argv[2];
  const deniedReply = await rpc("tools/call", { name: denied, arguments: {} });
  check(
    `${denied} is refused by the filter`,
    deniedReply.error?.code === -32601 &&
      deniedReply.error?.message ===
        `tool ${denied} is not allowed on this box`,
    deniedReply.error?.message ?? "the server answered",
  );
  const methodReply = await rpc("resources/list", {});
  check(
    "resources/list is refused by the filter",
    methodReply.error?.code === -32601 &&
      methodReply.error?.message ===
        "method resources/list is not allowed on this box",
    methodReply.error?.message ?? "the server answered",
  );
}

try {
  await main();
  summary.ok = summary.checks.every((c) => c.ok);
} catch (error) {
  check(
    "protocol",
    false,
    error instanceof Error ? error.message : String(error),
  );
}
process.stdout.write(`${JSON.stringify(summary)}\n`);
child.kill("SIGTERM");
process.exit(summary.ok ? 0 : 1);
