import { type ChildProcess, type spawn, type SpawnOptions } from "node:child_process";
import EventEmitter from "node:events";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import {
  INHERITABLE_ACE_RIGHTS,
  TRAVERSE_ACE_RIGHTS,
} from "./agent-uid-fs";
import { DaemonProcess, writeDaemonMessage } from "./daemon-process";
import { loadWorkerConfig } from "./config";
import {
  getProcessWorkerId,
  runPidPath,
  runSocketPath,
  workerRunDir,
} from "./run-namespace";
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

  /**
   * #108. Every assertion below injects both the ACE runner and spawn: the unit
   * suite must never invoke sudo, chmod +a, dscl or a real uid switch.
   */
  type Recorded = { file: string; args: string[] };

  function fakeSpawn(opts: {
    recorded: Recorded[];
    /** When set, the "wrapper" writes this pgid into the pidfile it is handed. */
    wrapperPgid?: number;
  }) {
    return ((file: string, args: string[], spawnOpts?: SpawnOptions) => {
      opts.recorded.push({ file, args });
      const pidFile = (spawnOpts?.env as Record<string, string> | undefined)
        ?.AUTOMATA_PIDFILE;
      if (opts.wrapperPgid != null && pidFile) {
        fs.writeFileSync(pidFile, String(opts.wrapperPgid));
      }
      const child = new EventEmitter() as unknown as ChildProcess & {
        stdout: EventEmitter & { resume: () => void };
        stderr: EventEmitter & { resume: () => void };
      };
      const stream = () =>
        Object.assign(new EventEmitter(), { resume: () => {} });
      Object.assign(child, {
        pid: 9001,
        exitCode: null,
        stdout: stream(),
        stderr: stream(),
        unref: () => {},
      });
      return child;
    }) as unknown as typeof spawn;
  }

  /** Bind the socket ourselves so waitForSocket resolves without a real daemon. */
  async function bindSocket(p: string): Promise<void> {
    const server = net.createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(p, () => resolve()));
  }

  it("applies no ACE and spawns nodeBin DIRECTLY when agentUser is empty (default-off proof)", async () => {
    const { root, workdir, input } = fixture();
    const aceCalls: string[][] = [];
    const recorded: Recorded[] = [];
    const config = loadWorkerConfig({
      WORKER_RUN_NAMESPACE_ROOT: root,
      WORKER_DAEMON_DIST: "/opt/daemon/index.js",
      WORKER_NODE_BIN: "/usr/bin/node",
    });
    const socket = runSocketPath(root, getProcessWorkerId(), input.threadId);
    fs.mkdirSync(path.dirname(socket), { recursive: true });
    const daemon = new DaemonProcess(config, input, workdir, null, null, null, {
      aceExec: async (_f, a) => void aceCalls.push(a),
      spawnFn: fakeSpawn({ recorded }),
    });
    daemons.push(daemon);
    await bindSocket(socket);
    await daemon.start();

    expect(aceCalls).toEqual([]);
    expect(recorded).toEqual([
      {
        file: "/usr/bin/node",
        args: [
          "/opt/daemon/index.js",
          "--url",
          input.daemonCallbackUrl,
          "--socket-path",
          socket,
        ],
      },
    ]);
    // The worker itself records the pgid, exactly as before.
    expect(
      Number(
        fs
          .readFileSync(runPidPath(root, getProcessWorkerId(), input.threadId), "utf8")
          .trim(),
      ),
    ).toBe(9001);
    expect(daemon.pid).toBe(9001);
  });

  it("grants the agent user AND the worker's own login on the run dir, root traverse-only", async () => {
    const { root, workdir, input } = fixture();
    const aceCalls: string[][] = [];
    const config = loadWorkerConfig({
      WORKER_RUN_NAMESPACE_ROOT: root,
      WORKER_DAEMON_DIST: "/opt/daemon/index.js",
      WORKER_AGENT_USER: "_automata-agent",
      WORKER_WORKDIR_ROOT: workdir,
    });
    const socket = runSocketPath(root, getProcessWorkerId(), input.threadId);
    fs.mkdirSync(path.dirname(socket), { recursive: true });
    const daemon = new DaemonProcess(config, input, workdir, null, null, null, {
      aceExec: async (_f, a) => void aceCalls.push(a),
      spawnFn: fakeSpawn({ recorded: [], wrapperPgid: 4242 }),
      platform: "darwin",
    });
    daemons.push(daemon);
    await bindSocket(socket);
    await daemon.start();

    const me = os.userInfo().username;
    const runDir = workerRunDir(root, getProcessWorkerId());
    expect(aceCalls.map((a) => `${a[1]} @ ${a[2]}`)).toEqual([
      `_automata-agent allow ${TRAVERSE_ACE_RIGHTS} @ ${root}`,
      `_automata-agent allow ${INHERITABLE_ACE_RIGHTS} @ ${runDir}`,
      `${me} allow ${INHERITABLE_ACE_RIGHTS} @ ${runDir}`,
    ]);
  });

  it("spawns via sudo -n -u <user> -E -- and takes the pgid from the WRAPPER, not child.pid", async () => {
    const { root, workdir, input } = fixture();
    const recorded: Recorded[] = [];
    const config = loadWorkerConfig({
      WORKER_RUN_NAMESPACE_ROOT: root,
      WORKER_DAEMON_DIST: "/opt/daemon/index.js",
      WORKER_NODE_BIN: "/usr/local/automata/bin/node",
      WORKER_AGENT_USER: "_automata-agent",
      WORKER_WORKDIR_ROOT: workdir,
    });
    const socket = runSocketPath(root, getProcessWorkerId(), input.threadId);
    fs.mkdirSync(path.dirname(socket), { recursive: true });
    const daemon = new DaemonProcess(config, input, workdir, null, null, null, {
      aceExec: async () => {},
      spawnFn: fakeSpawn({ recorded, wrapperPgid: 4242 }),
      platform: "darwin",
    });
    daemons.push(daemon);
    await bindSocket(socket);
    await daemon.start();

    expect(recorded[0]?.file).toBe("/usr/bin/sudo");
    expect(recorded[0]?.args.slice(0, 5)).toEqual([
      "-n",
      "-u",
      "_automata-agent",
      "-E",
      "--",
    ]);
    // The daemon argv rides through as POSITIONAL args after the wrapper script.
    expect(recorded[0]?.args.slice(-5)).toEqual([
      "/opt/daemon/index.js",
      "--url",
      input.daemonCallbackUrl,
      "--socket-path",
      socket,
    ]);
    // sudo may fork a setsid'd monitor, so child.pid (9001) is NOT the group.
    expect(daemon.pid).toBe(4242);
  });

  it("teardown shells out to sudo /bin/kill -9 -- -<pgid> when agentUser is set", async () => {
    const { root, workdir, input } = fixture();
    const recorded: Recorded[] = [];
    const config = loadWorkerConfig({
      WORKER_RUN_NAMESPACE_ROOT: root,
      WORKER_DAEMON_DIST: "/opt/daemon/index.js",
      WORKER_AGENT_USER: "_automata-agent",
      WORKER_WORKDIR_ROOT: workdir,
    });
    const socket = runSocketPath(root, getProcessWorkerId(), input.threadId);
    const pidFile = runPidPath(root, getProcessWorkerId(), input.threadId);
    fs.mkdirSync(path.dirname(socket), { recursive: true });
    const daemon = new DaemonProcess(config, input, workdir, null, null, null, {
      aceExec: async () => {},
      spawnFn: fakeSpawn({ recorded, wrapperPgid: 4242 }),
      platform: "darwin",
    });
    daemons.push(daemon);
    await bindSocket(socket);
    await daemon.start();
    daemon.teardown();

    expect(recorded[1]).toEqual({
      file: "/usr/bin/sudo",
      args: [
        "-n",
        "-u",
        "_automata-agent",
        "--",
        "/bin/kill",
        "-9",
        "--",
        "-4242",
      ],
    });
    // teardown still removes this run's own pidfile and socket first.
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(fs.existsSync(socket)).toBe(false);
  });

  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ace-root-"));
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ace-script-"));
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ace-wd-"));
    tmpDirs.push(root, scriptDir, workdir);
    const input: AgentRunInput = {
      threadId: `thr_ace_${Math.random().toString(36).slice(2)}`,
      threadChatId: "tc_1",
      repoFullName: "o/r",
      branch: "main",
      daemonCallbackUrl: "http://localhost:3999",
      installationToken: "inst",
      daemonToken: "daemon",
      orgId: "org-1",
    };
    return { root, scriptDir, workdir, input };
  }
});
