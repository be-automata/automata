import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Self-heal acceptance script (self-heal-acceptance.sh; phase 8 audit lane
 * and phase 9 fix lane): contract pins, fixture-driven tests of its
 * sourceable analysers, and the runbook pins. bash -n, shellcheck, the executable bit and strict mode are covered
 * by describeBashScriptHygiene in deploy-assets.test.ts. Pure local: no
 * network, no sudo, no box. `gh` is a fake on PATH.
 */

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const repoRoot = path.resolve(workerRoot, "..", "..");
const scriptRel = "packages/worker/deploy/linux/self-heal-acceptance.sh";
const scriptPath = path.join(repoRoot, scriptRel);
const exists = fs.existsSync(scriptPath);
const script = exists ? fs.readFileSync(scriptPath, "utf8") : "";
const runbookPath = path.join(repoRoot, "deploy", "PILOT-RUNBOOK.md");
const isRoot = process.getuid?.() === 0;

const BOT = "automata-app[bot]";
const SINCE = "2026-10-04T00:00:00Z";

/** The script without its full-line `#` comments. */
function code(source: string): string {
  return source
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

const minimalEnv = () => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: os.tmpdir(),
});

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("/bin/bash", [scriptPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...minimalEnv(), ...env },
  });
}

/** Writes fixture files into a temp dir and runs `fn` with their paths. */
function withFiles<T>(
  files: Record<string, string>,
  fn: (paths: Record<string, string>, dir: string) => T,
): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sha-"));
  try {
    const paths: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content);
      paths[name] = file;
    }
    return fn(paths, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Source the script and call one analyser; stdout+stderr + FAILURES=<n>. */
function callAnalyser(fn: string, args: string[]): string {
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `source "$1"; shift; FAILURES=0; ${fn} "$@"; echo "FAILURES=$FAILURES"`,
      "sh",
      scriptPath,
      ...args,
    ],
    { encoding: "utf8", timeout: 30_000, env: minimalEnv() },
  );
  return result.stdout + result.stderr;
}

// ---------------------------------------------------------------------------
// box journal fixtures (journalctl -o short-unix)
// ---------------------------------------------------------------------------

function jl(epoch: number, msg: string, tid = "thread-aaaa"): string {
  return `${epoch}.000000 box automata-worker[1]: [agent-run ${tid}] ${msg}`;
}
const START = (lane: string) =>
  `run start: lane=${lane} repo=acme/web branch=main`;
const CHECKS = "self-heal checks: requested=2 pass=2 fail=0 error=0 report=ok";
const SPAWN = "daemon spawned: pid=4242";

function journal(lines: string[]): string {
  return lines.join("\n") + "\n";
}

describe("self-heal-acceptance.sh (phase 8): contract", () => {
  it("exists (hygiene: describeBashScriptHygiene in deploy-assets.test.ts)", () => {
    expect(exists).toBe(true);
  });

  it.each<[string, string[], RegExp]>([
    ["no args", [], /usage/i],
    ["an unknown mode", ["deploy"], /usage/i],
    ["box without --since", ["box"], /--since/],
    [
      "github without --repo",
      ["github", "--since", SINCE, "--bot", BOT],
      /--repo/,
    ],
    [
      "github with a malformed --repo",
      ["github", "--repo", "a/b;id", "--since", SINCE, "--bot", BOT],
      /--repo/,
    ],
    [
      "github with a malformed --since",
      ["github", "--repo", "a/b", "--since", "yesterday", "--bot", BOT],
      /--since/,
    ],
    [
      "github with control characters in --since",
      ["github", "--repo", "a/b", "--since", "2026\u0001", "--bot", BOT],
      /--since/,
    ],
    [
      "github with a malformed --bot",
      ["github", "--repo", "a/b", "--since", SINCE, "--bot", "bot;id"],
      /--bot/,
    ],
    [
      "github without --bot",
      ["github", "--repo", "a/b", "--since", SINCE],
      /--bot/,
    ],
    [
      "github with an unknown flag",
      ["github", "--repo", "a/b", "--since", SINCE, "--bot", BOT, "--merge"],
      /usage/i,
    ],
    ["box with an unknown flag", ["box", "--since", "now", "--x"], /usage/i],
  ])("exits 2 on %s", (_name, args, message) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(message);
    expect(result.stdout).not.toContain("ACCEPTANCE:");
  });

  it.skipIf(isRoot)("box refuses a non-root caller with exit 2", () => {
    const result = run(["box", "--since", "now"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/root/);
    expect(result.stdout).toBe("");
  });

  it("is read-only: no gh writes, no git writes, no restarts, no schema pushes", () => {
    const c = code(script);
    expect(c).not.toMatch(/gh\s+(issue|pr|label|release)\b/);
    expect(c).not.toMatch(
      /\bgit(_ro)?\s+(fetch|merge|pull|push|commit|checkout|switch|reset)\b/,
    );
    expect(c).not.toMatch(/systemctl\s+(restart|stop|start)/);
    expect(c).not.toMatch(/drizzle/);
    expect(c).not.toMatch(/\b(chmod|chown)\b/);
    for (const flag of [
      "--field",
      "--raw-field",
      " -f ",
      " -F ",
      " -X",
      "--method",
      "--input",
    ]) {
      expect(c, flag).not.toContain(flag);
    }
    expect(c).toContain('WORK="$(mktemp -d');
    expect(c).toContain("trap cleanup EXIT");
  });

  it("every gh api call is a plain GET on an allowlisted repo endpoint", () => {
    const ghLines = code(script)
      .split("\n")
      .filter((l) => l.includes("gh api"));
    expect(ghLines.length).toBeGreaterThanOrEqual(12);
    for (const line of ghLines) {
      expect(line).toMatch(
        /gh api (--paginate )?"repos\/\$repo(\/(issues|pulls|commits|branches|rules)[^"]*)?"/,
      );
      expect(line).not.toMatch(/--jq|--template|-H\b|--header/);
    }
    for (const endpoint of [
      "/pulls?state=all",
      "/issues/$n/timeline",
      "/pulls/$n/reviews",
      "/commits/$sha/check-runs",
      "/commits/$sha/status",
      "/protection/required_status_checks",
      "/rules/branches/",
      "/commits?sha=",
      "/commits/$sha/pulls",
    ]) {
      expect(code(script), endpoint).toContain(endpoint);
    }
  });

  it("never names a merge, ready or close call (the fix-lane checks are read-only too)", () => {
    const c = code(script);
    expect(c).not.toMatch(/\/merge\b|markPullRequestReady/);
    expect(c).not.toMatch(/gh\s+pr\b/);
  });

  it("local mode runs the targeted shared, www and worker self-heal suites and www tsc", () => {
    const body = code(script);
    for (const needle of [
      "@terragon/shared",
      "@terragon/www",
      "@terragon/worker",
      "--no-file-parallelism",
      "src/server-lib/audit",
      "src/agent-run/self-heal",
      "src/agent-run/receive-pack-refs",
      "src/agent-run/git-broker",
      "tsc --noEmit",
    ]) {
      expect(body, needle).toContain(needle);
    }
  });
});

