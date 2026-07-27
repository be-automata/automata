import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reclaimDeadWorkerRuns } from "./reclaim";
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
