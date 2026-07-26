import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import { DaemonProcess, writeDaemonMessage } from "./daemon-process";
import { loadWorkerConfig } from "./config";
import { getProcessWorkerId, runPidPath, runSocketPath } from "./run-namespace";
import type { AgentRunInput } from "./types";

/**
 * Verifies the worker speaks the daemon's real unix-socket protocol: a wrapped
 * `{ id, data }` envelope (data = stringified DaemonMessage) answered by an ACK
 * that echoes the id. A regression here (writing the raw message) made the daemon
 * read `payloadData: undefined` and idle the run to the schedule timeout.
 */

let servers: net.Server[] = [];
let socketPaths: string[] = [];

function socketPath(): string {
  const p = path.join(
    os.tmpdir(),
    `daemon-test-${Math.random().toString(36).slice(2)}.sock`,
  );
  socketPaths.push(p);
  return p;
}

/** A fake daemon socket server mirroring DaemonRuntime.listenToUnixSocket framing. */
function fakeDaemon(
  p: string,
  behavior: "ack" | "error",
  onFrame?: (frame: { id: string; data: string }) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buffer = "";
      sock.on("data", (chunk) => {
        buffer += chunk.toString();
        let frame: { id: string; data: string } | null = null;
        try {
          frame = JSON.parse(buffer);
        } catch {
          return; // keep accumulating
        }
        buffer = "";
        onFrame?.(frame!);
        const status = behavior === "ack" ? "ACK" : "ERROR";
        sock.write(JSON.stringify({ id: frame!.id, status, error: "boom" }));
      });
    });
    servers.push(server);
    server.listen(p, () => resolve());
  });
}

afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
  for (const p of socketPaths) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
  socketPaths = [];
});

describe("writeDaemonMessage", () => {
  it("sends a wrapped { id, data } envelope and resolves on ACK", async () => {
    const p = socketPath();
    let received: { id: string; data: string } | null = null;
    await fakeDaemon(p, "ack", (frame) => {
      received = frame;
    });

    const message = JSON.stringify({
      type: "claude",
      prompt: "hi",
      token: "t",
    });
    await expect(writeDaemonMessage(p, message)).resolves.toBeUndefined();

    expect(received).not.toBeNull();
    // The envelope carries the STRINGIFIED message in `data` (not the raw message).
    expect(typeof received!.id).toBe("string");
    expect(received!.data).toBe(message);
    expect(JSON.parse(received!.data)).toMatchObject({
      type: "claude",
      token: "t",
    });
  });

  it("rejects with a NonRetryableError when the daemon replies ERROR (#6)", async () => {
    const p = socketPath();
    await fakeDaemon(p, "error");
    // A daemon-reject is a terminal contract error → NonRetryableError so it routes
    // straight to onFailure instead of burning a retry.
    await expect(writeDaemonMessage(p, "{}")).rejects.toThrow(
      /daemon rejected/,
    );
    await expect(writeDaemonMessage(p, "{}")).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  it("rejects when the socket cannot be reached", async () => {
    await expect(
      writeDaemonMessage(path.join(os.tmpdir(), "does-not-exist.sock"), "{}"),
    ).rejects.toThrow();
  });

  it("times out if no ACK ever comes", async () => {
    const p = socketPath();
    // A server that accepts but never replies.
    const server = net.createServer(() => {});
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(p, () => resolve()));

    await expect(writeDaemonMessage(p, "{}", 150)).rejects.toThrow(/timed out/);
  });
});

/**
 * Phase 0.2b: DaemonProcess spawns the daemon with a PER-RUN `--socket-path` under
 * `<runNamespaceRoot>/<workerId>/<threadId>.sock` and records the daemon pid in the
 * sibling `<threadId>.pid`. We spawn a FAKE daemon (a tiny node script) that binds
 * ONLY the socket it was handed via `--socket-path` — so the socket appearing at the
 * expected per-run path is itself proof the flag was passed with that value.
 */
describe("DaemonProcess per-run socket (Phase 0.2b)", () => {
  const tmpDirs: string[] = [];
  const daemons: DaemonProcess[] = [];

  afterEach(() => {
    for (const d of daemons) d.teardown();
    daemons.length = 0;
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
  });

  function writeFakeDaemonScript(dir: string): string {
    // Binds ONLY if it received --socket-path; otherwise exits non-zero (so a
    // missing flag would fail start()'s waitForSocket, not silently pass).
    const script = `
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
const i = args.indexOf("--socket-path");
if (i === -1) { process.exit(2); }
const sock = args[i + 1];
const server = net.createServer((s) => {
  let b = "";
  s.on("data", (d) => {
    b += d.toString();
    try { const f = JSON.parse(b); b = ""; s.write(JSON.stringify({ status: "ACK", id: f.id })); } catch {}
  });
});
server.listen(sock);
setInterval(() => {}, 1000);
`;
    const p = path.join(dir, "fake-daemon.cjs");
    fs.writeFileSync(p, script);
    return p;
  }

  it("spawns with a per-run --socket-path and writes the per-run pidfile", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ns-root-"));
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ns-script-"));
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ns-wd-"));
    tmpDirs.push(root, scriptDir, workdir);

    const config = loadWorkerConfig({
      WORKER_RUN_NAMESPACE_ROOT: root,
      WORKER_DAEMON_DIST: writeFakeDaemonScript(scriptDir),
    });
    const threadId = "thr_dp_ns_test";
    const input: AgentRunInput = {
      threadId,
      threadChatId: "tc_1",
      repoFullName: "o/r",
      branch: "main",
      daemonCallbackUrl: "http://localhost:3999",
      installationToken: "inst",
      daemonToken: "daemon",
      orgId: "org-1",
    };

    const daemon = new DaemonProcess(config, input, workdir);
    daemons.push(daemon);
    await daemon.start();

    const workerId = getProcessWorkerId();
    const expectedSocket = runSocketPath(root, workerId, threadId);
    const expectedPidFile = runPidPath(root, workerId, threadId);

    // The fake daemon bound EXACTLY the per-run socket it was handed → the flag
    // was passed with the per-run path (not the fixed default).
    expect(fs.existsSync(expectedSocket)).toBe(true);
    expect(expectedSocket).toContain(workerId);
    expect(expectedSocket).toContain(threadId);
    // The daemon pid was recorded in the sibling per-run pidfile.
    expect(fs.existsSync(expectedPidFile)).toBe(true);
    expect(Number(fs.readFileSync(expectedPidFile, "utf8").trim())).toBe(
      daemon.pid,
    );

    // teardown removes this run's own socket + pidfile.
    daemon.teardown();
    expect(fs.existsSync(expectedSocket)).toBe(false);
    expect(fs.existsSync(expectedPidFile)).toBe(false);
  });
});
