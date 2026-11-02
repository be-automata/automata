import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Test helper: a local source repo driven by the real git binary. No network. */
const FIXTURE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: FIXTURE_ENV,
    encoding: "utf8",
  }).trim();
}

export interface SourceRepo {
  dir: string;
  url: string;
  commit(file: string, text: string, message?: string): string;
  symlink(link: string, target: string): string;
  branch(name: string): void;
  /** Drop the last commit and add a different one: a non-fast-forward rewrite. */
  rewriteHead(file: string, text: string): string;
  head(): string;
  cleanup(): void;
}

export function createSourceRepo(): SourceRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-src-"));
  git(dir, "init", "-q", "-b", "main");
  const repo: SourceRepo = {
    dir,
    url: `file://${dir}`,
    commit(file, text, message = `edit ${file}`) {
      const full = path.join(dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
      git(dir, "add", "--", file);
      git(dir, "commit", "-q", "-m", message);
      return git(dir, "rev-parse", "HEAD");
    },
    symlink(link, target) {
      fs.symlinkSync(target, path.join(dir, link));
      git(dir, "add", "--", link);
      git(dir, "commit", "-q", "-m", `link ${link}`);
      return git(dir, "rev-parse", "HEAD");
    },
    branch(name) {
      git(dir, "branch", name);
    },
    rewriteHead(file, text) {
      git(dir, "reset", "-q", "--hard", "HEAD~1");
      return repo.commit(file, text, "rewritten");
    },
    head() {
      return git(dir, "rev-parse", "HEAD");
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return repo;
}