describe("self-heal-acceptance.sh (phase 8): box journal analyser", () => {
  const analyse = (lines: string[]) =>
    withFiles({ "journal.txt": journal(lines) }, (p) =>
      callAnalyser("analyse_box_journal", [p["journal.txt"] as string]),
    );

  it("PASS: checks are posted before the daemon spawns", () => {
    const out = analyse([
      jl(100, START("self-heal-audit")),
      jl(105, CHECKS),
      jl(106, SPAWN),
    ]);
    expect(out).toMatch(/CHECK [^\n]*checks before daemon[^\n]*: PASS/);
    expect(out).toContain("FAILURES=0");
  });

  it("FAIL: checks are posted after the daemon spawns", () => {
    const out = analyse([
      jl(100, START("self-heal-audit")),
      jl(101, SPAWN),
      jl(105, CHECKS),
    ]);
    expect(out).toMatch(/CHECK [^\n]*checks before daemon[^\n]*: FAIL/);
    expect(out).toContain("FAILURES=1");
  });

  it("FAIL: an audit run that never posted checks", () => {
    const out = analyse([jl(100, START("self-heal-audit")), jl(101, SPAWN)]);
    expect(out).toMatch(/CHECK [^\n]*checks before daemon[^\n]*: FAIL/);
  });

  it("FAIL: no lane=self-heal-audit run in the window", () => {
    const out = analyse([jl(100, START("review")), jl(101, SPAWN)]);
    expect(out).toMatch(/CHECK [^\n]*audit run[^\n]*: FAIL/);
    expect(out).toContain("FAILURES=");
    expect(out).not.toContain("FAILURES=0");
  });

  it("ignores a review run that has no checks line", () => {
    const out = analyse([
      jl(90, START("review"), "thread-review"),
      jl(91, SPAWN, "thread-review"),
      jl(100, START("self-heal-audit")),
      jl(105, CHECKS),
      jl(106, SPAWN),
    ]);
    expect(out).toContain("FAILURES=0");
  });

  it.each(["x-self-heal-check-token: abc", "env checkToken=abc"])(
    "FAIL: a journal line carries the check token (%s)",
    (leak) => {
      const out = analyse([
        jl(100, START("self-heal-audit")),
        jl(105, CHECKS),
        jl(106, SPAWN),
        jl(107, `leaked ${leak}`),
      ]);
      expect(out).toMatch(/CHECK [^\n]*check token[^\n]*: FAIL/);
      expect(out).not.toContain("FAILURES=0");
    },
  );
});

// ---------------------------------------------------------------------------
// github fixtures
// ---------------------------------------------------------------------------

interface IssueFixture {
  number?: number;
  login?: string;
  body?: string;
  labels?: string[];
  pull_request?: object;
}

function issue(over: IssueFixture = {}): object {
  const n = over.number ?? 1;
  return {
    number: n,
    user: { login: over.login ?? BOT },
    body:
      over.body ?? `<!-- automata-finding:v1 fp=fp-${n} -->\nA real finding.`,
    labels: (over.labels ?? ["automata:finding", "audit:security"]).map(
      (name) => ({ name }),
    ),
    ...(over.pull_request ? { pull_request: over.pull_request } : {}),
  };
}

function comment(
  fp: string,
  run: string,
  over: { login?: string; body?: string } = {},
): object {
  return {
    user: { login: over.login ?? BOT },
    body:
      over.body ??
      `<!-- automata-finding-comment:v1 fp=${fp} kind=reopened run=${run} -->\nSeen again.`,
  };
}

