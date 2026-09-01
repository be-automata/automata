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
        aceExec: r.aceExec,
        runGit: r.runGit,
      });
      expect(r.calls).toEqual([
        "ace:_automata-agent allow search",
        `ace:_automata-agent allow ${INHERITABLE_ACE_RIGHTS}`,
        "git:clone",
      ]);
      // The run's own TMPDIR exists and inherits the grant.
      expect(
        (await fs.stat(path.join(root, "thr_1", "tmp"))).isDirectory(),
      ).toBe(true);
    },
  );
});
