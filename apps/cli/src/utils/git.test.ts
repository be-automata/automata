import { existsSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeBranchName, InvalidBranchNameError, runGit } from "./git";

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

describe("runGit", () => {
  let dir: string;
  let marker: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cli-git-test-"));
    marker = join(dir, "marker");
    await runGit(["init", "-q"], { cwd: dir });
  });

  afterEach(() => {
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

  it("runs in the given working directory", async () => {
    const { stdout } = await runGit(["rev-parse", "--show-toplevel"], {
      cwd: dir,
    });
    expect(stdout.trim()).toBe(realpathSync(dir));
  });
});
