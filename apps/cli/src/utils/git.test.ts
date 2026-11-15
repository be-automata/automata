import { existsSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertSafeBranchName,
  InvalidBranchNameError,
  localBranchExists,
  runGit,
} from "./git";

describe("assertSafeBranchName", () => {
  it.each(["main", "feature/x", "terragon/abc-123", "release-1.2.3"])(
    "accepts %s",
    async (name) => {
      await expect(assertSafeBranchName(name)).resolves.toBeUndefined();
    },
  );

  it.each([
    "",
    "a;b",
    "a$(b)",
    "a`b`",
    "a b",
    "-x",
    "--force",
    "a..b",
    "a@{1}",
  ])("rejects %j", async (name) => {
    await expect(assertSafeBranchName(name)).rejects.toBeInstanceOf(
      InvalidBranchNameError,
    );
  });
});

describe("assertSafeBranchName when git cannot be spawned", () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("rethrows the spawn error instead of reporting an invalid name", async () => {
    process.env.PATH = "";
    const err = await assertSafeBranchName("feature/x").catch((e) => e);
    expect(err).not.toBeInstanceOf(InvalidBranchNameError);
    expect((err as { code?: unknown }).code).toBe("ENOENT");
  });
});

describe("runGit", () => {
  let dir: string;
  let marker: string;

  beforeEach(async () => {
    // Keep the host's git config (signing, hooks, templates) out of the temp repo.
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    dir = mkdtempSync(join(tmpdir(), "cli-git-test-"));
    marker = join(dir, "marker");
    await runGit(["init", "-q"], { cwd: dir });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes each argument to git verbatim as a single argument", async () => {
    const name = `x;touch ${marker};$(touch ${marker})\`touch ${marker}\``;
    await runGit(["config", "--local", "test.value", name], { cwd: dir });
    const { stdout } = await runGit(["config", "--get", "test.value"], {
      cwd: dir,
    });
    expect(stdout.trim()).toBe(name);
    expect(existsSync(marker)).toBe(false);
  });

  it("surfaces git failures without running anything else", async () => {
    const name = `missing$(touch ${marker})`;
    await expect(
      runGit(["rev-parse", "--verify", "--end-of-options", name], { cwd: dir }),
    ).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  it("reports only local branches as existing", async () => {
    await runGit(
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      ],
      { cwd: dir },
    );
    await runGit(["tag", "foo"], { cwd: dir });
    await expect(localBranchExists("foo", { cwd: dir })).resolves.toBe(false);
    await runGit(["branch", "bar"], { cwd: dir });
    await expect(localBranchExists("bar", { cwd: dir })).resolves.toBe(true);
  });

  it("runs in the given working directory", async () => {
    const { stdout } = await runGit(["rev-parse", "--show-toplevel"], {
      cwd: dir,
    });
    expect(stdout.trim()).toBe(realpathSync(dir));
  });
});
