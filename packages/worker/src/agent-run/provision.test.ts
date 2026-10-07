import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect, promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INHERITABLE_ACE_RIGHTS } from "./agent-uid-fs";
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

/**
 * #108: the per-run ACE must be applied BEFORE the clone. macOS applies ACL
 * inheritance at create time, so anything cloned first would not carry the
 * grant — this is a correctness constraint, asserted as call ordering.
 */
describe("provisionWorkdir — agent-uid ACEs", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "provision-ace-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function recorder() {
    const calls: string[] = [];
    return {
      calls,
      aceExec: async (_file: string, args: string[]) => {
        calls.push(`ace:${args[1]}`);
      },
      runGit: async (args: string[]) => {
        calls.push(`git:${args.find((a) => a === "clone") ?? "other"}`);
        return { stdout: "", stderr: "" };
      },
    };
  }

  it("touches no ACLs at all when agentUser is empty (default-off proof)", async () => {
    const r = recorder();
    await provisionWorkdir({
      repoFullName: "o/r",
      branch: "main",
      installationToken: "ghs_x",
      workdirRoot: root,
      runId: "thr_1",
      aceExec: r.aceExec,
      runGit: r.runGit,
    });
    expect(r.calls).toEqual(["git:clone"]);
    // and no run tmp dir is created either
    await expect(fs.stat(path.join(root, "thr_1", "tmp"))).rejects.toThrow();
  });

  it.skipIf(process.platform !== "darwin")(
    "applies the shared-root traverse ACE and the per-run ACE BEFORE the clone",
    async () => {
      const r = recorder();
      await provisionWorkdir({
        repoFullName: "o/r",
        branch: "main",
        installationToken: "ghs_x",
        workdirRoot: root,
        runId: "thr_1",
        agentUser: "_automata-agent",
        // pinned so the assertion does not depend on whose machine runs the suite
        workerLogin: "the-operator",
        aceExec: r.aceExec,
        runGit: r.runGit,
      });
      // Shared root: traverse ONLY, agent only — an inheritable ACE there would
      // expose every other run. Per-run dir: inheritable, for BOTH the agent and
      // the worker, the latter so cleanup can delete agent-created files.
      // All of it BEFORE the clone (macOS inherits at create time).
      expect(r.calls).toEqual([
        "ace:_automata-agent allow search",
        `ace:_automata-agent allow ${INHERITABLE_ACE_RIGHTS}`,
        `ace:the-operator allow ${INHERITABLE_ACE_RIGHTS}`,
        "git:clone",
      ]);
      // The run's own TMPDIR exists and inherits the grant.
      expect(
        (await fs.stat(path.join(root, "thr_1", "tmp"))).isDirectory(),
      ).toBe(true);
    },
  );
});

/**
 * The regression that broke every agent-uid run on the pilot box.
 *
 * provisionWorkdir has to apply the inheritable ACE BEFORE the clone (macOS
 * applies inheritance at create time). It used to also create the run's `tmp/`
 * there — and `git clone` REFUSES a destination that exists and is non-empty,
 * so provisioning died with "destination path ... already exists and is not an
 * empty directory" on every run with WORKER_AGENT_USER set.
 *
 * CI could not catch it: the ACE tests inject a fake `runGit`, so the real
 * emptiness rule was never exercised. This one runs a REAL `git clone` against
 * a local remote with agentUser set, and a fake aceExec so it stays pure and
 * runs on Linux.
 */
describe("provisionWorkdir — a real clone with agentUser set", () => {
  let root: string;
  let origin: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "provision-clone-"));
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

  it("clones successfully — the run's tmp/ must not pre-empty the destination", async () => {
    const aceCalls: string[][] = [];
    const workdir = await provisionWorkdir({
      repoFullName: "irrelevant/local",
      branch: "main",
      installationToken: "unused-for-a-local-remote",
      workdirRoot: path.join(root, "runs"),
      runId: "thr_clone",
      agentUser: "_automata-agent",
      aceExec: async (file, args) => {
        aceCalls.push([file, ...args]);
      },
      // local remote: no auth header, no github.com
      runGit: (args) =>
        execFileAsync(
          "git",
          args.map((a) => (a.startsWith("https://github.com/") ? origin : a)),
          { maxBuffer: 16 * 1024 * 1024 },
        ),
    });

    // the clone actually produced a working tree
    await expect(
      fs.readFile(path.join(workdir, "app.txt"), "utf8"),
    ).resolves.toBe("hello\n");
    // ...and the run's TMPDIR still exists afterwards
    const tmpStat = await fs.stat(path.join(workdir, "tmp"));
    expect(tmpStat.isDirectory()).toBe(true);
    // The ACE assertions are darwin-only: applyAces is a hard no-op elsewhere
    // (agent-uid-fs.ts) and provisionWorkdir passes no platform override, so
    // aceCalls stays empty on Linux. The CLONE behaviour above is the point of
    // this test and is platform-independent, so the test itself must stay
    // cross-platform — only these two lines are gated.
    if (process.platform === "darwin") {
      expect(aceCalls.length).toBeGreaterThanOrEqual(2);
      expect(aceCalls.every((c) => c[0] === "/bin/chmod")).toBe(true);
    }
  });
});

