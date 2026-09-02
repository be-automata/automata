import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reapOwnThreadAttempts, reclaimDeadWorkerRuns } from "./reclaim";
import { WORKER_LOCK_FILENAME } from "./run-namespace";

/**
 * Phase 0.2b boot-reclaim unit tests. A worker reaps daemons orphaned by a DEAD
 * sibling worker (group-SIGKILL + rm the dir) but NEVER touches a live worker's dir,
 * and tolerates malformed/absent files without throwing.
 */

const roots: string[] = [];

function tmpRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-"));
  roots.push(r);
  return r;
}

/** Create a `<root>/<workerId>/` dir with a worker.lock pid and optional daemon pids. */
function makeWorkerDir(
  root: string,
  workerId: string,
  opts: { lockPid?: string | null; daemonPids?: number[] },
): string {
  const dir = path.join(root, workerId);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.lockPid !== null && opts.lockPid !== undefined) {
    fs.writeFileSync(path.join(dir, WORKER_LOCK_FILENAME), opts.lockPid);
  }
  for (const pid of opts.daemonPids ?? []) {
    fs.writeFileSync(path.join(dir, `thr_${pid}.pid`), String(pid));
  }
  return dir;
}

afterEach(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  roots.length = 0;
});

describe("reclaimDeadWorkerRuns", () => {
  it("reaps a DEAD sibling: group-SIGKILLs its daemon pids and removes the dir", () => {
    const root = tmpRoot();
    // lock pid 999999 is dead (kill(pid,0) throws ESRCH); it recorded two daemons.
    const deadDir = makeWorkerDir(root, "w-dead", {
      lockPid: "999999",
      daemonPids: [4242, 4343],
    });

    const kills: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const kill = (pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) {
        // liveness probe: 999999 is dead.
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      kills.push({ pid, signal });
    };

    reclaimDeadWorkerRuns({ root, selfWorkerId: "w-self", kill });

    // Both daemon process GROUPS killed (negative pid), then the dir removed.
    expect(kills).toEqual(
      expect.arrayContaining([
        { pid: -4242, signal: "SIGKILL" },
        { pid: -4343, signal: "SIGKILL" },
      ]),
    );
    expect(kills).toHaveLength(2);
    expect(fs.existsSync(deadDir)).toBe(false);
  });

  it("NEVER touches a LIVE sibling's dir", () => {
    const root = tmpRoot();
    // This process's own pid is alive → kill(pid,0) succeeds.
    const liveDir = makeWorkerDir(root, "w-live", {
      lockPid: String(process.pid),
      daemonPids: [5555],
    });

    const killSpy = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) return; // alive
      throw new Error("should not group-kill a live worker's daemons");
    });

    reclaimDeadWorkerRuns({ root, selfWorkerId: "w-self", kill: killSpy });

    // Dir untouched; no SIGKILL issued (only the liveness probe with signal 0).
    expect(fs.existsSync(liveDir)).toBe(true);
    for (const call of killSpy.mock.calls) {
      expect(call[1]).toBe(0);
    }
  });

  it("skips its OWN dir", () => {
    const root = tmpRoot();
    const selfDir = makeWorkerDir(root, "w-self", {
      lockPid: "999999", // dead pid, but it's OURS → must be skipped
      daemonPids: [6666],
    });
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) {
        const err = new Error("dead") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
    });

    reclaimDeadWorkerRuns({ root, selfWorkerId: "w-self", kill });

    expect(fs.existsSync(selfDir)).toBe(true);
    // Our own dir is skipped before any liveness probe or kill.
    expect(kill).not.toHaveBeenCalled();
  });

  it("tolerates a missing or malformed worker.lock (skips, never throws)", () => {
    const root = tmpRoot();
    const noLock = makeWorkerDir(root, "w-nolock", {
      lockPid: null,
      daemonPids: [1],
    });
    const badLock = makeWorkerDir(root, "w-badlock", {
      lockPid: "not-a-pid",
      daemonPids: [2],
    });

    const kill = vi.fn((_pid: number, _signal: NodeJS.Signals | 0) => {});
    expect(() =>
      reclaimDeadWorkerRuns({ root, selfWorkerId: "w-self", kill }),
    ).not.toThrow();

    // Ambiguous dirs are conservatively left in place; no kills issued.
    expect(fs.existsSync(noLock)).toBe(true);
    expect(fs.existsSync(badLock)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it("tolerates a malformed daemon pidfile inside a reaped dead dir", () => {
    const root = tmpRoot();
    const dir = path.join(root, "w-dead");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, WORKER_LOCK_FILENAME), "999999");
    fs.writeFileSync(path.join(dir, "thr_good.pid"), "7777");
    fs.writeFileSync(path.join(dir, "thr_bad.pid"), "garbage");

    const kills: number[] = [];
    const kill = (pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) {
        const err = new Error("dead") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      kills.push(pid);
    };

    expect(() =>
      reclaimDeadWorkerRuns({ root, selfWorkerId: "w-self", kill }),
    ).not.toThrow();

    // Only the well-formed daemon pid was killed; the dir was still removed.
    expect(kills).toEqual([-7777]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("returns quietly when the namespace root does not exist", () => {
    expect(() =>
      reclaimDeadWorkerRuns({
        root: path.join(os.tmpdir(), `reclaim-missing-${Date.now()}`),
        selfWorkerId: "w-self",
      }),
    ).not.toThrow();
  });
});

/**
 * #108: across a uid boundary process.kill(-pgid) is EPERM, so the group kill
 * shells out as the agent account. The liveness probe deliberately does NOT —
 * it targets the sibling worker.lock pid, always the operator's own uid.
 */
describe("reclaimDeadWorkerRuns — agent-uid mode", () => {
  it("agentUser empty: still group-kills with process.kill(-pgid) (unchanged)", () => {
    const root = tmpRoot();
    makeWorkerDir(root, "w-dead", { lockPid: "111", daemonPids: [222] });
    const kill = vi.fn((pid: number) => {
      if (pid === 111) {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
    });
    const spawnKill = vi.fn();
    reclaimDeadWorkerRuns({
      root,
      selfWorkerId: "w-self",
      kill,
      spawnKill,
    });
    expect(kill).toHaveBeenCalledWith(-222, "SIGKILL");
    expect(spawnKill).not.toHaveBeenCalled();
  });

  it("agentUser set: builds sudo -u <user> /bin/kill -9 -- -<pgid> per orphan pid", () => {
    const root = tmpRoot();
    makeWorkerDir(root, "w-dead", { lockPid: "111", daemonPids: [222, 333] });
    const kill = vi.fn((pid: number) => {
      if (pid === 111) {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
    });
    const spawnKill = vi.fn();
    reclaimDeadWorkerRuns({
      root,
      selfWorkerId: "w-self",
      agentUser: "_automata-agent",
      kill,
      spawnKill,
    });

    const targets = spawnKill.mock.calls
      .map((c) => (c[0] as { args: string[] }).args.at(-1))
      .sort();
    expect(targets).toEqual(["-222", "-333"]);
    for (const [inv] of spawnKill.mock.calls) {
      expect((inv as { file: string }).file).toBe("/usr/bin/sudo");
      expect((inv as { args: string[] }).args.slice(0, 3)).toEqual([
        "-n",
        "-u",
        "_automata-agent",
      ]);
    }
    // process.kill is used ONLY for the worker.lock liveness probe.
    expect(kill.mock.calls).toEqual([[111, 0]]);
  });

  it("agentUser set: a LIVE sibling is never touched", () => {
    const root = tmpRoot();
    makeWorkerDir(root, "w-live", { lockPid: "111", daemonPids: [222] });
    const spawnKill = vi.fn();
    reclaimDeadWorkerRuns({
      root,
      selfWorkerId: "w-self",
      agentUser: "_automata-agent",
      kill: () => {}, // signal delivered → alive
      spawnKill,
    });
    expect(spawnKill).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "w-live"))).toBe(true);
  });

  it("agentUser set: a malformed pid file is tolerated without throwing", () => {
    const root = tmpRoot();
    const dir = makeWorkerDir(root, "w-dead", { lockPid: "111" });
    fs.writeFileSync(path.join(dir, "thr_bad.pid"), "not-a-pid");
    const spawnKill = vi.fn();
    expect(() =>
      reclaimDeadWorkerRuns({
        root,
        selfWorkerId: "w-self",
        agentUser: "_automata-agent",
        kill: (pid: number) => {
          if (pid === 111) {
            const err = new Error("gone") as NodeJS.ErrnoException;
            err.code = "ESRCH";
            throw err;
          }
        },
        spawnKill,
      }),
    ).not.toThrow();
    expect(spawnKill).not.toHaveBeenCalled();
  });
});

describe("reapOwnThreadAttempts (#152 Stage A admission reap)", () => {
  const THREAD = "11111111-2222-3333-4444-555555555555";

  function writeRunPid(root: string, workerId: string, pid: number): string {
    const dir = path.join(root, workerId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${THREAD}.pid`);
    fs.writeFileSync(file, String(pid));
    return file;
  }

  it("SIGKILLs a prior attempt's group recorded in the OWN dir and removes only the pid file", () => {
    const root = tmpRoot();
    const file = writeRunPid(root, "worker-self", 7001);
    fs.writeFileSync(
      path.join(root, "worker-self", WORKER_LOCK_FILENAME),
      String(process.pid),
    );
    const kills: Array<[number, unknown]> = [];
    const n = reapOwnThreadAttempts({
      root,
      threadId: THREAD,
      kill: (pid, sig) => kills.push([pid, sig]),
    });
    expect(n).toBe(1);
    expect(kills).toEqual([[-7001, "SIGKILL"]]);
    expect(fs.existsSync(file)).toBe(false);
    // The dir (and its lock) survives — only the pid file goes.
    expect(
      fs.existsSync(path.join(root, "worker-self", WORKER_LOCK_FILENAME)),
    ).toBe(true);
  });

  it("reaps the same thread's attempt under a LIVE sibling dir (redelivery after that worker's kill) without touching the sibling's other runs", () => {
    const root = tmpRoot();
    const target = writeRunPid(root, "worker-sibling", 7002);
    // The sibling also records an UNRELATED run — must survive.
    const other = path.join(root, "worker-sibling", "other-thread.pid");
    fs.writeFileSync(other, "7003");
    fs.writeFileSync(
      path.join(root, "worker-sibling", WORKER_LOCK_FILENAME),
      String(process.pid),
    );
    const kills: Array<[number, unknown]> = [];
    const n = reapOwnThreadAttempts({
      root,
      threadId: THREAD,
      kill: (pid, sig) => kills.push([pid, sig]),
    });
    expect(n).toBe(1);
    expect(kills).toEqual([[-7002, "SIGKILL"]]);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
  });

  it("agentUser set: shells the group kill as the agent account instead of process.kill", () => {
    const root = tmpRoot();
    writeRunPid(root, "w1", 7004);
    const kills: Array<[number, unknown]> = [];
    const spawned: string[][] = [];
    reapOwnThreadAttempts({
      root,
      threadId: THREAD,
      agentUser: "automata-agent",
      kill: (pid, sig) => kills.push([pid, sig]),
      spawnKill: (inv) => spawned.push([inv.file, ...inv.args]),
    });
    expect(kills).toEqual([]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.join(" ")).toContain("-7004");
  });

  it("no pid file anywhere / missing root: returns 0, never throws", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "empty-worker"), { recursive: true });
    expect(reapOwnThreadAttempts({ root, threadId: THREAD })).toBe(0);
    expect(
      reapOwnThreadAttempts({
        root: path.join(root, "nope"),
        threadId: THREAD,
      }),
    ).toBe(0);
  });

  it("malformed pid file is tolerated and left in place", () => {
    const root = tmpRoot();
    const dir = path.join(root, "w1");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${THREAD}.pid`);
    fs.writeFileSync(file, "not-a-pid");
    const kills: Array<[number, unknown]> = [];
    expect(
      reapOwnThreadAttempts({
        root,
        threadId: THREAD,
        kill: (p, s2) => kills.push([p, s2]),
      }),
    ).toBe(0);
    expect(kills).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
  });
});
