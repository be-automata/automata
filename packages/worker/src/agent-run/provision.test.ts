import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureBaseDiffable } from "./provision";

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