describe("provisionWorkdir — a task run's work branch", () => {
  let root: string;
  let origin: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "provision-work-"));
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

  it("checks the work branch out from the cloned base, so the agent never commits on it", async () => {
    const workdir = await provisionWorkdir({
      repoFullName: "irrelevant/local",
      branch: "main",
      workBranch: "automata/task-abcdef12",
      installationToken: "unused",
      workdirRoot: path.join(root, "runs"),
      runId: "thr_work",
      runGit: localGit,
    });
    expect(await headOf(workdir)).toBe("automata/task-abcdef12");
    await expect(
      fs.readFile(path.join(workdir, "app.txt"), "utf8"),
    ).resolves.toBe("hello\n");
  });

  it("continues the remote work branch an earlier run already pushed", async () => {
    const git = (args: string[]) =>
      execFileAsync("git", ["-C", origin, ...args]);
    await git(["checkout", "-q", "-b", "automata/task-abcdef12"]);
    await fs.writeFile(path.join(origin, "earlier.txt"), "first run\n");
    await git(["add", "earlier.txt"]);
    await git(["commit", "-q", "-m", "first run"]);
    await git(["checkout", "-q", "main"]);

    const workdir = await provisionWorkdir({
      repoFullName: "irrelevant/local",
      branch: "main",
      workBranch: "automata/task-abcdef12",
      installationToken: "unused",
      workdirRoot: path.join(root, "runs"),
      runId: "thr_again",
      runGit: localGit,
    });
    expect(await headOf(workdir)).toBe("automata/task-abcdef12");
    await expect(
      fs.readFile(path.join(workdir, "earlier.txt"), "utf8"),
    ).resolves.toBe("first run\n");
  });

  it("stays on the cloned branch without one", async () => {
    const workdir = await provisionWorkdir({
      repoFullName: "irrelevant/local",
      branch: "main",
      installationToken: "unused",
      workdirRoot: path.join(root, "runs"),
      runId: "thr_plain",
      runGit: localGit,
    });
    expect(await headOf(workdir)).toBe("main");
  });
});

/**
 * The run's workdir must grant the ACE to BOTH the agent and the worker's own
 * login. With the agent alone, every directory the agent creates inside the run
 * is agent-owned, deleting a file needs write on its containing directory, and
 * cleanupWorkdir (uid 501) fails with EACCES — leaving the run's HOME, and any
 * credential delivered into it, on disk after the run. Observed on the pilot
 * box before this was fixed.
 */
describe("provisionWorkdir — the workdir ACE must include the worker login", () => {
  it.skipIf(process.platform !== "darwin")(
    "grants BOTH the agent user and the worker login, inheritably",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "provision-ace-"));
      const calls: string[][] = [];
      await provisionWorkdir({
        repoFullName: "o/r",
        branch: "main",
        installationToken: "t",
        workdirRoot: path.join(root, "runs"),
        runId: "thr_ace",
        agentUser: "_automata-agent",
        workerLogin: "the-operator",
        aceExec: async (file, args) => {
          calls.push([file, ...args]);
        },
        runGit: async () => ({ stdout: "", stderr: "" }),
      });
      const inheritable = calls.filter((c) =>
        c.some((a) => a.includes("file_inherit")),
      );
      const granted = inheritable.map(
        (c) => c.find((a) => a.includes("allow"))?.split(" ")[0] ?? "",
      );
      expect(granted).toContain("_automata-agent");
      expect(granted).toContain("the-operator");
      await fs.rm(root, { recursive: true, force: true });
    },
  );
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
    aceExec: async () => {},
    runGit: async () => ({ stdout: "", stderr: "" }),
  };

  it("starts clean even when the previous attempt left a populated tree", async () => {
    const stale = path.join(root, "thr_1");
    await fs.mkdir(path.join(stale, "deep", "nested"), { recursive: true });
    await fs.writeFile(path.join(stale, "deep", "nested", "leftover"), "x");

    const workdir = await provisionWorkdir({
      repoFullName: "o/r",
      branch: "main",
      installationToken: "ghs_x",
      workdirRoot: root,
      runId: "thr_1",
      ...noop,
    });

    expect(workdir).toBe(stale);
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

      const workdir = await provisionWorkdir({
        repoFullName: "o/r",
        branch: "main",
        installationToken: "ghs_x",
        workdirRoot: root,
        runId: "thr_locked",
        ...noop,
      });
      expect(workdir).toBe(stale);
      // A fresh, empty directory — the residue went to a tombstone.
      expect(await fs.readdir(workdir)).toEqual([]);
    } finally {
      for (const e of await fs.readdir(root).catch(() => [])) {
        await fs.chmod(path.join(root, e, "locked"), 0o700).catch(() => {});
      }
    }
  });

  it("provisions normally when there is no residue at all", async () => {
    const workdir = await provisionWorkdir({
      repoFullName: "o/r",
      branch: "main",
      installationToken: "ghs_x",
      workdirRoot: root,
      runId: "thr_3",
      ...noop,
    });
    expect(workdir).toBe(path.join(root, "thr_3"));
    await expect(fs.stat(workdir)).resolves.toBeTruthy();
  });
});

