import fs from "node:fs";
import net from "node:net";

/**
 * ADR-013 C3 (#430): a `--network none` run container's only exits are unix
 * sockets in its run's `sock/` dir (mounted at /run/automata). Each one is a
 * plain byte forwarder to a host-side listener the worker already runs for
 * the host path — the egress proxy and the git broker on loopback TCP, the gh
 * broker on its own unix socket, the box's test Postgres. The policy stays in
 * those listeners; this file only carries bytes.
 */

/** Where a forwarded connection goes on the host. */
export type ForwardTarget = { host: string; port: number } | { path: string };

export interface SocketForward {
  /** The host path of the listening socket (inside the run's `sock/` dir). */
  readonly socketPath: string;
  close(): Promise<void>;
}

export interface StartSocketForwardOptions {
  socketPath: string;
  target: ForwardTarget;
  /**
   * The group the socket is handed to (the rootless daemon user's group,
   * container gid 0), or null to leave it as bound. connect(2) needs write
   * on the socket, so the socket is 0660 either way: never world-writable.
   */
  gid: number | null;
}

export async function startSocketForward(
  opts: StartSocketForwardOptions,
): Promise<SocketForward> {
  const open = new Set<net.Socket>();
  const server = net.createServer((inbound) => {
    const outbound =
      "path" in opts.target
        ? net.createConnection(opts.target.path)
        : net.createConnection(opts.target.port, opts.target.host);
    open.add(inbound);
    open.add(outbound);
    const drop = () => {
      inbound.destroy();
      outbound.destroy();
      open.delete(inbound);
      open.delete(outbound);
    };
    inbound.on("error", drop);
    outbound.on("error", drop);
    inbound.on("close", drop);
    outbound.on("close", drop);
    inbound.pipe(outbound);
    outbound.pipe(inbound);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  try {
    // The sock/ dir is writable by the container's group: lstat first and
    // never chmod/chown what a stray process could have swapped in.
    const st = await fs.promises.lstat(opts.socketPath);
    if (!st.isSocket() || st.uid !== process.getuid?.()) {
      throw new Error(
        `socket-forward: ${opts.socketPath} is not the socket this process bound`,
      );
    }
    if (opts.gid !== null) {
      await fs.promises.chown(opts.socketPath, st.uid, opts.gid);
    }
    await fs.promises.chmod(opts.socketPath, 0o660);
  } catch (err) {
    server.close();
    throw err;
  }
  return {
    socketPath: opts.socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy();
        open.clear();
        server.close(() => resolve());
      }),
  };
}
