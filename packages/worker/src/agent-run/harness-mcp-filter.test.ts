import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const FILTER = fileURLToPath(
  new URL("../../deploy/linux/harness-mcp-filter.mjs", import.meta.url),
);

/**
 * A fake MCP server: it advertises three tools, answers tools/call by echoing
 * the name, and on `tools/list` with id 7 first sends a SERVER-INITIATED
 * request reusing id 7 — the collision that used to consume the filter's
 * pending entry and let the real list through unfiltered.
 */
const FAKE_SERVER = `
const readline = require("node:readline");
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "tools/list") {
    if (m.id === 7) out({ jsonrpc: "2.0", id: 7, method: "roots/list" });
    out({ jsonrpc: "2.0", id: m.id, result: { tools: [
      { name: "memory_store" }, { name: "agent_spawn" }, { name: "terminal_execute" },
    ] } });
  } else if (m.method === "tools/call") {
    out({ jsonrpc: "2.0", id: m.id, result: { called: m.params.name } });
  } else if (m.id !== undefined && m.method !== undefined) {
    out({ jsonrpc: "2.0", id: m.id, result: { forwarded: m.method } });
  }
});
`;

interface Frame {
  id?: unknown;
  method?: string;
  result?: { tools?: { name: string }[]; called?: string; forwarded?: string };
  error?: { code: number; message: string };
}

let dir: string;
let allowlist: string;
let server: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mcp-filter-test-"));
  allowlist = path.join(dir, "allow.json");
  server = path.join(dir, "server.cjs");
  writeFileSync(allowlist, JSON.stringify(["memory_store"]));
  writeFileSync(server, FAKE_SERVER);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Sends `requests` through the filter and collects `expected` frames back. */
async function exchange(
  requests: object[],
  expected: number,
): Promise<Frame[]> {
  const child = spawn(
    process.execPath,
    [FILTER, allowlist, "--", process.execPath, server],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const frames: Frame[] = [];
  let buffer = "";
  const done = new Promise<Frame[]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out with ${JSON.stringify(frames)}`)),
      5000,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() !== "") frames.push(JSON.parse(line) as Frame);
      }
      if (frames.length >= expected) {
        clearTimeout(timer);
        resolve(frames);
      }
    });
  });
  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }
  try {
    return await done;
  } finally {
    child.kill("SIGTERM");
  }
}

describe("harness-mcp-filter.mjs", () => {
  it("reduces a tools/list result to the allowlist", async () => {
    const [frame] = await exchange(
      [{ jsonrpc: "2.0", id: 1, method: "tools/list" }],
      1,
    );
    expect(frame?.result?.tools).toEqual([{ name: "memory_store" }]);
  });

  it("still filters the list when a server request reuses the tools/list id", async () => {
    const frames = await exchange(
      [{ jsonrpc: "2.0", id: 7, method: "tools/list" }],
      2,
    );
    const serverRequest = frames.find((f) => f.method === "roots/list");
    const list = frames.find((f) => f.method === undefined);
    expect(serverRequest?.id).toBe(7);
    expect(list?.result?.tools).toEqual([{ name: "memory_store" }]);
  });

  it("refuses a tools/call outside the allowlist without forwarding it", async () => {
    const frames = await exchange(
      [
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "agent_spawn" },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "memory_store" },
        },
      ],
      2,
    );
    const denied = frames.find((f) => f.id === 2);
    const allowed = frames.find((f) => f.id === 3);
    expect(denied?.error?.code).toBe(-32601);
    expect(denied?.result).toBeUndefined();
    expect(allowed?.result?.called).toBe("memory_store");
  });

  it("refuses a method outside the method allowlist", async () => {
    const [frame] = await exchange(
      [{ jsonrpc: "2.0", id: 4, method: "resources/list" }],
      1,
    );
    expect(frame?.error?.code).toBe(-32601);
    expect(frame?.result).toBeUndefined();
  });
});
