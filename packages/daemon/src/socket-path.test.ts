import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonRuntime } from "./runtime.js";

/**
 * Phase 0.2a proof: the daemon socket path is a per-instance parameter, so two
 * daemons on ONE box bound to DISTINCT socket paths both accept + ACK concurrently
 * — no collision. This is what lifts the "global maxRuns=1 because the socket is
 * fixed" constraint (the CLI `--socket-path` flag in index.ts feeds this param).
 *
 * DaemonRuntime.teardown() SIGKILLs the whole process group, so we NEVER call it
 * here — we close the private server + unlink the socket by hand for cleanup.
 */

const runtimes: DaemonRuntime[] = [];
const socketPaths: string[] = [];

function socketPath(): string {
  const p = path.join(os.tmpdir(), `daemon-sockpath-${randomUUID().slice(0, 8)}.sock`);
  socketPaths.push(p);
  return p;
}

function makeRuntime(unixSocketPath: string): DaemonRuntime {
  const rt = new DaemonRuntime({
    url: "http://localhost:3000",
    unixSocketPath,
    outputFormat: "json",
    skipReportingDaemonEvents: true,
  });
  runtimes.push(rt);
  return rt;
}

/** Client mirror of DaemonProcess.writeDaemonMessage: send {id,data}, await ACK. */
function sendAndAwaitAck(p: string, data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const sock = net.createConnection(p);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("timeout waiting for ACK"));
    }, 2000);
    sock.once("connect", () => sock.write(JSON.stringify({ id, data })));
    sock.on("data", (buf) => {
      const res = JSON.parse(buf.toString()) as { id?: string; status?: string };
      if (res.id !== id) return;
      clearTimeout(timer);
      sock.end();
      resolve(res.status ?? "");
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Wait until the socket file exists + accepts (listen() is async). */
async function waitReady(p: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) {
      try {
        await new Promise<void>((resolve, reject) => {
          const s = net.createConnection(p);
          s.once("connect", () => {
            s.end();
            resolve();
          });
          s.once("error", reject);
        });
        return;
      } catch {
        // not up yet
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`socket ${p} not ready`);
}

afterEach(() => {
  for (const rt of runtimes) {
    // Close the private server WITHOUT teardown() (teardown SIGKILLs the process),
    // and detach the SIGTERM/SIGINT handlers the constructor registered so they
    // can't fire teardown()→SIGKILL after the test env is torn down.
    const priv = rt as unknown as {
      unixSocketServer: net.Server | null;
      sigtermHandler: NodeJS.SignalsListener;
      sigintHandler: NodeJS.SignalsListener;
    };
    priv.unixSocketServer?.close();
    process.off("SIGTERM", priv.sigtermHandler);
    process.off("SIGINT", priv.sigintHandler);
  }
  runtimes.length = 0;
  for (const p of socketPaths) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
  socketPaths.length = 0;
});

describe("DaemonRuntime per-run socket isolation (Phase 0.2a)", () => {
  it("two runtimes on distinct socket paths both ACK concurrently", async () => {
    const pathA = socketPath();
    const pathB = socketPath();
    const rtA = makeRuntime(pathA);
    const rtB = makeRuntime(pathB);

    const seen: Record<string, string> = {};
    await rtA.listenToUnixSocket((d) => {
      seen.a = d;
    });
    await rtB.listenToUnixSocket((d) => {
      seen.b = d;
    });
    await Promise.all([waitReady(pathA), waitReady(pathB)]);

    // Distinct files — no collision on the fixed default socket.
    expect(pathA).not.toBe(pathB);
    expect(fs.existsSync(pathA)).toBe(true);
    expect(fs.existsSync(pathB)).toBe(true);

    const [ackA, ackB] = await Promise.all([
      sendAndAwaitAck(pathA, JSON.stringify({ type: "ping-a" })),
      sendAndAwaitAck(pathB, JSON.stringify({ type: "ping-b" })),
    ]);
    expect(ackA).toBe("ACK");
    expect(ackB).toBe("ACK");
    // Each runtime received ONLY its own message (isolated).
    expect(seen.a).toBe(JSON.stringify({ type: "ping-a" }));
    expect(seen.b).toBe(JSON.stringify({ type: "ping-b" }));
  });
});
