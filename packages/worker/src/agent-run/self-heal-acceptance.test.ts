import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Phase 8 audit-lane acceptance script (self-heal-acceptance.sh): contract
 * pins, fixture-driven tests of its sourceable analysers, and the runbook
 * pins. bash -n, shellcheck, the executable bit and strict mode are covered
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

  it("every gh api call is a paginated GET on an allowlisted issues endpoint", () => {
    const ghLines = code(script)
      .split("\n")
      .filter((l) => l.includes("gh api"));
    expect(ghLines.length).toBeGreaterThanOrEqual(3);
    for (const line of ghLines) {
      expect(line).toMatch(
        /gh api --paginate "repos\/\$repo\/issues(\/comments)?\?[^"]*"/,
      );
    }
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
          '  *) echo "unexpected gh call: $*" >&2; exit 1 ;;',
          "esac",
        ].join("\n"),
        { mode: 0o755 },
      );
    }

    function runGithub(issues: object[], comments: object[]) {
      return withFiles(
        {
          "issues.json": JSON.stringify(issues),
          "human.json": "[]",
          "comments.json": JSON.stringify(comments),
          "gh.log": "",
        },
        (p, dir) => {
          fakeGh(dir);
          const result = run(
            ["github", "--repo", "acme/web", "--since", SINCE, "--bot", BOT],
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
        },
      );
    }

    it("ends ACCEPTANCE: PASS on a clean repo and only issues paginated GETs", () => {
      const { result, log } = runGithub(
        [issue({ number: 1 })],
        [comment("fp-1", "r1")],
      );
      expect(result.stdout).toContain("ACCEPTANCE: PASS");
      expect(result.status).toBe(0);
      for (const line of log.trim().split("\n")) {
        expect(line).toMatch(/^api --paginate repos\/acme\/web\/issues/);
      }
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
