import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  denyExceptionsFor,
  FIX_DENY_PATHS,
  isDeniedPath,
} from "../../../shared/src/self-heal/fix-paths";
import {
  runAsAgent,
  type AgentCommandResult,
  type RunAsAgent,
} from "./agent-command";
import {
  hardenGitEnv,
  matchesDenyPath,
  MAX_REPORTED_DENIED_PATHS,
  pinFixBaseSha,
  remoteBranchHead,
  reportableDeniedPaths,
  runFixCheck,
  WORKER_FIX_DENY_PATHS,
  type RunFixCheckArgs,
  type SelfHealFixShape,
} from "./self-heal-fix-check";

const PUSHED = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);

interface Call {
  script: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function res(
  exitCode: number | null,
  stdout = "",
  extra: Partial<AgentCommandResult> = {},
): AgentCommandResult {
  return { exitCode, stdout, timedOut: false, truncated: false, ...extra };
}

/** Which step a script is, by its git verb (scripts are module constants). */
function stepOf(script: string): string {
  if (script.includes("config --local")) return "guard";
  if (script.includes("cat-file")) return "cat-file";
  if (script.includes("git checkout")) return "checkout";
  if (script.includes("git clean")) return "clean";
  if (script.includes("mkdir")) return "scratch";
  if (script.includes("merge-base")) return "merge-base";
  if (script.includes("git diff")) return "diff";
  return "check";
}

function harness(
  overrides: Partial<Record<string, (call: Call) => AgentCommandResult>> = {},
): { run: RunAsAgent; calls: Call[] } {
  const calls: Call[] = [];
  const defaults: Record<string, (call: Call) => AgentCommandResult> = {
    guard: () => res(0, "core.repositoryformatversion\ncore.bare\n"),
    "cat-file": () => res(0),
    checkout: () => res(0),
    clean: () => res(0),
    scratch: () => res(0),
    "merge-base": () => res(0, `${MERGE_BASE}\n`),
    diff: () => res(0, "src/a.ts\0"),
    check: () => res(0),
  };
  const run: RunAsAgent = async (a) => {
    const call = { script: a.script, args: a.args, env: a.env };
    calls.push(call);
    const step = stepOf(a.script);
    return (overrides[step] ?? defaults[step]!)(call);
  };
  return { run, calls };
}

const FIX: SelfHealFixShape = {
  kind: "fix",
  attemptId: "11111111-1111-4111-8111-111111111111",
  branch: "automata/fix-12-deadbeef-a1",
  baseBranch: "main",
  checks: [
    {
      fingerprint: "0123456789abcdef",
      check: "file-exists",
      subject: "SECURITY.md",
    },
  ],
  denyExceptions: [],
  gateToken: "GATE_SENTINEL",
};

function args(
  run: RunAsAgent,
  over: Partial<RunFixCheckArgs> = {},
): RunFixCheckArgs {
  return {
    fix: FIX,
    pushedSha: PUSHED,
    baseSha: BASE,
    workdir: "/w",
    agentUser: "",
    run,
    env: { PATH: "/usr/bin:/bin" },
    deadlineAt: Date.now() + 180_000,
    ...over,
  };
}

describe("runFixCheck (GATE-01, R1)", () => {
  it("happy path: guard → cat-file → checkout → clean → scratch → merge-base → diff → check; completed + pass", async () => {
    const { run, calls } = harness();
    const report = await runFixCheck(args(run));
    expect(calls.map((c) => stepOf(c.script))).toEqual([
      "guard",
      "cat-file",
      "checkout",
      "clean",
      "scratch",
      "merge-base",
      "diff",
      "check",
    ]);
    expect(report).toEqual({
      workerStatus: "completed",
      headSha: PUSHED,
      checkOutcome: "pass",
      deniedPaths: [],
    });
  });

  it("no pushed sha → no_branch and no command runs", async () => {
    const { run, calls } = harness();
    expect(await runFixCheck(args(run, { pushedSha: null }))).toEqual({
      workerStatus: "no_branch",
      headSha: null,
      checkOutcome: null,
      deniedPaths: [],
    });
    expect(calls).toHaveLength(0);
  });

  it("the pushed commit missing locally → error; nothing after cat-file runs", async () => {
    const note = vi.fn();
    const { run, calls } = harness({ "cat-file": () => res(128) });
    const report = await runFixCheck(args(run, { note }));
    expect(report.workerStatus).toBe("error");
    expect(report.checkOutcome).toBeNull();
    expect(calls.map((c) => stepOf(c.script))).toEqual(["guard", "cat-file"]);
    expect(note).toHaveBeenCalledWith("pushed commit is not in the checkout");
  });

  it("a non-hex pushed sha or an unpinned base → error before any command", async () => {
    for (const over of [{ pushedSha: "HEAD" }, { baseSha: null }]) {
      const { run, calls } = harness();
      const report = await runFixCheck(args(run, over));
      expect(report.workerStatus).toBe("error");
      expect(calls).toHaveLength(0);
    }
  });

  it("git clean runs with -ffdx (ignored files and nested repos go too), no keep-backs, no arguments", async () => {
    const { run, calls } = harness();
    await runFixCheck(args(run));
    const clean = calls.find((c) => stepOf(c.script) === "clean")!;
    expect(clean.script).toBe("git clean -ffdxq");
    expect(clean.args).toEqual([]);
    const checkout = calls.find((c) => stepOf(c.script) === "checkout")!;
    expect(checkout.script).toBe('git checkout --quiet --force --detach "$1"');
    expect(checkout.args).toEqual([PUSHED]);
  });

  it("the shas reach commands only as positional arguments", async () => {
    const { run, calls } = harness();
    await runFixCheck(args(run));
    for (const call of calls) {
      expect(call.script).not.toContain(PUSHED);
      expect(call.script).not.toContain(BASE);
      expect(call.script).not.toContain(MERGE_BASE);
    }
    const mb = calls.find((c) => stepOf(c.script) === "merge-base")!;
    expect(mb.args).toEqual([PUSHED, BASE]);
    const diff = calls.find((c) => stepOf(c.script) === "diff")!;
    expect(diff.args).toEqual([PUSHED, MERGE_BASE]);
    expect(diff.script).toContain("--no-renames");
    expect(diff.script).toContain("-z");
  });

  it("FENCE-01: denied paths in the pushed diff are reported; a ci exception is honoured", async () => {
    const { run } = harness({
      diff: () =>
        res(
          0,
          [
            ".claude/settings.json",
            "src/a.ts",
            ".github/workflows/ci.yml",
            "pkg/CLAUDE.md",
          ].join("\0") + "\0",
        ),
    });
    const report = await runFixCheck(
      args(run, {
        fix: { ...FIX, denyExceptions: [".github/workflows/ci.yml"] },
      }),
    );
    expect(report.workerStatus).toBe("completed");
    expect(report.deniedPaths).toEqual([
      ".claude/settings.json",
      "pkg/CLAUDE.md",
    ]);

    const { run: run2 } = harness({
      diff: () => res(0, ".github/workflows/ci.yml\0"),
    });
    expect((await runFixCheck(args(run2))).deniedPaths).toEqual([
      ".github/workflows/ci.yml",
    ]);
  });

  it("an unsafe local git config (filter, include) refuses the check before checkout, as a counted check failure (R2)", async () => {
    for (const key of [
      "filter.x.smudge",
      "include.path",
      "core.worktree",
      "push.x.y",
    ]) {
      const { run, calls } = harness({
        guard: () => res(0, `core.bare\n${key}\n`),
      });
      const report = await runFixCheck(args(run));
      expect(report.workerStatus, key).toBe("completed");
      expect(report.checkOutcome, key).toBe("fail");
      expect(report.headSha, key).toMatch(/^[0-9a-f]{40}$/);
      expect(calls.map((c) => stepOf(c.script))).toEqual(["guard"]);
    }
  });

  it("benign push.* / pull.* keys an agent sets do not refuse the check", async () => {
    const { run, calls } = harness({
      guard: () => res(0, "core.bare\npush.autosetupremote\npull.rebase\n"),
    });
    const report = await runFixCheck(args(run));
    expect(report.workerStatus).toBe("completed");
    expect(report.checkOutcome).toBe("pass");
    expect(calls.map((c) => stepOf(c.script))).toContain("check");
  });

  it("every command overrides hooks and fsmonitor and disables replace refs; the check gets a fresh HOME", async () => {
    const { run, calls } = harness();
    await runFixCheck(
      args(run, {
        workdir: "/w",
        env: {
          PATH: "/bin",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "safe.directory",
          GIT_CONFIG_VALUE_0: "/w",
        },
      }),
    );
    for (const call of calls) {
      expect(call.env.GIT_NO_REPLACE_OBJECTS).toBe("1");
      expect(call.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(call.env.GIT_CONFIG_COUNT).toBe("3");
      expect(call.env.GIT_CONFIG_KEY_0).toBe("safe.directory");
      expect(call.env.GIT_CONFIG_KEY_1).toBe("core.hooksPath");
      expect(call.env.GIT_CONFIG_VALUE_1).toBe("/dev/null");
      expect(call.env.GIT_CONFIG_KEY_2).toBe("core.fsmonitor");
    }
    const check = calls.find((c) => stepOf(c.script) === "check")!;
    // Beside the clone, in the run dir — never in the checkout (#302).
    expect(check.env.HOME).toBe("/fix-check/home");
    expect(check.env.TMPDIR).toBe("/fix-check/tmp");
  });

  it("a failing check → completed + fail; no checks at all → error (never a pass)", async () => {
    const { run } = harness({ check: () => res(1) });
    expect((await runFixCheck(args(run))).checkOutcome).toBe("fail");
    const { run: run2 } = harness();
    const empty = await runFixCheck(
      args(run2, { fix: { ...FIX, checks: [] } }),
    );
    expect(empty.workerStatus).toBe("completed");
    expect(empty.checkOutcome).toBe("error");
  });

  it("#277: a resolved finding's check failing on the fix head fails the gate and names its fingerprint", async () => {
    const { run, calls } = harness({
      check: (call) => res(call.args[0] === "README.md" ? 1 : 0),
    });
    const report = await runFixCheck(
      args(run, {
        fix: {
          ...FIX,
          regressionChecks: [
            {
              fingerprint: "1111111111111111",
              check: "file-exists",
              subject: "LICENSE",
            },
            {
              fingerprint: "2222222222222222",
              check: "file-exists",
              subject: "README.md",
            },
          ],
        },
      }),
    );
    expect(calls.filter((c) => stepOf(c.script) === "check")).toHaveLength(3);
    expect(report).toEqual({
      workerStatus: "completed",
      headSha: PUSHED,
      checkOutcome: "fail",
      deniedPaths: [],
      regressedFingerprints: ["2222222222222222"],
    });
  });

  it("#277: resolved findings that still pass keep the gate passing; their own fingerprint is not re-run", async () => {
    const { run, calls } = harness();
    const report = await runFixCheck(
      args(run, {
        fix: {
          ...FIX,
          regressionChecks: [
            { ...FIX.checks[0]! },
            {
              fingerprint: "1111111111111111",
              check: "file-exists",
              subject: "LICENSE",
            },
          ],
        },
      }),
    );
    expect(calls.filter((c) => stepOf(c.script) === "check")).toHaveLength(2);
    expect(report.checkOutcome).toBe("pass");
    expect(report.regressedFingerprints).toEqual([]);
  });

  it("#277: a resolved finding's check that errors does not fail the gate; the finding's own failure still wins", async () => {
    const regressionChecks = [
      { fingerprint: "1111111111111111", check: "no-such-kind", subject: "x" },
    ];
    const { run } = harness();
    const ok = await runFixCheck(
      args(run, { fix: { ...FIX, regressionChecks } }),
    );
    expect(ok.checkOutcome).toBe("pass");
    expect(ok.regressedFingerprints).toEqual([]);

    const { run: run2 } = harness({
      check: (call) => res(call.args[0] === "SECURITY.md" ? 1 : 0),
    });
    const own = await runFixCheck(
      args(run2, {
        fix: {
          ...FIX,
          regressionChecks: [
            {
              fingerprint: "2222222222222222",
              check: "file-exists",
              subject: "LICENSE",
            },
          ],
        },
      }),
    );
    expect(own.checkOutcome).toBe("fail");
    expect(own.regressedFingerprints).toEqual([]);
  });

  it("check budget exhausted → completed with checkOutcome error", async () => {
    let clock = 1_000;
    const deadlineAt = 10_000;
    const { run, calls } = harness({
      diff: () => {
        clock = deadlineAt;
        return res(0, "src/a.ts\0");
      },
    });
    const report = await runFixCheck(
      args(run, { deadlineAt, now: () => clock }),
    );
    expect(report.workerStatus).toBe("completed");
    expect(report.checkOutcome).toBe("error");
    expect(calls.some((c) => stepOf(c.script) === "check")).toBe(false);
  });

  it("a deadline reached during the git steps → error", async () => {
    let clock = 1_000;
    const { run, calls } = harness({
      checkout: () => {
        clock = 10_000;
        return res(0);
      },
    });
    const report = await runFixCheck(
      args(run, { deadlineAt: 10_000, now: () => clock }),
    );
    expect(report.workerStatus).toBe("error");
    expect(calls.map((c) => stepOf(c.script))).toEqual([
      "guard",
      "cat-file",
      "checkout",
    ]);
  });

  it("abort signal → aborted", async () => {
    const ac = new AbortController();
    const { run } = harness({
      checkout: () => {
        ac.abort();
        return res(null);
      },
    });
    const report = await runFixCheck(args(run, { signal: ac.signal }));
    expect(report.workerStatus).toBe("aborted");
    expect(report.checkOutcome).toBeNull();
  });

  it("a runner that throws → error", async () => {
    const run: RunAsAgent = async () => {
      throw new Error("spawn EACCES");
    };
    expect((await runFixCheck(args(run))).workerStatus).toBe("error");
  });

  it("denied paths are fitted to the route's bounds (≤ 50 entries, ≤ 300 chars)", () => {
    const many = Array.from({ length: 80 }, (_, i) => `.claude/f${i}`);
    expect(reportableDeniedPaths(many, [])).toHaveLength(
      MAX_REPORTED_DENIED_PATHS,
    );
    const long = `.claude/${"x".repeat(400)}`;
    expect(reportableDeniedPaths([long], [])[0]).toHaveLength(300);
  });
});

describe("worker deny-path mirror (drift vs shared fix-paths)", () => {
  it("the deny list equals shared FIX_DENY_PATHS", () => {
    expect([...WORKER_FIX_DENY_PATHS].sort()).toEqual(
      [...FIX_DENY_PATHS].sort(),
    );
  });

  const PATHS = [
    "AGENTS.md",
    "agents.md",
    "CLAUDE.md",
    "Claude.MD",
    "pkg/sub/CLAUDE.md",
    "pkg/AGENTS.md",
    ".claude/settings.json",
    "x/.claude/hooks/a.py",
    ".CLAUDE/x",
    "deploy/run.sh",
    "Deploy/run.sh",
    "deploy",
    "deployment/x",
    "packages/worker/deploy/unit.service",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".github/CODEOWNERS",
    ".github/workflows/nested/x.yml",
    "./AGENTS.md",
    "/AGENTS.md",
    "src//a.ts",
    "src/../AGENTS.md",
    "./src/./a.ts",
    "..",
    ".",
    "",
    "src/a.ts",
    "README.md",
    "package.json",
  ];
  const CONTEXTS = [
    { ruleId: "deps.npm-audit", planFiles: [".github/workflows/ci.yml"] },
    { ruleId: "ci.actions-pinned", planFiles: [".github/workflows/ci.yml"] },
    {
      ruleId: "ci.permissions",
      planFiles: [
        "./.github/workflows/ci.yml",
        ".github/CODEOWNERS",
        "AGENTS.md",
      ],
    },
    { ruleId: "ci.permissions", planFiles: null },
  ];

  it("matchesDenyPath agrees with shared isDeniedPath on every case", () => {
    for (const ctx of CONTEXTS) {
      const exceptions = denyExceptionsFor(ctx);
      for (const p of PATHS) {
        expect(
          matchesDenyPath(p, exceptions),
          `${JSON.stringify(p)} under ${JSON.stringify(ctx)}`,
        ).toBe(isDeniedPath(p, ctx));
      }
    }
  });

  it("a payload exception outside .github/workflows/<file> never un-denies anything", () => {
    expect(matchesDenyPath("AGENTS.md", ["AGENTS.md"])).toBe(true);
    expect(matchesDenyPath(".github/CODEOWNERS", [".github/CODEOWNERS"])).toBe(
      true,
    );
    expect(
      matchesDenyPath(".github/workflows/ci.yml", [
        "./.github/workflows/ci.yml",
      ]),
    ).toBe(false);
  });
});

describe("hardenGitEnv", () => {
  it("starts at index 0 without a caller count and never mutates the input", () => {
    const input = { PATH: "/bin" };
    const out = hardenGitEnv(input);
    expect(out.GIT_CONFIG_COUNT).toBe("2");
    expect(out.GIT_CONFIG_KEY_0).toBe("core.hooksPath");
    expect(input).toEqual({ PATH: "/bin" });
  });
});

describe("pinFixBaseSha / remoteBranchHead (worker-side git)", () => {
  it("pins origin/<base> to a 40-hex sha; anything else is null", async () => {
    const runGit = vi.fn(async (_argv: string[], _opts?: object) => ({
      stdout: `${BASE}\n`,
      stderr: "",
    }));
    expect(
      await pinFixBaseSha({ workdir: "/w", baseBranch: "main", runGit }),
    ).toBe(BASE);
    expect(runGit.mock.calls[0]![0]).toEqual([
      "-C",
      "/w",
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      "refs/remotes/origin/main^{commit}",
    ]);
    const failing = vi.fn(async () => {
      throw new Error("git rev-parse failed (exit 1)");
    });
    expect(
      await pinFixBaseSha({
        workdir: "/w",
        baseBranch: "main",
        runGit: failing,
      }),
    ).toBeNull();
  });

  it("reads the exact branch head from ls-remote; absent → null; failure throws", async () => {
    const runGit = vi.fn(async (_argv: string[], _opts?: object) => ({
      stdout: `${PUSHED}\trefs/heads/automata/fix-1-a1\n`,
      stderr: "",
    }));
    expect(
      await remoteBranchHead({
        repoFullName: "o/r",
        branch: "automata/fix-1-a1",
        installationToken: "tok",
        runGit,
      }),
    ).toBe(PUSHED);
    const argv = runGit.mock.calls[0]![0];
    expect(argv).toContain("ls-remote");
    expect(argv).toContain("https://github.com/o/r.git");
    expect(argv.at(-1)).toBe("refs/heads/automata/fix-1-a1");

    const empty = vi.fn(async () => ({ stdout: "", stderr: "" }));
    expect(
      await remoteBranchHead({
        repoFullName: "o/r",
        branch: "automata/fix-1-a1",
        installationToken: "tok",
        runGit: empty,
      }),
    ).toBeNull();

    const broken = vi.fn(async () => {
      throw new Error("git ls-remote failed (exit 128)");
    });
    await expect(
      remoteBranchHead({
        repoFullName: "o/r",
        branch: "automata/fix-1-a1",
        installationToken: "tok",
        runGit: broken,
      }),
    ).rejects.toThrow(/ls-remote/);
  });
});

describe("runFixCheck against a real git checkout (as the current user)", () => {
  function git(cwd: string, ...argv: string[]): string {
    const r = spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", ...argv],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
    );
    if (r.status !== 0) throw new Error(`git ${argv[0]} failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  function repo(): { dir: string; base: string; pushed: string } {
    // A run dir with the clone at repo/, as provisionWorkdir lays it out.
    const dir = join(mkdtempSync(join(tmpdir(), "fix-check-")), "repo");
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, ".gitignore"), "dist/\n");
    writeFileSync(join(dir, "README.md"), "hi\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    const base = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "-b", "automata/fix-1-a1");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(dir, "SECURITY.md"), "report here\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fix");
    const pushed = git(dir, "rev-parse", "HEAD");
    return { dir, base, pushed };
  }

  const env = (): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  });

  it("checks the pushed commit on a clean tree, lists the denied path, removes planted files", async () => {
    const { dir, base, pushed } = repo();
    // Planted by the "agent" after its commit: an ignored file, an untracked
    // nested repo, and a dirty worktree back on main.
    git(dir, "checkout", "-q", "main");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "SECURITY.md"), "planted\n");
    mkdirSync(join(dir, "nested"));
    git(join(dir, "nested"), "init", "-q");
    writeFileSync(join(dir, "README.md"), "dirty\n");
    // The run's own dirs live beside the clone now (#302), so a `home/` in
    // the clone is just something the agent planted.
    mkdirSync(join(dir, "home"));
    writeFileSync(join(dir, "home", "planted"), "agent\n");

    const report = await runFixCheck({
      fix: FIX,
      pushedSha: pushed,
      baseSha: base,
      workdir: dir,
      agentUser: "",
      run: runAsAgent,
      env: env(),
      deadlineAt: Date.now() + 60_000,
    });
    expect(report).toEqual({
      workerStatus: "completed",
      headSha: pushed,
      checkOutcome: "pass",
      deniedPaths: [".claude/settings.json"],
    });
    expect(existsSync(join(dir, "dist"))).toBe(false);
    expect(existsSync(join(dir, "nested"))).toBe(false);
    expect(existsSync(join(dir, "home"))).toBe(false);
    expect(git(dir, "rev-parse", "HEAD")).toBe(pushed);
  });

  it("a filter planted in .git/config refuses the check (counted fail); push.autoSetupRemote does not", async () => {
    const { dir, base, pushed } = repo();
    git(dir, "config", "filter.evil.smudge", "cat");
    const report = await runFixCheck({
      fix: FIX,
      pushedSha: pushed,
      baseSha: base,
      workdir: dir,
      agentUser: "",
      run: runAsAgent,
      env: env(),
      deadlineAt: Date.now() + 60_000,
    });
    expect(report.workerStatus).toBe("completed");
    expect(report.checkOutcome).toBe("fail");

    const benign = repo();
    git(benign.dir, "config", "push.autoSetupRemote", "true");
    const ok = await runFixCheck({
      fix: FIX,
      pushedSha: benign.pushed,
      baseSha: benign.base,
      workdir: benign.dir,
      agentUser: "",
      run: runAsAgent,
      env: env(),
      deadlineAt: Date.now() + 60_000,
    });
    expect(ok.checkOutcome).toBe("pass");
  });

  it("#277: a resolved finding whose check fails on the pushed tree fails the gate on that fingerprint only", async () => {
    const { dir, base, pushed } = repo();
    const report = await runFixCheck({
      fix: {
        ...FIX,
        regressionChecks: [
          {
            fingerprint: "fedcba9876543210",
            check: "file-exists",
            subject: "CODEOWNERS",
          },
          {
            fingerprint: "0011223344556677",
            check: "file-exists",
            subject: "README.md",
          },
        ],
      },
      pushedSha: pushed,
      baseSha: base,
      workdir: dir,
      agentUser: "",
      run: runAsAgent,
      env: env(),
      deadlineAt: Date.now() + 60_000,
    });
    expect(report.workerStatus).toBe("completed");
    expect(report.checkOutcome).toBe("fail");
    expect(report.regressedFingerprints).toEqual(["fedcba9876543210"]);
  });

  it("a check that fails on the pushed tree → completed + fail", async () => {
    const { dir, base, pushed } = repo();
    const report = await runFixCheck({
      fix: {
        ...FIX,
        checks: [
          {
            fingerprint: "0123456789abcdef",
            check: "file-exists",
            subject: "MISSING.md",
          },
        ],
      },
      pushedSha: pushed,
      baseSha: base,
      workdir: dir,
      agentUser: "",
      run: runAsAgent,
      env: env(),
      deadlineAt: Date.now() + 60_000,
    });
    expect(report.workerStatus).toBe("completed");
    expect(report.checkOutcome).toBe("fail");
  });
});
