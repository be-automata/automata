import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupWorkdir,
  STALE_RUN_DIR_AGE_MS,
  SWEEP_BUDGET_MS,
  sweepStaleRunDirs,
  type RunAsAgent,
} from "./provision";
import {
  buildHandBackInvocation,
  HAND_BACK_SCRIPT,
  SH_BIN,
  SUDO_BIN,
} from "./spawn-as-user";

const execFileAsync = promisify(execFile);

const AGENT = "automata-agent";
const RUN_A = "0b7c1f4e-1d2a-4c3b-9e8f-1a2b3c4d5e6f";
const RUN_B = "9f8e7d6c-5b4a-4321-8fed-cba987654321";

function handBackArgv(workdir: string): string[] {
  return [
    "-n",
    "-u",
    AGENT,
    "--",
    SH_BIN,
    "-c",
    HAND_BACK_SCRIPT,
    "sh",
    workdir,
  ];
}

describe("buildHandBackInvocation", () => {
  it("is sudo -n -u <agent> -- sh -c <fixed script> sh <workdir>, no -E", () => {
    const inv = buildHandBackInvocation({
      agentUser: AGENT,
      workdir: "/usr/local/automata/runs/x",
    });
    expect(inv).toEqual({
      file: SUDO_BIN,
      args: handBackArgv("/usr/local/automata/runs/x"),
      env: {},
    });
  });

  it("never interpolates the workdir into the script", () => {
    const workdir = '/runs/$(touch pwned)"; rm -rf /';
    const inv = buildHandBackInvocation({ agentUser: AGENT, workdir });
    expect(inv?.args[6]).toBe(HAND_BACK_SCRIPT);
    expect(inv?.args.at(-1)).toBe(workdir);
  });

  it("is null without an agent user", () => {
    expect(buildHandBackInvocation({ agentUser: "", workdir: "/x" })).toBe(
      null,
    );
  });

  it("refuses a relative workdir and the filesystem root", () => {
    expect(() =>
      buildHandBackInvocation({ agentUser: AGENT, workdir: "-delete" }),
    ).toThrow(/absolute/);
    expect(() =>
      buildHandBackInvocation({ agentUser: AGENT, workdir: "/" }),
    ).toThrow(/absolute/);
  });

  it("refuses an agent user that is not a plain login", () => {
    expect(() =>
      buildHandBackInvocation({ agentUser: "-u", workdir: "/x" }),
    ).toThrow(/plain unix login/);
  });
});

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

  it("linux + agent user: hands the files back as the agent BEFORE the rm", async () => {
    let existedAtHandBack = false;
    const runAsAgent = vi.fn<RunAsAgent>(async () => {
      existedAtHandBack = !!(await fs.stat(workdir).catch(() => null));
      return { code: 0, signal: null };
    });
    const gone = await cleanupWorkdir(workdir, {
      agentUser: AGENT,
      log,
      platform: "linux",
      runAsAgent,
    });
    expect(runAsAgent).toHaveBeenCalledTimes(1);
    expect(runAsAgent).toHaveBeenCalledWith({
      file: SUDO_BIN,
      args: handBackArgv(workdir),
      env: {},
    });
    expect(existedAtHandBack).toBe(true);
    expect(gone).toBe(true);
    expect(await fs.stat(workdir).catch(() => null)).toBe(null);
    expect(lines).toEqual([]);
  });

  it("darwin: no hand-back (a macOS allow-ACE survives 0700), rm only", async () => {
    const runAsAgent = vi.fn<RunAsAgent>();
    const gone = await cleanupWorkdir(workdir, {
      agentUser: AGENT,
      log,
      platform: "darwin",
      runAsAgent,
    });
    expect(runAsAgent).not.toHaveBeenCalled();
    expect(gone).toBe(true);
  });

  it("empty agent user: no hand-back, rm only", async () => {
    const runAsAgent = vi.fn<RunAsAgent>();
    const gone = await cleanupWorkdir(workdir, {
      agentUser: "",
      log,
      platform: "linux",
      runAsAgent,
    });
    expect(runAsAgent).not.toHaveBeenCalled();
    expect(gone).toBe(true);
  });

  it("an already-removed workdir: no hand-back, no warning", async () => {
    await fs.rm(workdir, { recursive: true });
    const runAsAgent = vi.fn<RunAsAgent>();
    const gone = await cleanupWorkdir(workdir, {
      agentUser: AGENT,
      log,
      platform: "linux",
      runAsAgent,
    });
    expect(runAsAgent).not.toHaveBeenCalled();
    expect(gone).toBe(true);
    expect(lines).toEqual([]);
  });

  it("a hand-back that cannot start is logged, never thrown, and the rm still runs", async () => {
    const runAsAgent = vi.fn<RunAsAgent>(async () => {
      throw new Error("spawn /usr/bin/sudo ENOENT");
    });
    const gone = await cleanupWorkdir(workdir, {
      agentUser: AGENT,
      log,
      platform: "linux",
      runAsAgent,
    });
    expect(gone).toBe(true);
    expect(lines).toEqual([
      `workdir hand-back failed: ${workdir} (spawn /usr/bin/sudo ENOENT)`,
    ]);
  });

  it("a refused or failing hand-back logs its exit and stderr tail", async () => {
    const runAsAgent = vi.fn<RunAsAgent>(async () => ({
      code: 1,
      signal: null,
      stderrTail: "sudo: a password is required",
    }));
    await cleanupWorkdir(workdir, {
      agentUser: AGENT,
      log,
      platform: "linux",
      runAsAgent,
    });
    expect(lines).toEqual([
      `workdir hand-back incomplete: ${workdir} (exit 1: sudo: a password is required)`,
    ]);
  });

  it("a workdir that survives the rm is logged once with its errno, never thrown", async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    const locked = path.join(workdir, "locked");
    await fs.mkdir(locked);
    await fs.writeFile(path.join(locked, "session.key"), "k");
    await fs.chmod(locked, 0o500);
    const gone = await cleanupWorkdir(workdir, { log, platform: "darwin" });
    expect(gone).toBe(false);
    expect(lines).toEqual([`workdir cleanup incomplete: ${workdir} (EACCES)`]);
  });
});

