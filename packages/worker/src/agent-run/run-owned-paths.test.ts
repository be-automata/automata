import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { excludeRunOwnedPaths, RUN_OWNED_DIRS } from "./run-owned-paths";

const execFileAsync = promisify(execFile);

/**
 * Production: a task agent ran `git status` in its checkout and reported
 * `home/` and `gh-config/` as untracked — the worker's own per-run dirs, which
 * live INSIDE the clone. A `git add -A` would have committed them, and the run
 * HOME carries the delivered model credential.
 */
describe("excludeRunOwnedPaths", () => {
  let root: string;
  let repo: string;

  const git = (cwd: string, args: string[]) =>
    execFileAsync("git", ["-C", cwd, ...args]);

  async function populateRunOwnedDirs(dir: string): Promise<void> {
    for (const name of RUN_OWNED_DIRS) {
      await fs.mkdir(path.join(dir, name, "nested"), { recursive: true });
      await fs.writeFile(path.join(dir, name, "nested", "f"), "x");
    }
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "run-owned-"));
    repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "t@t"]);
    await git(repo, ["config", "user.name", "t"]);
    await fs.writeFile(path.join(repo, "app.txt"), "hello\n");
    await git(repo, ["add", "app.txt"]);
    await git(repo, ["commit", "-q", "-m", "init"]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("covers every dir the worker creates inside the checkout", () => {
    expect([...RUN_OWNED_DIRS].sort()).toEqual(["gh-config", "home", "tmp"]);
  });

  it("hides the run-owned dirs from git status and git add -A", async () => {
    await populateRunOwnedDirs(repo);
    // Sanity: without the exclude they ARE untracked — the production report.
    const before = await git(repo, ["status", "--porcelain"]);
    expect(before.stdout).toContain("home/");

    await excludeRunOwnedPaths(repo);

    const after = await git(repo, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    expect(after.stdout).toBe("");
    await git(repo, ["add", "-A"]);
    const staged = await git(repo, ["diff", "--cached", "--name-only"]);
    expect(staged.stdout).toBe("");
  });

  it("anchors to the repo root — a nested dir of the same name stays visible", async () => {
    await excludeRunOwnedPaths(repo);
    await fs.mkdir(path.join(repo, "src", "tmp"), { recursive: true });
    await fs.writeFile(path.join(repo, "src", "tmp", "keep.ts"), "x");
    const { stdout } = await git(repo, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    expect(stdout).toContain("src/tmp/keep.ts");
  });

  it("is idempotent and preserves existing content (no trailing newline)", async () => {
    const exclude = path.join(repo, ".git", "info", "exclude");
    await fs.mkdir(path.dirname(exclude), { recursive: true });
    await fs.writeFile(exclude, "# mine\n*.log");

    await excludeRunOwnedPaths(repo);
    await excludeRunOwnedPaths(repo);

    const content = await fs.readFile(exclude, "utf8");
    const lines = content.split("\n");
    expect(lines.slice(0, 2)).toEqual(["# mine", "*.log"]);
    for (const name of RUN_OWNED_DIRS) {
      expect(lines.filter((l) => l === `/${name}/`)).toHaveLength(1);
    }
    expect(content.endsWith("\n")).toBe(true);
    // the user's own pattern still works
    await fs.writeFile(path.join(repo, "x.log"), "x");
    const { stdout } = await git(repo, ["status", "--porcelain"]);
    expect(stdout).not.toContain("x.log");
  });

  it("creates info/ when the clone has none (no git templates)", async () => {
    await fs.rm(path.join(repo, ".git", "info"), {
      recursive: true,
      force: true,
    });
    await populateRunOwnedDirs(repo);
    await excludeRunOwnedPaths(repo);
    const { stdout } = await git(repo, ["status", "--porcelain"]);
    expect(stdout).toBe("");
  });

  it("follows a .git FILE (linked worktree) to the common dir's exclude", async () => {
    const linked = path.join(root, "linked");
    await git(repo, ["worktree", "add", "-q", "-b", "wt", linked]);
    expect((await fs.stat(path.join(linked, ".git"))).isFile()).toBe(true);
    await populateRunOwnedDirs(linked);

    await excludeRunOwnedPaths(linked);

    const { stdout } = await git(linked, ["status", "--porcelain"]);
    expect(stdout).toBe("");
  });

  it("is a no-op when there is no .git at all (nothing can be committed)", async () => {
    const bare = path.join(root, "not-a-repo");
    await fs.mkdir(bare);
    await excludeRunOwnedPaths(bare);
    expect(await fs.readdir(bare)).toEqual([]);
  });
});
