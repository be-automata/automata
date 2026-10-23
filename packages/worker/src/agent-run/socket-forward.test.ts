import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startSocketForward } from "./socket-forward";

/** An echo server that prefixes every reply, so a test can tell who answered. */
async function echoServer(
  listen: (s: net.Server, done: () => void) => void,
  tag: string,
): Promise<net.Server> {
  const server = net.createServer((sock) => {
    sock.on("data", (d) => sock.write(`${tag}:${d.toString()}`));
    sock.on("error", () => {});
  });
  await new Promise<void>((resolve) => listen(server, resolve));
  return server;
}

function roundTrip(socketPath: string, msg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socketPath);
    c.once("error", reject);
    c.once("data", (d) => {
      c.end();
      resolve(d.toString());
    });
    c.write(msg);
  });
}

describe("startSocketForward (ADR-013 C3)", () => {
  // Short root: a unix socket path is capped at ~104 bytes (macOS).
  let root: string;
  const closers: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    root = fs.mkdtempSync("/tmp/c3-");
  });
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // card: protects=bytes written to the run's socket reach the host TCP listener and its reply comes back; the socket is 0660 (connect needs write; never world-writable); fails_when=the forward drops a direction or binds world-accessible; no_claim=the container side's socat bridge (box proof)
  it("unix → loopback TCP, both directions, socket 0660", async () => {
    const tcp = await echoServer(
      (s, done) => s.listen(0, "127.0.0.1", done),
      "tcp",
    );
    closers.push(() => new Promise<void>((r) => tcp.close(() => r())));
    const port = (tcp.address() as net.AddressInfo).port;
    const fwd = await startSocketForward({
      socketPath: path.join(root, "egress-proxy.sock"),
      target: { host: "127.0.0.1", port },
      gid: null,
    });
    closers.push(() => fwd.close());
    expect(await roundTrip(fwd.socketPath, "hello")).toBe("tcp:hello");
    expect(fs.statSync(fwd.socketPath).mode & 0o777).toBe(0o660);
  });

  // card: protects=a unix target (the gh broker's own socket) is forwarded the same way; fails_when=path targets are dialled as TCP; no_claim=gh's http_unix_socket transport (gh-broker tests)
  it("unix → unix", async () => {
    const target = path.join(root, "gh.sock");
    const srv = await echoServer((s, done) => s.listen(target, done), "gh");
    closers.push(() => new Promise<void>((r) => srv.close(() => r())));
    const fwd = await startSocketForward({
      socketPath: path.join(root, "gh-broker.sock"),
      target: { path: target },
      gid: null,
    });
    closers.push(() => fwd.close());
    expect(await roundTrip(fwd.socketPath, "api")).toBe("gh:api");
  });

  // card: protects=close() ends open connections and stops listening, so a torn-down run keeps no route to the host listeners; fails_when=an accepted connection or the listener outlives close; no_claim=removal of the socket file (the sock/ dir is removed by teardown)
  it("close() drops live connections and the listener", async () => {
    const tcp = await echoServer(
      (s, done) => s.listen(0, "127.0.0.1", done),
      "tcp",
    );
    closers.push(() => new Promise<void>((r) => tcp.close(() => r())));
    const fwd = await startSocketForward({
      socketPath: path.join(root, "p.sock"),
      target: {
        host: "127.0.0.1",
        port: (tcp.address() as net.AddressInfo).port,
      },
      gid: null,
    });
    const live = net.createConnection(fwd.socketPath);
    await new Promise((r) => live.once("connect", r));
    const closed = new Promise((r) => live.once("close", r));
    await fwd.close();
    await closed;
    await expect(roundTrip(fwd.socketPath, "x")).rejects.toThrow();
  });

  // card: protects=a dead target fails only that connection, never the forward; fails_when=one refused dial kills the listener or throws out of the server; no_claim=retry behaviour (the client's)
  it("a refused target closes that connection only", async () => {
    const fwd = await startSocketForward({
      socketPath: path.join(root, "dead.sock"),
      target: { host: "127.0.0.1", port: 1 },
      gid: null,
    });
    closers.push(() => fwd.close());
    const c = net.createConnection(fwd.socketPath);
    c.on("error", () => {});
    await new Promise((r) => c.once("close", r));
    const again = net.createConnection(fwd.socketPath);
    again.on("error", () => {});
    await new Promise((r) => again.once("connect", r));
    again.destroy();
  });
});
