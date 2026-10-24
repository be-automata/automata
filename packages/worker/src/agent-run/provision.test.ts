import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect, promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureBaseDiffable, gitExec, provisionWorkdir } from "./provision";

const execFileAsync = promisify(execFile);

/**
 * Real-git integration test for the BUG-EXEC-02 base-diffability fix (no mocks). Builds a
 * synthetic origin where `main` (the base) DIVERGES after the PR branched, reproduces the
 * daemon's shallow head-only clone, then asserts ensureBaseDiffable makes an OFFLINE,
 * merge-base-accurate `git diff origin/main...HEAD` possible — the exact condition that
 * failed on the S2/S3 re-reviews (fetch timed out, single orphan commit, no base ref).
 */
describe("ensureBaseDiffable (BUG-EXEC-02)", () => {
  let root: string;
  let origin: string;
  let workdir: string;

  const git = (cwd: string, args: string[]) =>
    execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "provision-test-"));
    origin = path.join(root, "origin");
    workdir = path.join(root, "workdir");
    await fs.mkdir(origin, { recursive: true });

    await git(origin, ["init", "-q", "-b", "main"]);
    await git(origin, ["config", "user.email", "t@t"]);
    await git(origin, ["config", "user.name", "t"]);
    const write = async (content: string, msg: string) => {
      await fs.writeFile(path.join(origin, "app.txt"), content);
      await git(origin, ["add", "app.txt"]);
      await git(origin, ["commit", "-q", "-m", msg]);
    };
    await write("l1\nl2\n", "base1");
    await write("l1\nl2\nl3\n", "base2"); // merge-base
    await git(origin, ["checkout", "-q", "-b", "feature"]);
    await write("l1\nl2\nl3\nFEATURE\n", "feat1");
    await write("l1\nl2\nl3\nFEATURE\nMORE\n", "feat2"); // PR head
    // Advance main AFTER the branch point → base divergence (the hard case).
    await git(origin, ["checkout", "-q", "main"]);
    await write("l1\nl2\nl3\nMAINONLY\n", "base3");

    // Reproduce the daemon's shallow head-only clone.
    await execFileAsync(
      "git",
      [
        "clone",
        "-q",
        "--depth",
        "1",
        "--branch",
        "feature",
        `file://${origin}`,
        workdir,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("shallow head-only clone cannot diff the base (the pre-fix failure)", async () => {
    await expect(
      git(workdir, ["diff", "origin/main...HEAD"]),
    ).rejects.toThrow();
  });

  it("makes an offline, merge-base-accurate base diff possible", async () => {
    const ok = await ensureBaseDiffable({
      workdir,
      branch: "feature",
      baseBranch: "main",
      authConfigArgs: [], // local file remote needs no auth header
    });
    expect(ok).toBe(true);

    // Simulate the single-writer token strip: break the remote so no further fetch works.
    await git(workdir, [
      "remote",
      "set-url",
      "origin",
      "file:///nonexistent-after-strip",
    ]);

    const { stdout } = await git(workdir, [
      "diff",
      "--no-color",
      "origin/main...HEAD",
    ]);
    // Three-dot merge-base diff shows ONLY the PR's additions...
    expect(stdout).toContain("+FEATURE");
    expect(stdout).toContain("+MORE");
    // ...and NOT the base-only commit (the two-dot lie this fix avoids).
    expect(stdout).not.toContain("MAINONLY");
  });
});

