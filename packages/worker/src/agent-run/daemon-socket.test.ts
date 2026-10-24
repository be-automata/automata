import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NonRetryableError } from "@hatchet-dev/typescript-sdk";

import { writeDaemonMessage } from "./daemon-socket";

/**
 * Verifies the worker speaks the daemon's real unix-socket protocol: a wrapped
 * `{ id, data }` envelope (data = stringified DaemonMessage) answered by an ACK
 * that echoes the id. A regression here (writing the raw message) made the daemon
 * read `payloadData: undefined` and idle the run to the schedule timeout.
 * (Moved with writeDaemonMessage out of the deleted host daemon-process.ts.)
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
          frame = JSON.parse(buffer) as { id: string; data: string };
        } catch {
          return; // keep accumulating
        }
        buffer = "";
        onFrame?.(frame);
        const status = behavior === "ack" ? "ACK" : "ERROR";
        sock.write(JSON.stringify({ id: frame.id, status, error: "boom" }));
      });
    });
    servers.push(server);
    server.listen(p, () => resolve());
  });
}

afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
  for (const p of socketPaths) fs.rmSync(p, { force: true });
  socketPaths = [];
});

describe("writeDaemonMessage", () => {
  // card: protects=the worker writes the daemon's wrapped { id, data } envelope (data = the stringified message) and resolves on the matching ACK; fails_when=the raw message is written or the ACK is not awaited; no_claim=the daemon's own parser (packages/daemon tests)
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
    const frame = received as { id: string; data: string } | null;
    expect(typeof frame?.id).toBe("string");
    expect(frame?.data).toBe(message);
  });

  // card: protects=a daemon ERROR reply is terminal (#6: NonRetryableError, straight to onFailure); fails_when=it rejects with a plain (retryable) Error; no_claim=how onFailure posts it
  it("rejects with a NonRetryableError when the daemon replies ERROR (#6)", async () => {
    const p = socketPath();
    await fakeDaemon(p, "error");
    await expect(writeDaemonMessage(p, "{}")).rejects.toThrow(
      /daemon rejected/,
    );
    await expect(writeDaemonMessage(p, "{}")).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  // card: protects=an unreachable socket rejects instead of hanging; fails_when=the promise resolves or never settles; no_claim=retry classification of that error
  it("rejects when the socket cannot be reached", async () => {
    await expect(
      writeDaemonMessage(path.join(os.tmpdir(), "does-not-exist.sock"), "{}"),
    ).rejects.toThrow();
  });

  // card: protects=a daemon that accepts but never ACKs ends at the timeout; fails_when=the write waits forever; no_claim=the production 10 s default
  it("times out if no ACK ever comes", async () => {
    const p = socketPath();
    const server = net.createServer(() => {});
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(p, () => resolve()));
    await expect(writeDaemonMessage(p, "{}", 150)).rejects.toThrow(/timed out/);
  });
});
