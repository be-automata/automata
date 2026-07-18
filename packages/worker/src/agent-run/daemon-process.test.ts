import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDaemonMessage } from "./daemon-process";

/**
 * Verifies the worker speaks the daemon's real unix-socket protocol: a wrapped
 * `{ id, data }` envelope (data = stringified DaemonMessage) answered by an ACK
 * that echoes the id. A regression here (writing the raw message) made the daemon
 * read `payloadData: undefined` and idle the run to the schedule timeout.
 */

let servers: net.Server[] = [];
let socketPaths: string[] = [];

function socketPath(): string {
  const p = path.join(os.tmpdir(), `daemon-test-${Math.random().toString(36).slice(2)}.sock`);
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

    const message = JSON.stringify({ type: "claude", prompt: "hi", token: "t" });
    await expect(writeDaemonMessage(p, message)).resolves.toBeUndefined();

    expect(received).not.toBeNull();
    // The envelope carries the STRINGIFIED message in `data` (not the raw message).
    expect(typeof received!.id).toBe("string");
    expect(received!.data).toBe(message);
    expect(JSON.parse(received!.data)).toMatchObject({ type: "claude", token: "t" });
  });

  it("rejects when the daemon replies ERROR", async () => {
    const p = socketPath();
    await fakeDaemon(p, "error");
    await expect(writeDaemonMessage(p, "{}")).rejects.toThrow(/daemon rejected/);
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