describe("git failures never echo the auth header", () => {
  it("a failing git command throws the verb + stderr tail, with the extraHeader credential absent (hermetic: local path, no network)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "prov-redact-"));
    try {
      const token = "ghs_3211193_abcdefghijklmnopqrstuvwxyz";
      const authHeader = `AUTHORIZATION: basic ${Buffer.from(
        `x-access-token:${token}`,
      ).toString("base64")}`;
      // Exactly the argv shape provisionWorkdir builds, against a path that
      // does not exist — git fails locally, no network, no real token.
      await expect(
        gitExec([
          "-c",
          `http.extraHeader=${authHeader}`,
          "clone",
          "--depth",
          "1",
          path.join(root, "definitely-missing.git"),
          path.join(root, "out"),
        ]),
      ).rejects.toSatisfy((e: unknown) => {
        const msg = (e as Error).message;
        expect(msg).toMatch(/^git clone failed \(exit \d+\): /);
        expect(msg).toMatch(/does not exist|not found|No such file/i);
        expect(msg).not.toContain("basic ");
        expect(msg).not.toContain(token);
        expect(msg).not.toContain(
          Buffer.from(`x-access-token:${token}`).toString("base64"),
        );
        // NO reachable property may carry the raw argv: no `cause`, and the
        // full inspected form (what console.error would print) is clean too.
        expect((e as { cause?: unknown }).cause).toBeUndefined();
        const inspected = inspect(e, { depth: 10 });
        expect(inspected).not.toContain("basic ");
        expect(inspected).not.toContain(token);
        expect(inspected).not.toContain("extraHeader");
        return true;
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("provisionWorkdir — the run dir", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "provision-dir-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // card: protects=the run dir is private to the worker (0700, a pre-existing world-readable dir included) and provisioning runs the clone and nothing else (no host ACL, no run tmp dir); fails_when=the mode is wider than 0700, an extra command runs, or a tmp/ dir appears; no_claim=the container hand-over that opens it by search to the rootless daemon's group (container-daemon-process tests)
  it("is private (0700) and provisioning runs only the clone", async () => {
    const calls: string[] = [];
    await fs.mkdir(path.join(root, "thr_1"), { recursive: true, mode: 0o755 });
    await provisionWorkdir({
      repoFullName: "o/r",
      branch: "main",
      installationToken: "ghs_x",
      workdirRoot: root,
      runId: "thr_1",
      runGit: async (args: string[]) => {
        calls.push(`git:${args.find((a) => a === "clone") ?? "other"}`);
        return { stdout: "", stderr: "" };
      },
    });
    expect(calls).toEqual(["git:clone"]);
    expect((await fs.stat(path.join(root, "thr_1"))).mode & 0o777).toBe(0o700);
    await expect(fs.stat(path.join(root, "thr_1", "tmp"))).rejects.toThrow();
  });
});

describe("provisionWorkdir — a task run's work branch", () => {
  let root: string;
  let origin: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "provision-work-"));
    origin = path.join(root, "origin");
    await fs.mkdir(origin, { recursive: true });
    await originGit(["init", "-q", "-b", "main"]);
    await originGit(["config", "user.email", "t@t"]);
    await originGit(["config", "user.name", "t"]);
    await fs.writeFile(path.join(origin, "app.txt"), "hello\n");
    await originGit(["add", "app.txt"]);
    await originGit(["commit", "-q", "-m", "init"]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const originGit = (args: string[]) =>
    execFileAsync("git", ["-C", origin, ...args]);

  const localGit = (args: string[]) =>
    execFileAsync(
      "git",
      args.map((a) => (a.startsWith("https://github.com/") ? origin : a)),
      { maxBuffer: 16 * 1024 * 1024 },
    );

  const headOf = async (workdir: string) =>
    (
      await execFileAsync("git", [
        "-C",
        workdir,
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ])
    ).stdout.trim();

  const provision = async (runId: string, workBranch?: string) => {
    const run = await provisionWorkdir({
      repoFullName: "irrelevant/local",
      branch: "main",
      workBranch,
      installationToken: "unused",
      workdirRoot: path.join(root, "runs"),
      runId,
      runGit: localGit,
    });
    return run.repo;
  };

  it("checks the work branch out from the cloned base, so the agent never commits on it", async () => {
    const workdir = await provision("thr_work", "automata/task-abcdef12");
    expect(await headOf(workdir)).toBe("automata/task-abcdef12");
    await expect(
      fs.readFile(path.join(workdir, "app.txt"), "utf8"),
    ).resolves.toBe("hello\n");
  });

  it("continues the remote work branch an earlier run already pushed", async () => {
    await originGit(["checkout", "-q", "-b", "automata/task-abcdef12"]);
    await fs.writeFile(path.join(origin, "earlier.txt"), "first run\n");
    await originGit(["add", "earlier.txt"]);
    await originGit(["commit", "-q", "-m", "first run"]);
    await originGit(["checkout", "-q", "main"]);

    const workdir = await provision("thr_again", "automata/task-abcdef12");
    expect(await headOf(workdir)).toBe("automata/task-abcdef12");
    await expect(
      fs.readFile(path.join(workdir, "earlier.txt"), "utf8"),
    ).resolves.toBe("first run\n");
  });

  it("stays on the cloned branch without one", async () => {
    const workdir = await provision("thr_plain");
    expect(await headOf(workdir)).toBe("main");
  });
});

/**
 * Production, 2026-09-28: a review that had been working for five minutes was
 * redelivered by the engine; the new attempt tried to clear the previous
 * attempt's workdir while that attempt was still writing into it, and threw
 *
 *   ENOTEMPTY: directory not empty, rmdir '/usr/local/automata/runs/<id>'
 *
 * The run died with no verdict and reached the user as "Review intent could not
 * be parsed". `force: true` suppresses ENOENT and nothing else.
 */
describe("provisionWorkdir — a stale workdir is renamed, never removed in place", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "provision-tomb-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const noop = {
    runGit: async () => ({ stdout: "", stderr: "" }),
  };

  it("starts clean even when the previous attempt left a populated tree", async () => {
    const stale = path.join(root, "thr_1");
    await fs.mkdir(path.join(stale, "deep", "nested"), { recursive: true });
    await fs.writeFile(path.join(stale, "deep", "nested", "leftover"), "x");

    const run = await provisionWorkdir({
      repoFullName: "o/r",
      branch: "main",
      installationToken: "ghs_x",
      workdirRoot: root,
      runId: "thr_1",
      ...noop,
    });

    expect(run.runDir).toBe(stale);
    // The residue must not be visible to the new run under the real path.
    await expect(
      fs.stat(path.join(stale, "deep", "nested", "leftover")),
    ).rejects.toThrow();
  });

  it("leaves no tombstone behind on the happy path", async () => {
    await fs.mkdir(path.join(root, "thr_1"), { recursive: true });
    await fs.writeFile(path.join(root, "thr_1", "f"), "x");
    await provisionWorkdir({
      repoFullName: "o/r",
      branch: "main",
      installationToken: "ghs_x",
      workdirRoot: root,
      runId: "thr_1",
      ...noop,
    });
    const entries = await fs.readdir(root);
    expect(entries.filter((e) => e.includes(".tombstone-"))).toEqual([]);
  });

  it("sweeps a tombstone an earlier run could not free", async () => {
    // A live escapee holding the tree is exactly what leaves one behind. The
    // next run must clear it rather than accumulating residue forever.
    const orphan = path.join(root, `thr_0.tombstone-${Date.now() - 1000}`);
    await fs.mkdir(path.join(orphan, "sub"), { recursive: true });
    await fs.writeFile(path.join(orphan, "sub", "f"), "x");

    await provisionWorkdir({
      repoFullName: "o/r",
      branch: "main",
      installationToken: "ghs_x",
      workdirRoot: root,
      runId: "thr_2",
      ...noop,
    });

    await expect(fs.stat(orphan)).rejects.toThrow();
  });

  it("succeeds when the stale tree CANNOT be emptied — the case that broke production", async () => {
    // Deterministic stand-in for the redelivery race. In production the tree
    // could not be emptied because the previous attempt's agent was still
    // writing into it. Here an INNER directory is made unwritable, so unlinking
    // its child fails — a recursive remove cannot empty the tree — while the
    // outer directory stays writable, so it can still be renamed out of the way.
    //
    // This is the test that separates the fix from its predecessor: the old
    // `fs.rm(workdir, { recursive: true, force: true })` throws here and fails
    // the run. `force: true` only ever suppressed ENOENT.
    const stale = path.join(root, "thr_locked");
    const locked = path.join(stale, "locked");
    await fs.mkdir(locked, { recursive: true });
    await fs.writeFile(path.join(locked, "held"), "x");
    await fs.chmod(locked, 0o500); // r-x: its child cannot be unlinked

    try {
      // Sanity: the operation the old code performed really does fail here.
      await expect(
        fs.rm(stale, { recursive: true, force: true }),
      ).rejects.toThrow();

      const run = await provisionWorkdir({
        repoFullName: "o/r",
        branch: "main",
        installationToken: "ghs_x",
        workdirRoot: root,
        runId: "thr_locked",
        ...noop,
      });
      expect(run.runDir).toBe(stale);
      // A fresh run dir — the residue went to a tombstone; only the (empty,
      // fake-cloned) repo dir is in it.
      expect(await fs.readdir(run.runDir)).toEqual(["repo"]);
      expect(await fs.readdir(run.repo)).toEqual([]);
    } finally {
      for (const e of await fs.readdir(root).catch(() => [])) {
        await fs.chmod(path.join(root, e, "locked"), 0o700).catch(() => {});
      }
    }
  });

  it("provisions normally when there is no residue at all", async () => {
    const run = await provisionWorkdir({
      repoFullName: "o/r",
      branch: "main",
      installationToken: "ghs_x",
      workdirRoot: root,
      runId: "thr_3",
      ...noop,
    });
    expect(run.runDir).toBe(path.join(root, "thr_3"));
    expect(run.repo).toBe(path.join(root, "thr_3", "repo"));
    await expect(fs.stat(run.repo)).resolves.toBeTruthy();
  });
});

describe("provisionWorkdir — run-owned dirs sit outside the checkout (#302)", () => {
  let root: string;
  let origin: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "provision-exclude-"));
    origin = path.join(root, "origin");
    await fs.mkdir(origin, { recursive: true });
    const git = (args: string[]) =>
      execFileAsync("git", ["-C", origin, ...args]);
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "t@t"]);
    await git(["config", "user.name", "t"]);
    await fs.writeFile(path.join(origin, "app.txt"), "hello\n");
    await git(["add", "app.txt"]);
    await git(["commit", "-q", "-m", "init"]);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([["a real local clone"]])(
    "%s: home/, gh-config/ and tmp/ are not in the clone at all",
    async () => {
      const run = await provisionWorkdir({
        repoFullName: "irrelevant/local",
        branch: "main",
        installationToken: "unused",
        workdirRoot: path.join(root, "runs"),
        runId: "thr_x",
        runGit: (args) =>
          execFileAsync(
            "git",
            args.map((a) => (a.startsWith("https://github.com/") ? origin : a)),
          ),
      });
      // What the worker creates after provisioning (HOME, gh-config) plus tmp.
      for (const dir of [run.home, run.ghConfig, run.tmp]) {
        await fs.mkdir(path.join(dir, ".claude"), { recursive: true });
        await fs.writeFile(path.join(dir, ".claude", "f"), "x");
      }
      const { stdout } = await execFileAsync("git", [
        "-C",
        run.repo,
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored",
      ]);
      // Not even as ignored entries: a tool that walks `.` (eslint, a test
      // runner) cannot reach them, whatever it thinks of git's ignore rules.
      expect(stdout).toBe("");
      for (const name of ["home", "gh-config", "tmp"]) {
        await expect(fs.stat(path.join(run.repo, name))).rejects.toThrow();
      }
    },
  );
});
