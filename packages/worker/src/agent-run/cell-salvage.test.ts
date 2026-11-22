import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CellExecOptions, ICellProvider } from "@terragon/types/cell";

import {
  CELL_FREEZE_ARGV,
  CELL_SALVAGE_BUDGET_MS,
  freezeCellAgent,
  salvageCellWorkBranch,
} from "./cell-salvage";

/**
 * Phase 7a of #743 against REAL git: a temp checkout stands in for /workspace
 * and a bare repo for the broker's upstream. The fake provider runs each exec
 * argv for real (`/usr/bin/env ... /bin/sh -c`), so the scripts, the env pairs
 * and the push are the production ones; only the transport is a file path.
 */

const BRANCH = "automata/task-123";
const LIMIT_MS = 30 * 60_000;
const SALVAGE_MESSAGE = "wip: run timed out at 30m (automata salvage)";
const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Agent",
  GIT_AUTHOR_EMAIL: "agent@example.com",
  GIT_COMMITTER_NAME: "Agent",
  GIT_COMMITTER_EMAIL: "agent@example.com",
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

interface ExecCall {
  argv: string[];
  opts: CellExecOptions | undefined;
}

let root: string;
let bare: string;
let work: string;
let calls: ExecCall[];

/** Runs argv for real in `work`, recording every call. */
function localExec(
  override?: (argv: string[]) => { exitCode: number; stdout: string } | null,
): ICellProvider["exec"] {
  return async (_cellId, argv, opts) => {
    calls.push({ argv, opts });
    const fake = override?.(argv);
    if (fake) return { ...fake, stderr: "" };
    return await new Promise((resolve, reject) => {
      const child = spawn(argv[0] as string, argv.slice(1), {
        cwd: work,
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({ exitCode: code ?? -1, stdout, stderr: "" }),
      );
    });
  };
}

const providerOf = (exec: ICellProvider["exec"]): ICellProvider =>
  ({ exec }) as unknown as ICellProvider;

function args(
  exec: ICellProvider["exec"],
  over: Partial<Parameters<typeof salvageCellWorkBranch>[0]> = {},
) {
  const log = vi.fn();
  return {
    log,
    input: {
      provider: providerOf(exec),
      cellId: "cell-1",
      workBranch: BRANCH,
      brokerGitUrl: bare,
      botLogin: "automata-ai-bot[bot]",
      runExecutionTimeoutMs: LIMIT_MS,
      log,
      ...over,
    },
  };
}

const pushCalls = () =>
  calls.filter((c) => c.argv.some((a) => a.includes("git push")));

beforeEach(() => {
  calls = [];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cell-salvage-"));
  bare = path.join(root, "remote.git");
  work = path.join(root, "work");
  git(root, "init", "--bare", "--initial-branch=main", bare);
  git(root, "clone", "--quiet", bare, work);
  git(work, "checkout", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(work, "README.md"), "base\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "base");
  git(work, "push", "--quiet", "origin", "main");
  git(work, "checkout", "--quiet", "-b", BRANCH);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("salvageCellWorkBranch (#743 phase 7a)", () => {
  it("commits a dirty tree and pushes HEAD to the run's own ref", async () => {
    fs.writeFileSync(path.join(work, "wip.txt"), "work\n");
    const { input, log } = args(localExec());

    const result = await salvageCellWorkBranch(input);

    const head = git(work, "rev-parse", "HEAD").trim();
    expect(result).toEqual({ branch: BRANCH, sha: head });
    expect(git(work, "log", "-1", "--format=%s")).toBe(`${SALVAGE_MESSAGE}\n`);
    expect(git(bare, "rev-parse", `refs/heads/${BRANCH}`).trim()).toBe(head);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      `salvage: pushed ${head.slice(0, 8)} to ${BRANCH}`,
    );
  });

  it("runs the steps in order, each as env + sh -c in /workspace", async () => {
    fs.writeFileSync(path.join(work, "wip.txt"), "work\n");
    const { input } = args(localExec());

    await salvageCellWorkBranch(input);

    for (const c of calls) {
      expect(c.argv.slice(0, 1)).toEqual(["/usr/bin/env"]);
      expect(c.argv).toContain("/bin/sh");
      expect(c.opts?.cwd).toBe("/workspace");
      // Pairs only: no bearer, no token in the argv.
      expect(c.argv.join(" ")).not.toMatch(/bearer|token/i);
    }
    const scripts = calls.map(
      (c) => c.argv[c.argv.indexOf("-c") + 1] as string,
    );
    const at = (needle: string) => scripts.findIndex((s) => s.includes(needle));
    expect(at("check-ref-format")).toBeGreaterThan(-1);
    expect(at("add -A")).toBeLessThan(at("diff --cached"));
    expect(at("diff --cached")).toBeLessThan(at("commit"));
    expect(at("commit")).toBeLessThan(at("rev-list"));
    expect(at("rev-list")).toBeLessThan(at("git push"));
    expect(at("git push")).toBe(scripts.length - 1);
    const env = calls[0]?.argv.slice(1, calls[0].argv.indexOf("/bin/sh"));
    expect(env).toContain("GIT_AUTHOR_NAME=automata-ai-bot[bot]");
    expect(env).toContain("HOME=/dev/null");
  });

  it("names the effective budget in the commit message", async () => {
    fs.writeFileSync(path.join(work, "wip.txt"), "work\n");
    const { input } = args(localExec(), { runExecutionTimeoutMs: 45 * 60_000 });
    await salvageCellWorkBranch(input);
    expect(git(work, "log", "-1", "--format=%s")).toBe(
      "wip: run timed out at 45m (automata salvage)\n",
    );
  });

  it("pushes only HEAD:refs/heads/<the run's ref>, to the broker URL", async () => {
    fs.writeFileSync(path.join(work, "wip.txt"), "work\n");
    const { input } = args(localExec());

    await salvageCellWorkBranch(input);

    const pushes = pushCalls();
    expect(pushes).toHaveLength(1);
    const argv = (pushes[0] as ExecCall).argv;
    const script = argv[argv.indexOf("-c") + 1] as string;
    expect(script).toContain('-- "$1" "HEAD:refs/heads/$2"');
    expect(script).not.toMatch(/--force|--all|--mirror|--tags|\+/);
    expect(argv.slice(argv.indexOf("sh") + 1)).toEqual([bare, BRANCH]);
    expect(git(bare, "branch", "--list").replace(/[* ]/g, "")).toBe(
      `${BRANCH}\nmain\n`,
    );
  });

  it("excludes a secret file name: nothing is pushed", async () => {
    fs.writeFileSync(path.join(work, ".env"), "TOKEN=1\n");
    fs.writeFileSync(path.join(work, "wip.txt"), "work\n");
    const { input, log } = args(localExec());

    expect(await salvageCellWorkBranch(input)).toBeNull();

    expect(log).toHaveBeenCalledWith("salvage: skipped (possible secret file)");
    expect(pushCalls()).toHaveLength(0);
    expect(() => git(bare, "rev-parse", `refs/heads/${BRANCH}`)).toThrow();
  });

  it("allows a placeholder .env.example", async () => {
    fs.writeFileSync(path.join(work, ".env.example"), "TOKEN=\n");
    const { input } = args(localExec());
    expect(await salvageCellWorkBranch(input)).not.toBeNull();
  });

  it("with nothing to commit, pushes nothing and logs nothing to push", async () => {
    const { input, log } = args(localExec());

    expect(await salvageCellWorkBranch(input)).toBeNull();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("salvage: nothing to push");
    expect(pushCalls()).toHaveLength(0);
    expect(git(work, "log", "-1", "--format=%s")).toBe("base\n");
  });

  it("a broker 429 is fail-open: failed (push failed), no throw", async () => {
    fs.writeFileSync(path.join(work, "wip.txt"), "work\n");
    const exec = localExec((argv) =>
      argv.some((a) => a.includes("git push"))
        ? { exitCode: 1, stdout: "effect_budget_exhausted" }
        : null,
    );
    const { input, log } = args(exec);

    await expect(salvageCellWorkBranch(input)).resolves.toBeNull();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("salvage: failed (push failed)");
  });

  it("a push to an unreachable broker is failed (push failed)", async () => {
    fs.writeFileSync(path.join(work, "wip.txt"), "work\n");
    const { input, log } = args(localExec(), {
      brokerGitUrl: path.join(root, "missing.git"),
    });
    expect(await salvageCellWorkBranch(input)).toBeNull();
    expect(log).toHaveBeenCalledWith("salvage: failed (push failed)");
  });

  it("an exec that throws is failed, never thrown", async () => {
    const exec: ICellProvider["exec"] = async () => {
      throw new TypeError("secret-bearing text");
    };
    const { input, log } = args(exec);
    await expect(salvageCellWorkBranch(input)).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(
      "salvage: failed (runner threw (TypeError))",
    );
  });

  it("no work branch: skipped, no exec", async () => {
    const { input, log } = args(localExec(), { workBranch: undefined });
    expect(await salvageCellWorkBranch(input)).toBeNull();
    expect(log).toHaveBeenCalledWith("salvage: skipped (no work branch)");
    expect(calls).toHaveLength(0);
  });

  describe("the time bound", () => {
    it("is 10 s by default, inside phase 7b's 40 s capture budget", () => {
      expect(CELL_SALVAGE_BUDGET_MS).toBe(10_000);
    });

    it("ends the salvage when an exec never settles", async () => {
      const exec: ICellProvider["exec"] = () => new Promise(() => {});
      const { input, log } = args(exec, { budgetMs: 50 });
      const t0 = Date.now();

      await expect(salvageCellWorkBranch(input)).resolves.toBeNull();

      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(log).toHaveBeenCalledWith("salvage: failed (budget exceeded)");
    });

    it("hands each exec only the time left", async () => {
      fs.writeFileSync(path.join(work, "wip.txt"), "work\n");
      const { input } = args(localExec(), { budgetMs: 4_000 });
      await salvageCellWorkBranch(input);
      for (const c of calls) {
        expect(c.opts?.timeoutMs).toBeLessThanOrEqual(4_000);
        expect(c.opts?.timeoutMs).toBeGreaterThan(0);
      }
    });
  });
});

describe("freezeCellAgent", () => {
  it("signals process groups only, with SIGSTOP, and is true on exit 0", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const ok = await freezeCellAgent({
      provider: providerOf(exec),
      cellId: "cell-1",
    });
    expect(ok).toBe(true);
    expect(exec).toHaveBeenCalledWith("cell-1", [...CELL_FREEZE_ARGV], {
      timeoutMs: 3_000,
    });
    const script = CELL_FREEZE_ARGV[2] as string;
    expect(script).toContain('kill -STOP -- "-$g"');
    expect(script).toContain("[/]opt/automata/daemon.js");
    expect(script).not.toMatch(/kill -(9|KILL|TERM)/);
  });

  it("fails open: a nonzero exit, a throw or a hang is false", async () => {
    const nonzero = vi.fn(async () => ({
      exitCode: 3,
      stdout: "",
      stderr: "",
    }));
    expect(
      await freezeCellAgent({ provider: providerOf(nonzero), cellId: "c" }),
    ).toBe(false);
    const thrown = vi.fn(async () => {
      throw new Error("gone");
    });
    expect(
      await freezeCellAgent({ provider: providerOf(thrown), cellId: "c" }),
    ).toBe(false);
    const hung = vi.fn(() => new Promise<never>(() => {}));
    const t0 = Date.now();
    expect(
      await freezeCellAgent({
        provider: providerOf(hung),
        cellId: "c",
        budgetMs: 30,
      }),
    ).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