describe("HAND_BACK_SCRIPT shape", () => {
  it("leaves the worker's cwd before find (the agent uid cannot enter it; GNU find then aborts)", () => {
    // Reproduced on the box: without `cd /`, find exits 1 with "Failed to
    // restore initial working directory" and chmods nothing.
    expect(HAND_BACK_SCRIPT.startsWith("cd / && find ")).toBe(true);
  });
});

describe("HAND_BACK_SCRIPT (real sh, as the current user)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hand-back-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("opens the group bits on owned dirs/files and never follows a symlink out", async () => {
    const workdir = path.join(root, "run");
    const sessions = path.join(workdir, "home", ".claude", "sessions");
    await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
    await fs.chmod(sessions, 0o700);
    const key = path.join(sessions, "1.abc.key");
    await fs.writeFile(key, "k", { mode: 0o600 });
    const outside = path.join(root, "outside.txt");
    await fs.writeFile(outside, "x", { mode: 0o600 });
    await fs.symlink(outside, path.join(workdir, "escape"));

    await execFileAsync(SH_BIN, ["-c", HAND_BACK_SCRIPT, "sh", workdir]);

    expect((await fs.stat(sessions)).mode & 0o070).toBe(0o070);
    // X adds search only to directories: a 0600 file gains rw, not x.
    expect((await fs.stat(key)).mode & 0o070).toBe(0o060);
    expect((await fs.stat(outside)).mode & 0o777).toBe(0o600);
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

    const result = await sweepStaleRunDirs({
      workdirRoot: root,
      agentUser: "",
      log,
    });

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

  it("hands back each stale dir as the agent on linux, and only those", async () => {
    const stale = await runDir(RUN_A, true);
    await runDir(RUN_B, false);
    const runAsAgent = vi.fn<RunAsAgent>(async () => ({
      code: 0,
      signal: null,
    }));
    await sweepStaleRunDirs({
      workdirRoot: root,
      agentUser: AGENT,
      log,
      platform: "linux",
      runAsAgent,
    });
    expect(runAsAgent).toHaveBeenCalledTimes(1);
    expect(runAsAgent).toHaveBeenCalledWith({
      file: SUDO_BIN,
      args: handBackArgv(stale),
      env: {},
    });
  });

  it("counts a dir it could not remove as failed and stops: the rest wait for the next boot", async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    const stuck = await runDir(RUN_A, false);
    const locked = path.join(stuck, "home");
    await fs.chmod(locked, 0o500);
    await fs.utimes(stuck, OLD, OLD);
    await runDir(RUN_B, true);
    try {
      const result = await sweepStaleRunDirs({
        workdirRoot: root,
        agentUser: "",
        log,
      });
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
      agentUser: "",
      log,
    });
    expect(result).toEqual({ removed: 0, kept: 0, failed: 0, deferred: 0 });
    expect(lines).toEqual([]);
  });

  it("stops at the total budget: boot is never held past SWEEP_BUDGET_MS", async () => {
    const first = await runDir(RUN_A, true);
    const second = await runDir(RUN_B, true);
    let t = Date.now();
    // Every clean-up "takes" the whole budget.
    const runAsAgent = vi.fn<RunAsAgent>(async () => {
      t += SWEEP_BUDGET_MS;
      return { code: 0, signal: null };
    });
    const result = await sweepStaleRunDirs({
      workdirRoot: root,
      agentUser: AGENT,
      log,
      platform: "linux",
      runAsAgent,
      now: () => t,
    });
    expect(runAsAgent).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ removed: 1, kept: 0, failed: 0, deferred: 1 });
    expect(await fs.stat(first).catch(() => null)).toBe(null);
    expect(await fs.stat(second)).toBeTruthy();
  });
});
