import {
  type ChildProcess,
  type spawn,
  type SpawnOptions,
} from "node:child_process";
import EventEmitter from "node:events";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
// Bind failures from fakeSpawn's fire-and-forget listen() (see below) — an
// unhandled 'error' event would crash the whole run with no test named, so
// they are collected here and rethrown by afterEach against the right test.
const bindErrors: Error[] = [];

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
  if (bindErrors.length > 0) {
    const first = bindErrors[0];
    bindErrors.length = 0;
    throw first;
  }
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

  /**
   * Fail loudly if a fixture ever grows past Darwin's sun_path cap again —
   * over it, macOS bind(2)/connect(2) silently truncate and the suite tests
   * a different path than it thinks (the false pass this file used to have).
   */
  function assertUnderSunPathCap(socket: string): void {
    expect(Buffer.byteLength(socket)).toBeLessThan(104);
  }

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
    // Short root prefix: see fixture() below — the socket path must stay
    // under Darwin's 104-byte sun_path cap or bind/connect silently truncate.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dpn-"));
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ns-script-"));
    // The clone sits in a run dir, beside gh-config/ and tmp/ (#302).
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ns-wd-"));
    const workdir = path.join(runDir, "repo");
    fs.mkdirSync(workdir);
    tmpDirs.push(root, scriptDir, runDir);

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

    const workerId = getProcessWorkerId();
    const expectedSocket = runSocketPath(root, workerId, threadId);
    assertUnderSunPathCap(expectedSocket);

    const daemon = new DaemonProcess(config, input, workdir);
    daemons.push(daemon);
    await daemon.start();

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
      // Bind the daemon socket HERE, like the real daemon: only after spawn,
      // never before start(). start()'s cleanOwnStaleFiles() rmSync's the
      // socket path, so a socket the test pre-binds is unlinked and
      // waitForSocket polls ENOENT to its timeout on Linux. macOS masked
      // this for months: these paths exceeded sun_path's 104-byte cap, and
      // Darwin's bind(2)/connect(2) BOTH silently truncate, so the rmSync of
      // the full-length name never touched the file actually bound.
      const flagIdx = args.indexOf("--socket-path");
      const boundSocket = flagIdx === -1 ? undefined : args[flagIdx + 1];
      if (boundSocket !== undefined) {
        const server = net.createServer();
        server.on("error", (err) => void bindErrors.push(err));
        servers.push(server);
        server.listen(boundSocket);
      }
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

  it("#108: the spawned env carries safe.directory for the run's workdir", async () => {
    // AT THE CALL SITE, not on buildDaemonEnv. The unit tests for that function
    // supply the workdir themselves, so they passed while the caller was not
    // passing it at all and the fix was dead in every real run. This asserts the
    // env the agent is actually spawned with.
    const { root, workdir, input } = fixture();
    const recorded: Recorded[] = [];
    const config = loadWorkerConfig({
      WORKER_RUN_NAMESPACE_ROOT: root,
      WORKER_DAEMON_DIST: "/opt/daemon/index.js",
      WORKER_NODE_BIN: "/usr/bin/node",
      WORKER_AGENT_USER: "automata-agent",
      WORKER_WORKDIR_ROOT: root,
    });
    const socket = runSocketPath(root, getProcessWorkerId(), input.threadId);
    fs.mkdirSync(path.dirname(socket), { recursive: true });
    let spawnedEnv: Record<string, string> = {};
    const inner = fakeSpawn({ recorded, wrapperPgid: process.pid });
    const daemon = new DaemonProcess(config, input, workdir, null, null, null, {
      aceExec: async () => {},
      spawnFn: ((f: string, a: string[], o: SpawnOptions) => {
        spawnedEnv = (o?.env ?? {}) as Record<string, string>;
        return inner(f, a, o);
      }) as unknown as typeof spawn,
    });
    daemons.push(daemon);
    await daemon.start();

    // Read the GIT_CONFIG_* list the way git does, and find the entry.
    const count = Number(spawnedEnv.GIT_CONFIG_COUNT ?? "0");
    expect(count).toBeGreaterThan(0);
    const pairs = Array.from({ length: count }, (_, i) => [
      spawnedEnv[`GIT_CONFIG_KEY_${i}`],
      spawnedEnv[`GIT_CONFIG_VALUE_${i}`],
    ]);
    const safe = pairs.filter(([k]) => k === "safe.directory");
    expect(safe).toHaveLength(1);
    expect(safe[0]?.[1]).toBe(workdir);
    // Never the wildcard: that would trust every repository on the box,
    // including other runs' checkouts and the operator's own.
    expect(safe[0]?.[1]).not.toBe("*");
  });

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
          .readFileSync(
            runPidPath(root, getProcessWorkerId(), input.threadId),
            "utf8",
          )
          .trim(),
      ),
    ).toBe(9001);
    expect(daemon.pid).toBe(9001);
  });

  describe("box test services (/etc/automata/agent-test-services.env)", () => {
    const BOX_URL =
      "postgresql://automata_test:boxpw0123456789abcdef@127.0.0.1:25432/postgres";

    async function spawnedEnvFor(
      inputPatch: Partial<AgentRunInput>,
    ): Promise<Record<string, string>> {
      const { root, workdir, input } = fixture();
      const envFile = path.join(root, "agent-test-services.env");
      fs.writeFileSync(
        envFile,
        `# managed\nTEST_DATABASE_ADMIN_URL=${BOX_URL}\nPATH=/evil\n`,
      );
      const config = loadWorkerConfig({
        WORKER_RUN_NAMESPACE_ROOT: root,
        WORKER_DAEMON_DIST: "/opt/daemon/index.js",
        WORKER_NODE_BIN: "/usr/bin/node",
      });
      const socket = runSocketPath(root, getProcessWorkerId(), input.threadId);
      fs.mkdirSync(path.dirname(socket), { recursive: true });
      let spawnedEnv: Record<string, string> = {};
      const inner = fakeSpawn({ recorded: [] });
      const daemon = new DaemonProcess(
        config,
        { ...input, ...inputPatch },
        workdir,
        null,
        null,
        null,
        {
          aceExec: async () => {},
          boxTestServicesEnvPath: envFile,
          spawnFn: ((f: string, a: string[], o: SpawnOptions) => {
            spawnedEnv = (o?.env ?? {}) as Record<string, string>;
            return inner(f, a, o);
          }) as unknown as typeof spawn,
        },
      );
      daemons.push(daemon);
      await daemon.start();
      return spawnedEnv;
    }

    it("a task run's spawned env carries TEST_DATABASE_ADMIN_URL from the box file", async () => {
      const env = await spawnedEnvFor({});
      expect(env.TEST_DATABASE_ADMIN_URL).toBe(BOX_URL);
      // Allowlist: the file cannot steer the runtime.
      expect(env.PATH).not.toBe("/evil");
    });

    it("the owner's repoEnv wins over the box value for the same key", async () => {
      const env = await spawnedEnvFor({
        repoEnv: { TEST_DATABASE_ADMIN_URL: "postgresql://owner@db/postgres" },
      });
      expect(env.TEST_DATABASE_ADMIN_URL).toBe(
        "postgresql://owner@db/postgres",
      );
    });

    it("a review run does NOT get it", async () => {
      const env = await spawnedEnvFor({
        prNumber: 7,
        prKey: "org-1/o/r/7",
        supersedePolicy: "newest-wins",
      });
      expect(env.TEST_DATABASE_ADMIN_URL).toBeUndefined();
    });

    it("a personal (no-org) run does NOT get it", async () => {
      const env = await spawnedEnvFor({ orgId: "u:user_1" });
      expect(env.TEST_DATABASE_ADMIN_URL).toBeUndefined();
    });
  });

  it("degraded teardown: a LATE wrapper pidfile is still group-killed as the agent (F3)", async () => {
    // resolvePgid()'s bounded wait can expire before a slow sudo/PAM hop lands
    // the pidfile. teardown must take one last look rather than signal the
    // pre-sudo pid, which is sudo's own (root) process and unkillable by the
    // agent account.
    const { root, workdir, input } = fixture();
    const recorded: Recorded[] = [];
    const killed: number[] = [];
    const config = loadWorkerConfig({
      WORKER_RUN_NAMESPACE_ROOT: root,
      WORKER_DAEMON_DIST: "/opt/daemon/index.js",
      WORKER_AGENT_USER: "_automata-agent",
      WORKER_WORKDIR_ROOT: workdir,
    });
    const pidFile = runPidPath(root, getProcessWorkerId(), input.threadId);
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    const daemon = new DaemonProcess(config, input, workdir, null, null, null, {
      aceExec: async () => {},
      // No wrapperPgid: the wrapper "has not written it yet".
      spawnFn: fakeSpawn({ recorded }),
      platform: "darwin",
      killFn: (p) => void killed.push(p),
    });
    daemons.push(daemon);
    await expect(daemon.start()).rejects.toThrow(
      /never recorded its process group/,
    );
    // …and only NOW does the wrapper's value land.
    fs.writeFileSync(pidFile, "7777");

    daemon.teardown();
    const kill = recorded.find((r) => r.args.includes("/bin/kill"));
    expect(kill?.file).toBe("/usr/bin/sudo");
    expect(kill?.args).toEqual([
      "-n",
      "-u",
      "_automata-agent",
      "--",
      "/bin/kill",
      "-9",
      "--",
      "-7777",
    ]);
    // Never the pre-sudo pid.
    expect(killed).toEqual([]);
  });

  it("degraded teardown: NO pgid ever ⇒ loud log + kill sudo's own group, not a doomed sudo kill (F3)", async () => {
    const { root, workdir, input } = fixture();
    const recorded: Recorded[] = [];
    const killed: number[] = [];
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    try {
      const config = loadWorkerConfig({
        WORKER_RUN_NAMESPACE_ROOT: root,
        WORKER_DAEMON_DIST: "/opt/daemon/index.js",
        WORKER_AGENT_USER: "_automata-agent",
        WORKER_WORKDIR_ROOT: workdir,
      });
      fs.mkdirSync(
        path.dirname(runPidPath(root, getProcessWorkerId(), input.threadId)),
        { recursive: true },
      );
      const daemon = new DaemonProcess(
        config,
        input,
        workdir,
        null,
        null,
        null,
        {
          aceExec: async () => {},
          spawnFn: fakeSpawn({ recorded }),
          platform: "darwin",
          killFn: (p) => void killed.push(p),
        },
      );
      daemons.push(daemon);
      await expect(daemon.start()).rejects.toThrow(
        /never recorded its process group/,
      );
      daemon.teardown();
    } finally {
      console.error = originalError;
    }
    // A `sudo -u agent kill` aimed at sudo's own root process is a guaranteed
    // EPERM no-op — so we do not issue one. We kill sudo's group ourselves.
    expect(recorded.some((r) => r.args.includes("/bin/kill"))).toBe(false);
    expect(killed).toEqual([-9001]);
    expect(errors.join("\n")).toMatch(/never recorded a process group/);
    expect(errors.join("\n")).toMatch(/may survive this teardown/);
  });

  it("applies NO ACE itself even in agent-uid mode — boot owns that (F2)", async () => {
    // The gh-broker socket is bound in this same dir BEFORE start() runs, and
    // macOS applies ACE inheritance at CREATE time, so a per-run grant here
    // would never reach it. claimRunNamespace() applies both grants at worker
    // boot instead; start() must stay out of the ACL business entirely.
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
    await daemon.start();

    expect(aceCalls).toEqual([]);
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

  /**
   * The isolated gh config dir (#81 broker route). Live on the box, agent-uid
   * mode: `gh auth status` failed `open /tmp/automata-gh-XXXX/config.yml:
   * permission denied` — the dir was a 0700 mkdtemp owned by the WORKER uid, so
   * the agent could not read the config that routes gh through the broker, and
   * every gh call in mention/task runs failed.
   */
  describe("gh config dir", () => {
    const BROKER = {
      gitUrl: "http://127.0.0.1:1",
      ghSocketPath: "/run/automata/t-gh.sock",
      bearer: "bearer-x",
      repoFullName: "o/r",
    };

    function spawnCapturingEnv(
      recorded: Recorded[],
      sink: { env: Record<string, string> },
    ) {
      const inner = fakeSpawn({ recorded, wrapperPgid: process.pid });
      return ((f: string, a: string[], o: SpawnOptions) => {
        sink.env = (o?.env ?? {}) as Record<string, string>;
        return inner(f, a, o);
      }) as unknown as typeof spawn;
    }

    it("agent-uid mode: lives in the run dir beside the clone, carries the broker route, is granted to the agent, and is removed on teardown", async () => {
      const { root, workdir, input } = fixture();
      const recorded: Recorded[] = [];
      const aclCalls: Recorded[] = [];
      const config = loadWorkerConfig({
        WORKER_RUN_NAMESPACE_ROOT: root,
        WORKER_DAEMON_DIST: "/opt/daemon/index.js",
        WORKER_AGENT_USER: "automata-agent",
        WORKER_WORKDIR_ROOT: root,
      });
      const socket = runSocketPath(root, getProcessWorkerId(), input.threadId);
      fs.mkdirSync(path.dirname(socket), { recursive: true });
      const sink = { env: {} as Record<string, string> };
      const daemon = new DaemonProcess(
        config,
        input,
        workdir,
        null,
        null,
        BROKER,
        {
          aceExec: async (file, args) => void aclCalls.push({ file, args }),
          spawnFn: spawnCapturingEnv(recorded, sink),
          // Linux is where the 0700 creation mode zeroes the ACL mask.
          platform: "linux",
        },
      );
      daemons.push(daemon);
      await daemon.start();

      const ghDir = path.join(path.dirname(workdir), "gh-config");
      // In the run dir (inherits the run's grant), never in the clone and never
      // the worker's tmpdir.
      expect(sink.env.GH_CONFIG_DIR).toBe(ghDir);
      const configFile = path.join(ghDir, "config.yml");
      expect(fs.readFileSync(configFile, "utf8")).toBe(
        `version: 1\nhttp_unix_socket: ${BROKER.ghSocketPath}\n`,
      );
      // Not a secret (a socket path); group/other read so the 0700-dir mask
      // trap is the only thing the grant has to undo.
      expect(fs.statSync(configFile).mode & 0o777).toBe(0o644);
      // The mask is restored for the AGENT on both the dir (traverse) and the
      // file (read) — and for nobody else.
      expect(aclCalls).toEqual([
        {
          file: "/usr/bin/setfacl",
          args: ["-m", "u:automata-agent:rwx", ghDir],
        },
        {
          file: "/usr/bin/setfacl",
          args: ["-m", "u:automata-agent:rw-", configFile],
        },
      ]);

      daemon.teardown();
      expect(fs.existsSync(ghDir)).toBe(false);
    });

    it("agent-uid mode: a dir left by a previous attempt is replaced, not reused", async () => {
      const { root, workdir, input } = fixture();
      const config = loadWorkerConfig({
        WORKER_RUN_NAMESPACE_ROOT: root,
        WORKER_DAEMON_DIST: "/opt/daemon/index.js",
        WORKER_AGENT_USER: "automata-agent",
        WORKER_WORKDIR_ROOT: root,
      });
      const ghDir = path.join(path.dirname(workdir), "gh-config");
      fs.mkdirSync(ghDir);
      fs.writeFileSync(path.join(ghDir, "hosts.yml"), "planted");
      fs.writeFileSync(path.join(ghDir, "config.yml"), "version: 1\n");
      const socket = runSocketPath(root, getProcessWorkerId(), input.threadId);
      fs.mkdirSync(path.dirname(socket), { recursive: true });
      const daemon = new DaemonProcess(
        config,
        input,
        workdir,
        null,
        null,
        BROKER,
        {
          aceExec: async () => {},
          spawnFn: fakeSpawn({ recorded: [], wrapperPgid: process.pid }),
          platform: "linux",
        },
      );
      daemons.push(daemon);
      await daemon.start();
      expect(fs.readdirSync(ghDir)).toEqual(["config.yml"]);
      expect(fs.readFileSync(path.join(ghDir, "config.yml"), "utf8")).toContain(
        `http_unix_socket: ${BROKER.ghSocketPath}`,
      );
    });

    it("default mode: unchanged — a private mkdtemp under os.tmpdir(), no ACL call, removed on teardown", async () => {
      const { root, workdir, input } = fixture();
      const recorded: Recorded[] = [];
      const aclCalls: Recorded[] = [];
      const config = loadWorkerConfig({
        WORKER_RUN_NAMESPACE_ROOT: root,
        WORKER_DAEMON_DIST: "/opt/daemon/index.js",
        WORKER_NODE_BIN: "/usr/bin/node",
      });
      const socket = runSocketPath(root, getProcessWorkerId(), input.threadId);
      fs.mkdirSync(path.dirname(socket), { recursive: true });
      const sink = { env: {} as Record<string, string> };
      const daemon = new DaemonProcess(
        config,
        input,
        workdir,
        null,
        null,
        BROKER,
        {
          aceExec: async (file, args) => void aclCalls.push({ file, args }),
          spawnFn: spawnCapturingEnv(recorded, sink),
          platform: "linux",
        },
      );
      daemons.push(daemon);
      await daemon.start();

      const ghDir = sink.env.GH_CONFIG_DIR ?? "";
      expect(path.dirname(ghDir)).toBe(os.tmpdir());
      expect(path.basename(ghDir)).toMatch(/^automata-gh-/);
      expect(fs.existsSync(path.join(path.dirname(workdir), "gh-config"))).toBe(
        false,
      );
      expect(fs.readFileSync(path.join(ghDir, "config.yml"), "utf8")).toBe(
        `version: 1\nhttp_unix_socket: ${BROKER.ghSocketPath}\n`,
      );
      expect(fs.statSync(ghDir).mode & 0o777).toBe(0o700);
      expect(aclCalls).toEqual([]);

      daemon.teardown();
      expect(fs.existsSync(ghDir)).toBe(false);
    });
  });

  function fixture() {
    // Short prefixes + a short threadId on purpose: the socket path must stay
    // under sun_path's cap (104 bytes on Darwin, where os.tmpdir() is already
    // ~50 chars) or macOS bind/connect silently truncate it and the suite
    // stops testing the path it thinks it does.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dpa-"));
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ace-script-"));
    // The clone sits in a run dir, beside gh-config/ and tmp/ (#302).
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-ace-wd-"));
    const workdir = path.join(runDir, "repo");
    fs.mkdirSync(workdir);
    tmpDirs.push(root, scriptDir, runDir);
    const input: AgentRunInput = {
      threadId: `t_${Math.random().toString(36).slice(2, 8)}`,
      threadChatId: "tc_1",
      repoFullName: "o/r",
      branch: "main",
      daemonCallbackUrl: "http://localhost:3999",
      installationToken: "inst",
      daemonToken: "daemon",
      orgId: "org-1",
    };
    assertUnderSunPathCap(
      runSocketPath(root, getProcessWorkerId(), input.threadId),
    );
    return { root, scriptDir, workdir, input };
  }

  /**
   * #204: the ceiling's WIRING — which branch is taken and in what order. The
   * kernel behaviour itself is drilled on the box, because a mocked cgroup
   * cannot OOM anything.
   */
  describe("per-run memory ceiling (#204)", () => {
    it("REFUSES to load a config with a ceiling and no uid drop", () => {
      // This used to decline per run with a log line and carry on, which is the
      // fail-open the whole feature argues against: the operator asked for a
      // ceiling, the box booted happily, and every run went uncapped with one
      // line in a stream nobody reads. Rejecting in loadWorkerConfig fails at
      // boot and at every run, because every caller loads this config.
      expect(() =>
        loadWorkerConfig({
          WORKER_RUN_NAMESPACE_ROOT: "/tmp/x",
          WORKER_DAEMON_DIST: "/opt/daemon/index.js",
          WORKER_NODE_BIN: "/usr/bin/node",
          WORKER_RUN_MEMORY_MAX: "1G",
          // WORKER_AGENT_USER deliberately absent
        }),
      ).toThrow(/WORKER_AGENT_USER is empty/);
    });

    it("reports no OOM when the ceiling was never applied", () => {
      // A run with no cgroup must never be classified resource-limit, whatever
      // its exit code was.
      const { root, workdir, input } = fixture();
      const config = loadWorkerConfig({
        WORKER_RUN_NAMESPACE_ROOT: root,
        WORKER_DAEMON_DIST: "/opt/daemon/index.js",
        WORKER_NODE_BIN: "/usr/bin/node",
      });
      expect(config.memoryMaxBytes).toBe(0);
      const daemon = new DaemonProcess(
        config,
        input,
        workdir,
        null,
        null,
        null,
        { spawnFn: fakeSpawn({ recorded: [] }) },
      );
      daemons.push(daemon);
      expect(daemon.oomKills()).toBe(0);
    });

    it("a start() that dies at the handshake still clears the ready marker", async () => {
      // The marker is the ONE piece of handshake state that outlives the process
      // tree: the cgroup goes with `cgroup.kill` + rmdir, but a stale marker left
      // beside a reused pidfile would tell the next wrapper it may exec before the
      // worker has capped it. teardown() runs from workflow.ts's finally on every
      // exit path, including a start() that threw — so it is the only place this
      // has to be true, and this pins it.
      const { root, workdir, input } = fixture();
      const config = loadWorkerConfig({
        WORKER_RUN_NAMESPACE_ROOT: root,
        WORKER_DAEMON_DIST: "/opt/daemon/index.js",
        WORKER_NODE_BIN: "/usr/bin/node",
      });
      const daemon = new DaemonProcess(
        config,
        input,
        workdir,
        null,
        null,
        null,
        {
          spawnFn: (() => {
            throw new Error("spawn blew up before the handshake");
          }) as unknown as typeof spawn,
        },
      );
      daemons.push(daemon);
      const marker = `${runPidPath(root, getProcessWorkerId(), input.threadId)}.cgroup-ready`;
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, "");
      await expect(daemon.start()).rejects.toThrow();
      daemon.teardown();
      expect(fs.existsSync(marker)).toBe(false);
    });

    it("a stale ready marker from a crashed run is cleared BEFORE the next spawn", async () => {
      // The marker is a safety interlock: the wrapper execs the moment it exists.
      // A leftover from a crashed run of the same threadId would let the next
      // agent start before the worker had capped it — uncapped, while every log
      // said capped. teardown covers the run that ends; this covers the run that
      // never got to.
      const { root, workdir, input } = fixture();
      const config = loadWorkerConfig({
        WORKER_RUN_NAMESPACE_ROOT: root,
        WORKER_DAEMON_DIST: "/opt/daemon/index.js",
        WORKER_NODE_BIN: "/usr/bin/node",
      });
      const recorded: Recorded[] = [];
      const socket = runSocketPath(root, getProcessWorkerId(), input.threadId);
      fs.mkdirSync(path.dirname(socket), { recursive: true });
      const marker = `${runPidPath(root, getProcessWorkerId(), input.threadId)}.cgroup-ready`;
      fs.writeFileSync(marker, "");
      const daemon = new DaemonProcess(
        config,
        input,
        workdir,
        null,
        null,
        null,
        { spawnFn: fakeSpawn({ recorded }) },
      );
      daemons.push(daemon);
      await daemon.start();
      // No ceiling in this config, so nothing re-creates it: if start() had not
      // cleared it, it would still be here.
      expect(fs.existsSync(marker)).toBe(false);
    });

    it("a configured ceiling on a box that cannot apply it FAILS the run, loudly", async () => {
      // The run-time counterpart of the boot refusal, and the point of the whole
      // feature: a box told to cap its runs must not run them uncapped. This used
      // to log "run cgroup skipped: <reason>" and spawn the agent anyway. Any
      // platform without a delegated cgroup v2 subtree exercises it — including
      // this one, which is why the assertion is on the message, not the platform.
      const { root, workdir, input } = fixture();
      const config = loadWorkerConfig({
        WORKER_RUN_NAMESPACE_ROOT: root,
        WORKER_DAEMON_DIST: "/opt/daemon/index.js",
        WORKER_NODE_BIN: "/usr/bin/node",
        WORKER_RUN_MEMORY_MAX: "1G",
        WORKER_AGENT_USER: "automata-agent",
        WORKER_WORKDIR_ROOT: root,
      });
      const socket = runSocketPath(root, getProcessWorkerId(), input.threadId);
      fs.mkdirSync(path.dirname(socket), { recursive: true });
      const aclCalls: Recorded[] = [];
      const daemon = new DaemonProcess(
        config,
        input,
        workdir,
        null,
        null,
        null,
        {
          spawnFn: fakeSpawn({ recorded: [] }),
          // Linux semantics on every host, and an ACL runner that fails the way
          // a real `setfacl` does on a box without the agent account (CI).
          // The suite never shells out to setfacl; this also pins that the
          // ceiling refusal is reported before any per-run grant is attempted,
          // so an operator sees the misconfiguration, not an incidental error.
          platform: "linux",
          aceExec: async (file, args) => {
            aclCalls.push({ file, args });
            throw new Error(`Command failed: ${file} ${args.join(" ")}`);
          },
        },
      );
      daemons.push(daemon);
      await expect(daemon.start()).rejects.toThrow(
        /per-run memory ceiling is configured but/,
      );
      expect(aclCalls).toEqual([]);
    });

    it("a CLEAN exit 0 is not a failure, even with the ceiling on", () => {
      // The daemon exiting 0 means it finished; www records the terminal status
      // independently and may write it AFTER the exit. Treating that exit as a
      // failure turned a run that SUCCEEDED into a retryable error — on exactly
      // the boxes the ceiling is enabled on, which is where it matters.
      //
      // Driven without start(): with a ceiling configured and no /proc, start()
      // now refuses by design (the fail-closed path), so the child is planted
      // directly. The branch under test is a predicate on (exitCode, signalCode)
      // and needs nothing else.
      const { root, workdir, input } = fixture();
      const config = loadWorkerConfig({
        WORKER_RUN_NAMESPACE_ROOT: root,
        WORKER_DAEMON_DIST: "/opt/daemon/index.js",
        WORKER_NODE_BIN: "/usr/bin/node",
        WORKER_RUN_MEMORY_MAX: "1G",
        WORKER_AGENT_USER: "automata-agent",
        WORKER_WORKDIR_ROOT: root,
      });
      const daemon = new DaemonProcess(config, input, workdir);
      daemons.push(daemon);
      const planted = {
        exitCode: 0 as number | null,
        signalCode: null as string | null,
      };
      (daemon as unknown as { child: unknown }).child = planted;

      // Clean exit, no signal: the run finished.
      expect(daemon.agentFailure()).toBeNull();

      // Still covered — a non-zero exit, and a signal, which is how an OOM kill
      // and a supersede both arrive.
      planted.exitCode = 1;
      expect(daemon.agentFailure()).toBeInstanceOf(Error);
      planted.exitCode = null;
      planted.signalCode = "SIGKILL";
      expect(daemon.agentFailure()).toBeInstanceOf(Error);

      // And still running is still not a failure.
      planted.exitCode = null;
      planted.signalCode = null;
      expect(daemon.agentFailure()).toBeNull();
    });

    it("agentFailure stays silent on a box with no ceiling — default-off is literal", async () => {
      // Noticing a dead agent mid-run would help every box, but switching it on
      // everywhere is a behaviour change this PR does not own: a daemon that
      // exits cleanly just before www records terminal would start failing runs
      // that pass today. So the check exists only where the ceiling does.
      const { root, workdir, input } = fixture();
      const config = loadWorkerConfig({
        WORKER_RUN_NAMESPACE_ROOT: root,
        WORKER_DAEMON_DIST: "/opt/daemon/index.js",
        WORKER_NODE_BIN: "/usr/bin/node",
        // WORKER_RUN_MEMORY_MAX deliberately absent
      });
      const recorded: Recorded[] = [];
      const socket = runSocketPath(root, getProcessWorkerId(), input.threadId);
      fs.mkdirSync(path.dirname(socket), { recursive: true });
      const inner = fakeSpawn({ recorded });
      let spawned: ChildProcess | null = null;
      const daemon = new DaemonProcess(
        config,
        input,
        workdir,
        null,
        null,
        null,
        {
          spawnFn: ((file: string, args: string[], o: SpawnOptions) => {
            spawned = inner(file, args, o);
            return spawned;
          }) as unknown as typeof spawn,
        },
      );
      daemons.push(daemon);
      await daemon.start();
      const child = spawned as unknown as {
        exitCode: number | null;
        signalCode: string | null;
      };
      // A clean exit 0, which is the case that would newly fail runs.
      child.exitCode = 0;
      child.signalCode = null;
      expect(daemon.agentFailure()).toBeNull();
    });

    /**
     * Prod 2026-10-04 (e335c83d): 16 OOM kills in a task run's cgroup, thread
     * "complete". The cgroup is planted as a tmp dir holding `memory.events`,
     * the same way the child is planted above — a mocked cgroup cannot OOM.
     */
    function ceilingDaemon(memoryEvents: string) {
      const { root, workdir, input } = fixture();
      const config = loadWorkerConfig({
        WORKER_RUN_NAMESPACE_ROOT: root,
        WORKER_DAEMON_DIST: "/opt/daemon/index.js",
        WORKER_NODE_BIN: "/usr/bin/node",
        WORKER_RUN_MEMORY_MAX: "1500M",
        WORKER_AGENT_USER: "automata-agent",
        WORKER_WORKDIR_ROOT: root,
      });
      const cgroupDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-cg-"));
      tmpDirs.push(cgroupDir);
      fs.writeFileSync(path.join(cgroupDir, "memory.events"), memoryEvents);
      const daemon = new DaemonProcess(config, input, workdir);
      daemons.push(daemon);
      (daemon as unknown as { cgroupDir: string | null }).cgroupDir = cgroupDir;
      return { daemon, cgroupDir, input };
    }

    it("memoryStarvation fails the run while the agent is still ALIVE", () => {
      // The prod shape: children OOM-killed, the agent itself never exited, so
      // agentFailure() (which keys on the agent's exit) stays null forever.
      const { daemon } = ceilingDaemon("oom 3\noom_kill 16\n");
      (daemon as unknown as { child: unknown }).child = {
        exitCode: null,
        signalCode: null,
      };
      expect(daemon.agentFailure()).toBeNull();
      const starved = daemon.memoryStarvation();
      expect(starved).toBeInstanceOf(NonRetryableError);
      expect((starved as Error).message).toMatch(
        /^Out of memory: 16 process\(es\) killed by the per-run memory limit \(memory\.max=1500M\)/,
      );
    });

    it("memoryStarvation is null for a run that never hit oom_kill", () => {
      // `oom` alone (the ceiling was hit but reclaim won) killed nothing.
      const { daemon } = ceilingDaemon("oom 2\noom_kill 0\n");
      expect(daemon.memoryStarvation()).toBeNull();
    });

    it("teardown ALWAYS journals both counters, read before the cgroup goes", () => {
      const { daemon, input } = ceilingDaemon("oom 3\noom_kill 16\n");
      const lines: string[] = [];
      const spy = vi
        .spyOn(console, "error")
        .mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(" "));
        });
      try {
        daemon.teardown();
      } finally {
        spy.mockRestore();
      }
      expect(lines).toContainEqual(
        expect.stringContaining(
          `run cgroup: oom_kill=16 oom=3 thread=${input.threadId} memory.max=1500M`,
        ),
      );
      // Cached across the removal: the classification can still run after.
      expect(daemon.memoryStarvation()).toBeInstanceOf(NonRetryableError);
    });

    it("teardown journals a clean run too — zero is evidence, not noise", () => {
      const { daemon } = ceilingDaemon("oom 0\noom_kill 0\n");
      const lines: string[] = [];
      const spy = vi
        .spyOn(console, "error")
        .mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(" "));
        });
      try {
        daemon.teardown();
      } finally {
        spy.mockRestore();
      }
      expect(lines).toContainEqual(
        expect.stringContaining("run cgroup: oom_kill=0 oom=0"),
      );
    });

    it("memoryStarvation stays silent on a box with no ceiling", () => {
      const { root, workdir, input } = fixture();
      const config = loadWorkerConfig({
        WORKER_RUN_NAMESPACE_ROOT: root,
        WORKER_DAEMON_DIST: "/opt/daemon/index.js",
        WORKER_NODE_BIN: "/usr/bin/node",
      });
      const daemon = new DaemonProcess(config, input, workdir);
      daemons.push(daemon);
      expect(daemon.memoryStarvation()).toBeNull();
    });
  });
});