function analyseGithub(
  issues: object[],
  humanIssues: object[] = [],
  comments: object[] = [],
): string {
  return withFiles(
    {
      "issues.json": JSON.stringify(issues),
      "human.json": JSON.stringify(humanIssues),
      "comments.json": JSON.stringify(comments),
    },
    (p) =>
      callAnalyser("analyse_github", [
        p["issues.json"] as string,
        p["human.json"] as string,
        p["comments.json"] as string,
        BOT,
      ]),
  );
}

describe("self-heal-acceptance.sh (phase 8): github analyser", () => {
  it("clean fixture passes every check", () => {
    const out = analyseGithub(
      [issue({ number: 1 }), issue({ number: 2 })],
      [],
      [comment("fp-1", "r1"), comment("fp-2", "r1")],
    );
    expect(out).not.toMatch(/CHECK [^\n]*: FAIL/);
    expect(out).toContain("FAILURES=0");
  });

  it("accepts the bot login with or without the [bot] suffix", () => {
    const out = analyseGithub([issue({ login: "automata-app" })]);
    expect(out).toContain("FAILURES=0");
  });

  it("ignores pull requests returned by the issues endpoint", () => {
    const out = analyseGithub([
      issue({ number: 1 }),
      issue({
        number: 9,
        login: "someone",
        body: "plain pr",
        pull_request: {},
      }),
    ]);
    expect(out).toContain("FAILURES=0");
  });

  it("FAIL: a finding issue not authored by the bot", () => {
    const out = analyseGithub([issue({ login: "a-person" })]);
    expect(out).toMatch(/CHECK [^\n]*bot authorship[^\n]*: FAIL/);
  });

  it("FAIL: two issues share a fingerprint marker", () => {
    const out = analyseGithub([
      issue({ number: 1, body: "<!-- automata-finding:v1 fp=same -->\nA" }),
      issue({ number: 2, body: "<!-- automata-finding:v1 fp=same -->\nB" }),
    ]);
    expect(out).toMatch(/CHECK [^\n]*one issue per fingerprint[^\n]*: FAIL/);
  });

  it("FAIL: the marker is not on line 1", () => {
    const out = analyseGithub([
      issue({
        body: "Intro first\n<!-- automata-finding:v1 fp=late -->\nbody",
      }),
    ]);
    expect(out).toMatch(/CHECK [^\n]*marker on line 1[^\n]*: FAIL/);
  });

  it.each(["Fixes #3", "This closes #12 soon", "resolves: acme/web#4"])(
    "FAIL: a closing keyword in the body (%s)",
    (text) => {
      const out = analyseGithub([
        issue({ body: `<!-- automata-finding:v1 fp=k -->\n${text}` }),
      ]);
      expect(out).toMatch(/CHECK [^\n]*closing keyword or mention[^\n]*: FAIL/);
    },
  );

  it("FAIL: a bare @mention in the body", () => {
    const out = analyseGithub([
      issue({
        body: "<!-- automata-finding:v1 fp=m -->\nping @someuser please",
      }),
    ]);
    expect(out).toMatch(/CHECK [^\n]*closing keyword or mention[^\n]*: FAIL/);
  });

  it("does not flag an @ inside backticks", () => {
    const out = analyseGithub([
      issue({
        body: "<!-- automata-finding:v1 fp=m -->\nuse `@types/node` here",
      }),
    ]);
    expect(out).toContain("FAILURES=0");
  });

  it.each(["bug", "enhancement"])(
    "FAIL: a %s label on a finding issue",
    (label) => {
      const out = analyseGithub([
        issue({ labels: ["automata:finding", label] }),
      ]);
      expect(out).toMatch(/CHECK [^\n]*label hygiene[^\n]*: FAIL/);
    },
  );

  it("FAIL: the automata:needs-human label exists on an issue", () => {
    const out = analyseGithub(
      [issue({ number: 1 })],
      [issue({ number: 5, labels: ["automata:needs-human"] })],
    );
    expect(out).toMatch(/CHECK [^\n]*label hygiene[^\n]*: FAIL/);
  });

  it("FAIL: two bot comments carry the same comment marker", () => {
    const out = analyseGithub(
      [issue({ number: 1 })],
      [],
      [comment("fp-1", "r1"), comment("fp-1", "r1")],
    );
    expect(out).toMatch(/CHECK [^\n]*duplicate comment marker[^\n]*: FAIL/);
  });

  it("does not flag the same fingerprint commented in two different runs", () => {
    const out = analyseGithub(
      [issue({ number: 1 })],
      [],
      [comment("fp-1", "r1"), comment("fp-1", "r2")],
    );
    expect(out).toContain("FAILURES=0");
  });

  it("FAIL: a marker comment authored by a non-bot", () => {
    const out = analyseGithub(
      [issue({ number: 1 })],
      [],
      [comment("fp-1", "r1", { login: "a-person" })],
    );
    expect(out).toMatch(/CHECK [^\n]*bot authorship[^\n]*: FAIL/);
  });

  it("ignores unrelated human comments", () => {
    const out = analyseGithub(
      [issue({ number: 1 })],
      [],
      [{ user: { login: "a-person" }, body: "thanks, looking" }],
    );
    expect(out).toContain("FAILURES=0");
  });

  describe("end to end with a fake gh on PATH", () => {
    function fakeGh(dir: string): void {
      const bin = path.join(dir, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, "gh"),
        [
          "#!/bin/bash",
          'echo "$@" >> "$FAKE_GH_LOG"',
          'case "$*" in',
          '  *"issues/comments"*) cat "$FIX/comments.json" ;;',
          '  *"labels=automata%3Aneeds-human"*|*"labels=automata:needs-human"*) cat "$FIX/human.json" ;;',
          '  *"labels=automata%3Afinding"*|*"labels=automata:finding"*) cat "$FIX/issues.json" ;;',
          '  *"/timeline"*) cat "$FIX/timeline.json" ;;',
          '  *"/reviews"*) cat "$FIX/reviews.json" ;;',
          '  *"/check-runs"*) cat "$FIX/check-runs.json" ;;',
          '  *"/protection/"*) if [ -f "$FIX/protection.json" ]; then cat "$FIX/protection.json"; else echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi ;;',
          '  *"/rules/branches/"*) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;',
          '  *"/status"*) cat "$FIX/status.json" ;;',
          '  *"/commits/"*"/pulls"*) cat "$FIX/commit-pulls.json" ;;',
          '  *"/commits?"*) cat "$FIX/commits.json" ;;',
          '  *"/pulls?"*) cat "$FIX/pulls.json" ;;',
          '  *"/pulls/"*) last="${!#}"; cat "$FIX/pr-${last##*/pulls/}.json" ;;',
          '  "api repos/acme/web") echo \'{"default_branch":"main"}\' ;;',
          '  *) echo "unexpected gh call: $*" >&2; exit 1 ;;',
          "esac",
        ].join("\n"),
        { mode: 0o755 },
      );
    }

    interface FixLaneFixture {
      prs?: Record<string, unknown>[];
      protection?: object;
      mergedBy?: string;
    }

    function runGithub(
      issues: object[],
      comments: object[],
      lane: FixLaneFixture = {},
    ) {
      const prs = lane.prs ?? [];
      const first = prs[0] ?? {};
      const strip = (pr: Record<string, unknown>) => {
        const plain = { ...pr, created_at: "2026-10-04T03:00:00Z" };
        for (const key of [
          "gated_sha",
          "timeline",
          "reviews",
          "check_runs",
          "statuses",
        ]) {
          delete (plain as Record<string, unknown>)[key];
        }
        return plain;
      };
      const files: Record<string, string> = {
        "issues.json": JSON.stringify(issues),
        "human.json": "[]",
        "comments.json": JSON.stringify(comments),
        "pulls.json": JSON.stringify(prs.map(strip)),
        "timeline.json": JSON.stringify(first.timeline ?? []),
        "reviews.json": JSON.stringify(first.reviews ?? []),
        "check-runs.json": JSON.stringify({
          total_count: 0,
          check_runs: first.check_runs ?? [],
        }),
        "status.json": JSON.stringify({ statuses: first.statuses ?? [] }),
        "commits.json": JSON.stringify([{ sha: OTHER_SHA }]),
        "commit-pulls.json": JSON.stringify([{ number: 5 }]),
        "pr-5.json": JSON.stringify({
          number: 5,
          merged_at: "2026-10-04T04:00:00Z",
          merged_by: { login: lane.mergedBy ?? "a-person" },
        }),
        "gh.log": "",
      };
      for (const pr of prs) {
        files[`pr-${String(pr.number)}.json`] = JSON.stringify(strip(pr));
      }
      if (lane.protection) {
        files["protection.json"] = JSON.stringify(lane.protection);
      }
      return withFiles(files, (p, dir) => {
        fakeGh(dir);
        const result = run(
          [
            "github",
            "--repo",
            "acme/web",
            "--since",
            SINCE,
            "--bot",
            BOT,
            ...(prs.length > 0 ? ["--expect-fix"] : []),
          ],
          {
            PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}`,
            FIX: dir,
            FAKE_GH_LOG: p["gh.log"] as string,
            TMPDIR: dir,
          },
        );
        return {
          result,
          log: fs.readFileSync(p["gh.log"] as string, "utf8"),
        };
      });
    }

    it("ends ACCEPTANCE: PASS on a clean repo and only issues plain GETs", () => {
      const { result, log } = runGithub(
        [issue({ number: 1 })],
        [comment("fp-1", "r1")],
      );
      expect(result.stdout).toContain("ACCEPTANCE: PASS");
      expect(result.status).toBe(0);
      for (const line of log.trim().split("\n")) {
        expect(line).toMatch(/^api (--paginate )?repos\/acme\/web(\/|$)/);
        expect(line).not.toMatch(/ -X | --method | -f | -F | --input /);
      }
    });

    it("phase 9: a clean fix cycle on an unprotected repo ends ACCEPTANCE: PASS", () => {
      const { result, log } = runGithub(
        [issue({ number: 1 })],
        [comment("fp-1", "r1")],
        { prs: [fixPr() as Record<string, unknown>] },
      );
      expect(result.stdout).toContain(
        "INFO branch protection: none (gate source all-checks)",
      );
      expect(result.stdout).toMatch(/CHECK [^\n]*ready after CI gate: PASS/);
      expect(result.stdout).toContain("ACCEPTANCE: PASS");
      expect(result.status).toBe(0);
      for (const endpoint of [
        "repos/acme/web/pulls/11",
        "repos/acme/web/issues/11/timeline",
        "repos/acme/web/pulls/11/reviews",
        `repos/acme/web/commits/${SHA}/check-runs`,
        `repos/acme/web/commits/${SHA}/status`,
        "repos/acme/web/branches/main/protection/required_status_checks",
        `repos/acme/web/commits/${OTHER_SHA}/pulls`,
        "repos/acme/web/pulls/5",
      ]) {
        expect(log, endpoint).toContain(endpoint);
      }
    });

    it("phase 9: a default-branch commit merged by the bot fails the run", () => {
      const { result } = runGithub(
        [issue({ number: 1 })],
        [comment("fp-1", "r1")],
        { prs: [fixPr() as Record<string, unknown>], mergedBy: BOT },
      );
      expect(result.stdout).toMatch(
        /CHECK [^\n]*default-branch commits[^\n]*: FAIL/,
      );
      expect(result.status).toBe(1);
    });

    it("ends ACCEPTANCE: FAIL (n) with exit 1 on a violation", () => {
      const { result } = runGithub(
        [issue({ number: 1, labels: ["automata:finding", "bug"] })],
        [],
      );
      expect(result.stdout).toMatch(/ACCEPTANCE: FAIL \(\d+\)/);
      expect(result.status).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// phase 9: box journal, fix lane
// ---------------------------------------------------------------------------

const FIX_TID = "thread-fix1";
const TERMINAL = "thread-status: complete (terminal=true)";
const FIX_CHECK =
  "self-heal fix-check: status=completed check=pass denied=0 head=abc1234 ms=900 report=recorded";
const RELEASED = "box lock released by run (helper pid 77)";

/** An audit run (phase 8 checks pass) plus the given fix-run lines. */
function auditAnd(fixLines: string[]): string[] {
  return [
    jl(100, START("self-heal-audit")),
    jl(105, CHECKS),
    jl(106, SPAWN),
    ...fixLines.map((line, i) => jl(200 + i, line, FIX_TID)),
  ];
}

describe("self-heal-acceptance.sh (phase 9): box journal, fix lane", () => {
  const analyse = (lines: string[], expectFix = "0") =>
    withFiles({ "journal.txt": journal(lines) }, (p) =>
      callAnalyser("analyse_box_journal", [
        p["journal.txt"] as string,
        expectFix,
      ]),
    );

  it("PASS: the fix check runs after the terminal poll and before the lock release", () => {
    const out = analyse(
      auditAnd([START("self-heal-fix"), SPAWN, TERMINAL, FIX_CHECK, RELEASED]),
      "1",
    );
    expect(out).toMatch(/CHECK [^\n]*fix-check order[^\n]*: PASS/);
    expect(out).toContain("FAILURES=0");
  });

  it("FAIL: the fix check before the terminal poll", () => {
    const out = analyse(
      auditAnd([START("self-heal-fix"), SPAWN, FIX_CHECK, TERMINAL, RELEASED]),
    );
    expect(out).toMatch(/CHECK [^\n]*fix-check order[^\n]*: FAIL/);
    expect(out).toContain("FAILURES=1");
  });

  it("FAIL: the fix check after the box lock was released", () => {
    const out = analyse(
      auditAnd([START("self-heal-fix"), SPAWN, TERMINAL, RELEASED, FIX_CHECK]),
    );
    expect(out).toMatch(/CHECK [^\n]*fix-check order[^\n]*: FAIL/);
  });

  it("FAIL: a fix run that never logged its check", () => {
    const out = analyse(
      auditAnd([START("self-heal-fix"), SPAWN, TERMINAL, RELEASED]),
    );
    expect(out).toMatch(/CHECK [^\n]*fix-check order[^\n]*: FAIL/);
  });

  it("an early refusal note before the terminal poll does not count as the check", () => {
    const out = analyse(
      auditAnd([
        START("self-heal-fix"),
        "self-heal fix-check: base branch not pinned (check will error)",
        SPAWN,
        TERMINAL,
        FIX_CHECK,
        RELEASED,
      ]),
    );
    expect(out).toContain("FAILURES=0");
  });

  it("an aborted fix run is evidence, not an ordering failure", () => {
    const out = analyse(
      auditAnd([
        START("self-heal-fix"),
        SPAWN,
        RELEASED,
        "self-heal fix-check: status=aborted check=none denied=0 head=- ms=0 report=recorded",
      ]),
    );
    expect(out).toMatch(/EVIDENCE [^\n]*aborted[^\n]*: 1/);
    expect(out).toContain("FAILURES=0");
  });

  it.each(["x-self-heal-gate-token: abc", "input gateToken=abc"])(
    "FAIL: a journal line carries the gate token (%s)",
    (leak) => {
      const out = analyse(
        auditAnd([
          START("self-heal-fix"),
          TERMINAL,
          FIX_CHECK,
          RELEASED,
          `leaked ${leak}`,
        ]),
      );
      expect(out).toMatch(/CHECK [^\n]*gate token[^\n]*: FAIL/);
      expect(out).not.toContain("FAILURES=0");
    },
  );

  it("reports ref-fence refusals as EVIDENCE", () => {
    const out = analyse(
      auditAnd([
        START("self-heal-fix"),
        "git-broker: ref fence refused push (ref_not_allowed) ref=refs/heads/main",
        TERMINAL,
        FIX_CHECK,
        RELEASED,
      ]),
    );
    expect(out).toMatch(/EVIDENCE ref-fence refusals[^\n]*: 1/);
    expect(out).toMatch(/EVIDENCE ref-fence refusal: [^\n]*ref fence refused/);
    expect(out).toContain("FAILURES=0");
  });

  it("no fix run: evidence only, unless --expect-fix", () => {
    const lines = auditAnd([]);
    expect(analyse(lines, "0")).toContain("FAILURES=0");
    const strict = analyse(lines, "1");
    expect(strict).toMatch(/CHECK [^\n]*fix run present[^\n]*: FAIL/);
    expect(strict).toContain("FAILURES=1");
  });
});

// ---------------------------------------------------------------------------
// phase 9: github fix lane fixtures
// ---------------------------------------------------------------------------

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const T_CHECK_DONE = "2026-10-04T03:05:00Z";
const T_READY = "2026-10-04T03:10:00Z";
const T_LATE = "2026-10-04T03:20:00Z";

interface FixPrFixture {
  number?: number;
  login?: string;
  state?: "open" | "closed";
  draft?: boolean;
  body?: string;
  headRef?: string;
  labels?: string[];
  mergedBy?: string | null;
  timeline?: object[];
  reviews?: object[];
  checkRuns?: object[];
  statuses?: object[];
}

const readyEvent = (at = T_READY, login = BOT) => ({
  event: "ready_for_review",
  created_at: at,
  actor: { login },
});
const committed = (sha = SHA) => ({ event: "committed", sha });
const botReview = (sha = SHA, login = BOT) => ({
  user: { login },
  commit_id: sha,
  state: "COMMENTED",
});
const checkRun = (
  name = "build",
  completedAt = T_CHECK_DONE,
  conclusion = "success",
) => ({ name, status: "completed", conclusion, completed_at: completedAt });

function fixPr(over: FixPrFixture = {}): object {
  const merged = over.mergedBy !== undefined && over.mergedBy !== null;
  return {
    number: over.number ?? 11,
    state: over.state ?? (merged ? "closed" : "open"),
    draft: over.draft ?? false,
    user: { login: over.login ?? BOT },
    body:
      over.body ??
      "Fixes #1\n\nAutomata never merges; a person reviews and merges.",
    head: { ref: over.headRef ?? "automata/fix-1-abcd1234-1", sha: SHA },
    base: { ref: "main" },
    merged_at: merged ? "2026-10-04T05:00:00Z" : null,
    merged_by: merged ? { login: over.mergedBy } : null,
    labels: (over.labels ?? []).map((name) => ({ name })),
    gated_sha: SHA,
    timeline: over.timeline ?? [committed(), readyEvent()],
    reviews: over.reviews ?? [botReview()],
    check_runs: over.checkRuns ?? [checkRun()],
    statuses: over.statuses ?? [],
  };
}

const NO_PROTECTION = { readable: false, contexts: [] };

function analyseFix(
  prs: object[],
  {
    issues = [issue({ number: 1 })],
    protection = NO_PROTECTION,
    expectFix = "0",
  }: { issues?: object[]; protection?: object; expectFix?: string } = {},
): string {
  return withFiles(
    {
      "prs.json": JSON.stringify(prs),
      "issues.json": JSON.stringify(issues),
      "protection.json": JSON.stringify(protection),
    },
    (p) =>
      callAnalyser("analyse_fix_prs", [
        p["prs.json"] as string,
        p["issues.json"] as string,
        p["protection.json"] as string,
        BOT,
        expectFix,
      ]),
  );
}

describe("self-heal-acceptance.sh (phase 9): github fix-lane analyser", () => {
  it("clean fixture passes; missing protection is INFO only", () => {
    const out = analyseFix([fixPr()], { expectFix: "1" });
    expect(out).not.toMatch(/CHECK [^\n]*: FAIL/);
    expect(out).toContain(
      "INFO branch protection: none (gate source all-checks)",
    );
    expect(out).toContain("FAILURES=0");
  });

  it("a still-draft fix PR with no ready event is fine", () => {
    const out = analyseFix([
      fixPr({ draft: true, timeline: [committed()], reviews: [] }),
    ]);
    expect(out).toContain("FAILURES=0");
  });

  it("FAIL: a fix PR not authored by the bot", () => {
    const out = analyseFix([fixPr({ login: "a-person" })]);
    expect(out).toMatch(/CHECK [^\n]*fix PR bot authorship[^\n]*: FAIL/);
  });

  it("FAIL: a non-draft fix PR whose timeline has no ready_for_review (opened ready)", () => {
    const out = analyseFix([fixPr({ timeline: [committed()] })]);
    expect(out).toMatch(/CHECK [^\n]*draft before ready[^\n]*: FAIL/);
  });

  it("FAIL: a fix PR that started ready (converted to draft first)", () => {
    const out = analyseFix([
      fixPr({
        timeline: [
          committed(),
          { event: "convert_to_draft", created_at: T_CHECK_DONE },
          readyEvent(),
        ],
      }),
    ]);
    expect(out).toMatch(/CHECK [^\n]*draft before ready[^\n]*: FAIL/);
  });

  it("FAIL: unprotected, ready_for_review before every check on the head completed", () => {
    const out = analyseFix([
      fixPr({ checkRuns: [checkRun("build"), checkRun("lint", T_LATE)] }),
    ]);
    expect(out).toMatch(/CHECK [^\n]*ready after CI gate[^\n]*: FAIL/);
  });

  it("FAIL: unprotected, a failing check on the head", () => {
    const out = analyseFix([
      fixPr({
        checkRuns: [
          checkRun("build"),
          checkRun("lint", T_CHECK_DONE, "failure"),
        ],
      }),
    ]);
    expect(out).toMatch(/CHECK [^\n]*ready after CI gate[^\n]*: FAIL/);
  });

  it("FAIL: unprotected, a commit status that was still pending at ready time", () => {
    const out = analyseFix([
      fixPr({
        statuses: [
          { context: "ci/legacy", state: "success", updated_at: T_LATE },
        ],
      }),
    ]);
    expect(out).toMatch(/CHECK [^\n]*ready after CI gate[^\n]*: FAIL/);
  });

  it("protection: only the required checks gate; a late optional check is fine", () => {
    const out = analyseFix(
      [fixPr({ checkRuns: [checkRun("build"), checkRun("lint", T_LATE)] })],
      { protection: { readable: true, contexts: ["build"] } },
    );
    expect(out).toContain(
      "INFO branch protection: required checks build (gate source protection)",
    );
    expect(out).toContain("FAILURES=0");
  });

  it("FAIL: protection, the required check completed after ready", () => {
    const out = analyseFix(
      [fixPr({ checkRuns: [checkRun("build", T_LATE)] })],
      {
        protection: { readable: true, contexts: ["build"] },
      },
    );
    expect(out).toMatch(/CHECK [^\n]*ready after CI gate[^\n]*: FAIL/);
  });

  it("FAIL: protection, a required check never ran on the head", () => {
    const out = analyseFix([fixPr({ checkRuns: [checkRun("lint")] })], {
      protection: { readable: true, contexts: ["build"] },
    });
    expect(out).toMatch(/CHECK [^\n]*ready after CI gate[^\n]*: FAIL/);
  });

  it("finding-check-only: no check at all needs the needs-human-approve label", () => {
    const flagged = analyseFix([
      fixPr({ checkRuns: [], labels: ["needs-human-approve"] }),
    ]);
    expect(flagged).toContain("FAILURES=0");
    const unflagged = analyseFix([fixPr({ checkRuns: [] })]);
    expect(unflagged).toMatch(/CHECK [^\n]*ready after CI gate[^\n]*: FAIL/);
  });

  it("a PR a person marked ready is evidence, not a gate failure", () => {
    const out = analyseFix([
      fixPr({
        timeline: [committed(), readyEvent(T_CHECK_DONE, "a-person")],
        checkRuns: [checkRun("build", T_LATE)],
      }),
    ]);
    expect(out).toMatch(/EVIDENCE fix PRs readied by a person: 1/);
    expect(out).toContain("FAILURES=0");
  });

  it.each([
    [
      "no Fixes line",
      "A fix.\n\nAutomata never merges; a person reviews and merges.",
    ],
    [
      "a Fixes line for a non-ledger issue",
      "Fixes #99\n\nAutomata never merges.",
    ],
  ])("FAIL: %s", (_name, body) => {
    const out = analyseFix([fixPr({ body })]);
    expect(out).toMatch(/CHECK [^\n]*finding link[^\n]*: FAIL/);
  });

  it("FAIL: two open fix PRs for one issue; an open plus a closed one is fine", () => {
    const two = analyseFix([fixPr({ number: 11 }), fixPr({ number: 12 })]);
    expect(two).toMatch(/CHECK [^\n]*one open fix PR per issue[^\n]*: FAIL/);
    const one = analyseFix([
      fixPr({ number: 11 }),
      fixPr({ number: 12, state: "closed" }),
    ]);
    expect(one).toContain("FAILURES=0");
  });

  it("FAIL: a fix PR merged by the bot; merged by a person passes", () => {
    const bot = analyseFix([fixPr({ mergedBy: "automata-app" })]);
    expect(bot).toMatch(/CHECK [^\n]*merged by the bot[^\n]*: FAIL/);
    const person = analyseFix([fixPr({ mergedBy: "a-person" })]);
    expect(person).toContain("FAILURES=0");
  });

  it.each<[string, object[]]>([
    ["no bot review", []],
    ["a human review only", [botReview(SHA, "a-person")]],
    ["two bot reviews at the head", [botReview(), botReview()]],
    ["a bot review at another sha only", [botReview(OTHER_SHA)]],
  ])("FAIL: a ready PR with %s", (_name, reviews) => {
    const out = analyseFix([fixPr({ reviews })]);
    expect(out).toMatch(/CHECK [^\n]*one bot review[^\n]*: FAIL/);
  });

  it("one bot review at the gated head plus others elsewhere passes", () => {
    const out = analyseFix([
      fixPr({
        reviews: [
          botReview(OTHER_SHA),
          botReview(),
          botReview(SHA, "a-person"),
        ],
      }),
    ]);
    expect(out).toContain("FAILURES=0");
  });

  it("ignores pull requests that are not on an automata/fix- branch", () => {
    const out = analyseFix([
      fixPr(),
      fixPr({ number: 30, headRef: "feature/x", login: "a-person", body: "" }),
    ]);
    expect(out).toContain("FAILURES=0");
  });

  it("no fix PR: evidence only, unless --expect-fix", () => {
    expect(analyseFix([], { expectFix: "0" })).toContain("FAILURES=0");
    const strict = analyseFix([], { expectFix: "1" });
    expect(strict).toMatch(/CHECK [^\n]*fix PRs present[^\n]*: FAIL/);
  });
});

describe("self-heal-acceptance.sh (phase 9): default-branch merges", () => {
  const pull = (number: number, mergedBy: string | null) => ({
    number,
    merged_at: mergedBy === null ? null : "2026-10-04T05:00:00Z",
    merged_by: mergedBy === null ? null : { login: mergedBy },
  });
  const analyse = (commits: object[]) =>
    withFiles({ "commits.json": JSON.stringify(commits) }, (p) =>
      callAnalyser("analyse_default_branch", [
        p["commits.json"] as string,
        BOT,
      ]),
    );

  it("PASS: every commit reached the branch through a PR a person merged", () => {
    const out = analyse([
      { sha: SHA, prs: [pull(11, "a-person")] },
      { sha: OTHER_SHA, prs: [pull(3, null), pull(12, "someone")] },
    ]);
    expect(out).toMatch(/CHECK [^\n]*default-branch commits[^\n]*: PASS/);
    expect(out).toContain("FAILURES=0");
  });

  it("PASS: no commit since --since", () => {
    expect(analyse([])).toContain("FAILURES=0");
  });

  it.each<[string, object[]]>([
    ["a direct push (no PR)", []],
    ["a PR merged by the bot", [pull(11, "automata-app[bot]")]],
    ["an unmerged PR only", [pull(11, null)]],
  ])("FAIL: %s", (_name, prs) => {
    const out = analyse([{ sha: SHA, prs }]);
    expect(out).toMatch(/CHECK [^\n]*default-branch commits[^\n]*: FAIL/);
    expect(out).toContain("FAILURES=1");
  });
});

// ---------------------------------------------------------------------------
// runbook pins
// ---------------------------------------------------------------------------

describe("PILOT-RUNBOOK.md: audit self-healing loop section (phase 8)", () => {
  const runbook = fs.readFileSync(runbookPath, "utf8");
  const heading = "## Audit self-healing loop — audit to issues (phase 8)";
  const start = runbook.indexOf(heading);
  const rest = start === -1 ? "" : runbook.slice(start + heading.length);
  const next = rest.search(/\n## /);
  const section = next === -1 ? rest : rest.slice(0, next);

  it("has the section", () => {
    expect(start).toBeGreaterThan(-1);
  });

  it("orders the rollout: schema push, schema gate, BUILD_ID, 401 probe, idle box, flag, skill-push", () => {
    let from = 0;
    for (const needle of [
      "drizzle-kit push",
      "assert-schema-ready",
      "BUILD_ID",
      "401",
      "idle",
      "selfHealLoop",
      "skill-push",
    ]) {
      const at = section.indexOf(needle, from);
      expect(at, `"${needle}" after offset ${from}`).toBeGreaterThan(-1);
      from = at + needle.length;
    }
  });

  it("states the dry-run exit criteria", () => {
    expect(section).toContain("churn");
    expect(section).toContain("≥ 3");
    expect(section).toContain("would_create");
  });

  it("documents stop, drain, bulk-clean, rollback order and re-arm", () => {
    for (const needle of [
      "Drain",
      "kill switch",
      "Bulk-clean",
      "flag off → disable the audit automations → revert the",
      "Re-arm",
    ]) {
      expect(section, needle).toContain(needle);
    }
  });

  it("names the label set and never recommends bug or enhancement", () => {
    for (const label of [
      "automata:finding",
      "automata:auto-fix",
      "needs-human-approve",
      "automata:wontfix",
      "automata:paused",
    ]) {
      expect(section, label).toContain(label);
    }
    expect(section).toContain("NEVER");
  });

  it("names no customer from the deny list", () => {
    // The deny-list token is assembled so this public file never spells it.
    const denied = ["ban", "gr"].join("");
    expect(section.toLowerCase()).not.toContain(denied);
  });
});

describe("PILOT-RUNBOOK.md: audit self-healing loop section — fix loop (phase 9)", () => {
  const runbook = fs.readFileSync(runbookPath, "utf8");
  const heading = "## Audit self-healing loop — fix loop (phase 9)";
  const start = runbook.indexOf(heading);
  const rest = start === -1 ? "" : runbook.slice(start + heading.length);
  const next = rest.search(/\n## /);
  const section = next === -1 ? rest : rest.slice(0, next);

  it("has the section", () => {
    expect(start).toBeGreaterThan(-1);
  });

  it("deploys the worker first, then www, and keeps the flag and mode off until both run phase 9", () => {
    const worker = section.indexOf("worker first");
    expect(worker).toBeGreaterThan(-1);
    expect(section.indexOf("www", worker)).toBeGreaterThan(worker);
    expect(section).toContain("Until BOTH halves run phase 9");
  });

  it("pins the ROLL-01 rollback order", () => {
    // The rollback bullet, which may wrap over several lines.
    const at = section.indexOf("Rollback order");
    const end = section.indexOf("\n- ", at);
    const line =
      at === -1 ? "" : section.slice(at, end === -1 ? undefined : end);
    let from = 0;
    for (const needle of [
      "selfHealLoop",
      "off",
      "disable",
      "Drain",
      "revert www",
      "revert worker",
    ]) {
      const at = line.indexOf(needle, from);
      expect(at, `"${needle}" after offset ${from}`).toBeGreaterThan(-1);
      from = at + needle.length;
    }
  });

  it("documents automations, autoLabel, optional protection, bulk-clean and pilot repo 2", () => {
    for (const needle of [
      "audit-fix",
      "includeAllAuthors",
      "reviewDraftPrs",
      "autoLabel",
      "OPTIONAL",
      "gate source",
      "automata/fix-",
      "Bulk-clean",
      "Pilot repo 2 exit criteria",
      "--expect-fix",
      "skill-push",
    ]) {
      expect(section, needle).toContain(needle);
    }
  });

  it("names no customer from the deny list", () => {
    const denied = ["ban", "gr"].join("");
    expect(section.toLowerCase()).not.toContain(denied);
    expect(section).not.toContain(["Admin", "Panel"].join("-"));
  });
});