/**
 * LINUX ACL MASK TRAP on the run's TMPDIR. `<workdir>/tmp` is created 0700, and
 * on Linux a 0700 creation mode zeroes the POSIX ACL mask — the grant inherited
 * from the workdir's default ACL is born `#effective:---`, so the agent cannot
 * use its own TMPDIR. The run HOME and gh-config re-grant after mkdir for the
 * same reason; tmp never did.
 */
describe("provisionWorkdir — the run TMPDIR is re-granted on Linux", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "provision-tmp-grant-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function provisionOn(
    platform: NodeJS.Platform,
    agentUser: string,
  ): Promise<{ calls: string[][]; workdir: string }> {
    const calls: string[][] = [];
    const workdir = await provisionWorkdir({
      repoFullName: "o/r",
      branch: "main",
      installationToken: "t",
      workdirRoot: root,
      runId: "thr_tmp",
      agentUser,
      workerLogin: "the-operator",
      platform,
      aceExec: async (file, args) => {
        calls.push([file, ...args]);
      },
      runGit: async (args) => {
        calls.push(["git", args.includes("clone") ? "clone" : "other"]);
        return { stdout: "", stderr: "" };
      },
    });
    return { calls, workdir };
  }

  it("restores the agent's access entry on tmp AFTER creating it", async () => {
    const { calls, workdir } = await provisionOn("linux", "automata-agent");
    const tmp = path.join(workdir, "tmp");
    const regrant = calls.findIndex(
      (c) =>
        c[0] === "/usr/bin/setfacl" &&
        c[1] === "-m" &&
        c[2] === "u:automata-agent:rwx" &&
        c[3] === tmp,
    );
    expect(regrant).toBeGreaterThan(calls.findIndex((c) => c[0] === "git"));
    expect((await fs.stat(tmp)).isDirectory()).toBe(true);
  });

  it("no re-grant on macOS (the inherited ACE survives the mode)", async () => {
    const { calls, workdir } = await provisionOn("darwin", "automata-agent");
    const tmp = path.join(workdir, "tmp");
    expect(calls.some((c) => c.includes(tmp))).toBe(false);
  });

  it("no ACL call at all when agentUser is empty", async () => {
    const { calls } = await provisionOn("linux", "");
    expect(calls).toEqual([["git", "clone"]]);
  });
});

describe("provisionWorkdir — run-owned dirs are excluded from git", () => {
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

  it.each([
    ["default mode", ""],
    ["agent-uid mode", "_automata-agent"],
  ])(
    "%s: home/, gh-config/ and tmp/ never show as untracked",
    async (_label, agentUser) => {
      const workdir = await provisionWorkdir({
        repoFullName: "irrelevant/local",
        branch: "main",
        installationToken: "unused",
        workdirRoot: path.join(root, "runs"),
        runId: "thr_x",
        agentUser,
        // Pinned off-Linux/off-macOS: this test is about git, not ACLs.
        platform: "freebsd",
        aceExec: async () => {},
        runGit: (args) =>
          execFileAsync(
            "git",
            args.map((a) => (a.startsWith("https://github.com/") ? origin : a)),
          ),
      });
      // What the worker creates after provisioning (HOME, gh-config) plus tmp.
      for (const name of ["home", "gh-config", "tmp"]) {
        await fs.mkdir(path.join(workdir, name, ".claude"), {
          recursive: true,
        });
        await fs.writeFile(path.join(workdir, name, ".claude", "f"), "x");
      }
      const { stdout } = await execFileAsync("git", [
        "-C",
        workdir,
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      expect(stdout).toBe("");
    },
  );
});
