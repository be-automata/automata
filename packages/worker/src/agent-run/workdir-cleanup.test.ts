import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupWorkdir,
  STALE_RUN_DIR_AGE_MS,
  SWEEP_BUDGET_MS,
  sweepStaleRunDirs,
} from "./provision";

const RUN_A = "0b7c1f4e-1d2a-4c3b-9e8f-1a2b3c4d5e6f";
const RUN_B = "9f8e7d6c-5b4a-4321-8fed-cba987654321";

describe("cleanupWorkdir", () => {
  let root: string;
  let workdir: string;
  let lines: string[];
  const log = (line: string) => lines.push(line);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "workdir-cleanup-"));
    workdir = path.join(root, RUN_A);
    await fs.mkdir(path.join(workdir, "home", ".claude"), { recursive: true });
    await fs.writeFile(path.join(workdir, "home", ".claude", "s.json"), "{}");
    lines = [];
  });

  afterEach(async () => {
    await fs.chmod(path.join(workdir, "locked"), 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });

  // card: protects=a run dir (HOME staging included) is removed and reported gone, silently; fails_when=the dir survives, the result is false, or a line is logged; no_claim=the container's own workspace hand-back before removal
  it("removes the run dir and reports it gone", async () => {
    expect(await cleanupWorkdir(workdir, { log })).toBe(true);
    expect(await fs.stat(workdir).catch(() => null)).toBe(null);
    expect(lines).toEqual([]);
  });

  // card: protects=a run dir that survives the rm is logged once with its errno and never thrown (a cleanup failure must not fail the run); fails_when=it throws, logs nothing or reports success; no_claim=why the rm failed
  it("a workdir that survives the rm is logged once with its errno, never thrown", async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    const locked = path.join(workdir, "locked");
    await fs.mkdir(locked);
    await fs.writeFile(path.join(locked, "session.key"), "k");
    await fs.chmod(locked, 0o500);
    const gone = await cleanupWorkdir(workdir, { log });
    expect(gone).toBe(false);
    expect(lines).toEqual([`workdir cleanup incomplete: ${workdir} (EACCES)`]);
  });
});

describe("sweepStaleRunDirs", () => {
  let root: string;
  let outside: string;
  let lines: string[];
  const log = (line: string) => lines.push(line);
  const OLD = (Date.now() - STALE_RUN_DIR_AGE_MS - 60_000) / 1000;

  async function runDir(name: string, old: boolean): Promise<string> {
    const dir = path.join(root, name);
    await fs.mkdir(path.join(dir, "home"), { recursive: true });
    await fs.writeFile(path.join(dir, "home", "f"), "x");
    if (old) await fs.utimes(dir, OLD, OLD);
    return dir;
  }

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "stale-sweep-"));
    root = path.join(base, "runs");
    outside = path.join(base, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    lines = [];
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  it("removes only old run-named directories; fresh, foreign-named and symlinked entries stay", async () => {
    const stale = await runDir(RUN_A, true);
    const tombstone = await runDir(`${RUN_B}.tombstone-1727000000000`, true);
    const fresh = await runDir(RUN_B, false);
    const foreign = await runDir("not-a-run", true);
    // A run-named symlink to an old dir OUTSIDE the root: never followed.
    await fs.utimes(outside, OLD, OLD);
    const link = path.join(root, "11111111-2222-4333-8444-555555555555");
    await fs.symlink(outside, link);

    const result = await sweepStaleRunDirs({ workdirRoot: root, log });

    expect(result).toEqual({ removed: 2, kept: 3, failed: 0, deferred: 0 });
    expect(await fs.stat(stale).catch(() => null)).toBe(null);
    expect(await fs.stat(tombstone).catch(() => null)).toBe(null);
    expect(await fs.stat(fresh)).toBeTruthy();
    expect(await fs.stat(foreign)).toBeTruthy();
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.stat(outside)).toBeTruthy();
    expect(await fs.stat(root)).toBeTruthy();
    expect(lines).toEqual([
      "stale run dirs swept: removed=2 kept=3 failed=0 deferred=0",
    ]);
  });

  it("counts a dir it could not remove as failed and stops: the rest wait for the next boot", async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    const stuck = await runDir(RUN_A, false);
    const locked = path.join(stuck, "home");
    await fs.chmod(locked, 0o500);
    await fs.utimes(stuck, OLD, OLD);
    await runDir(RUN_B, true);
    try {
      const result = await sweepStaleRunDirs({ workdirRoot: root, log });
      // RUN_A sorts first, so the failure is hit before RUN_B is reached.
      expect(result).toEqual({ removed: 0, kept: 0, failed: 1, deferred: 1 });
      expect(lines).toEqual([
        `workdir cleanup incomplete: ${stuck} (EACCES)`,
        "stale run dirs swept: removed=0 kept=0 failed=1 deferred=1",
      ]);
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });

  it("a missing root is a quiet no-op, never a throw", async () => {
    const result = await sweepStaleRunDirs({
      workdirRoot: path.join(root, "nope"),
      log,
    });
    expect(result).toEqual({ removed: 0, kept: 0, failed: 0, deferred: 0 });
    expect(lines).toEqual([]);
  });

  // card: protects=the boot sweep stops at SWEEP_BUDGET_MS of wall clock and defers the rest (boot is never held past it); fails_when=a dir past the budget is still removed or the deferral is not counted; no_claim=how long a real rm takes
  it("stops at the total budget: boot is never held past SWEEP_BUDGET_MS", async () => {
    const first = await runDir(RUN_A, true);
    const second = await runDir(RUN_B, true);
    // Every clock read advances a third of the budget: the first dir is
    // reached 2/3 in, the second 4/3 in (past the budget).
    let t = Date.now();
    const now = () => {
      const v = t;
      t += Math.ceil(SWEEP_BUDGET_MS / 3);
      return v;
    };
    const result = await sweepStaleRunDirs({ workdirRoot: root, log, now });
    expect(result).toEqual({ removed: 1, kept: 0, failed: 0, deferred: 1 });
    expect(await fs.stat(first).catch(() => null)).toBe(null);
    expect(await fs.stat(second)).toBeTruthy();
  });
});
