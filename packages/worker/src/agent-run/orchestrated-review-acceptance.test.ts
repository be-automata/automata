import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Phase 6 canary acceptance script (orchestrated-review-acceptance.sh): the
 * usage/guard/hardening pins plus fixture-driven tests of its sourceable
 * journal and GitHub analysers. bash -n and shellcheck are covered by
 * describeBashScriptHygiene in deploy-assets.test.ts. Pure local: no network,
 * no sudo, no box.
 */

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const repoRoot = path.resolve(workerRoot, "..", "..");
const scriptRel =
  "packages/worker/deploy/linux/orchestrated-review-acceptance.sh";
const scriptPath = path.join(repoRoot, scriptRel);
const exists = fs.existsSync(scriptPath);
const script = exists ? fs.readFileSync(scriptPath, "utf8") : "";
const isRoot = process.getuid?.() === 0;

/** Text from `name() {` to the next line that is exactly `}`. */
function fnBody(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {\n`);
  if (start === -1) throw new Error(`function ${name}() not found`);
  const end = source.indexOf("\n}\n", start + 1);
  if (end === -1) throw new Error(`function ${name}() is not closed`);
  return source.slice(start + 1, end + 2);
}

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

function run(args: string[]) {
  return spawnSync("/bin/bash", [scriptPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: minimalEnv(),
  });
}

/** Writes fixture files into a temp dir and runs `fn` with their paths. */
function withFiles<T>(
  files: Record<string, string>,
  fn: (paths: Record<string, string>) => T,
): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ora-"));
  try {
    const paths: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content);
      paths[name] = file;
    }
    return fn(paths);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Source the script and call one analyser; stdout+stderr + FAILURES=<n>. */
function callAnalyser(fn: string, args: string[], awk?: string): string {
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `source "$1"; shift; FAILURES=0; ${fn} "$@"; echo "FAILURES=$FAILURES"`,
      "sh",
      scriptPath,
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...minimalEnv(), ...(awk ? { AWK: awk } : {}) },
    },
  );
  return result.stdout + result.stderr;
}

describe("orchestrated-review-acceptance.sh (phase 6): contract", () => {
  it("exists (hygiene: describeBashScriptHygiene in deploy-assets.test.ts)", () => {
    expect(exists).toBe(true);
  });

  it.each<[string, string[], RegExp]>([
    ["no args", [], /usage/i],
    ["an unknown mode", ["deploy"], /usage/i],
    [
      "box without --since",
      ["box", "--repo", "a/b", "--pr", "1", "--expect", "classic"],
      /--since/,
    ],
    [
      "box without --repo",
      ["box", "--since", "now", "--pr", "1", "--expect", "classic"],
      /--repo/,
    ],
    [
      "box without --pr",
      ["box", "--since", "now", "--repo", "a/b", "--expect", "classic"],
      /--pr/,
    ],
    [
      "box without --expect",
      ["box", "--since", "now", "--repo", "a/b", "--pr", "1"],
      /--expect/,
    ],
    [
      "box with an unknown --expect",
      ["box", "--since", "now", "--repo", "a/b", "--pr", "1", "--expect", "x"],
      /--expect/,
    ],
    [
      "box with a malformed --repo",
      [
        "box",
        "--since",
        "now",
        "--repo",
        "a/b;id",
        "--pr",
        "1",
        "--expect",
        "classic",
      ],
      /--repo/,
    ],
    [
      "box with a non-numeric --pr",
      [
        "box",
        "--since",
        "now",
        "--repo",
        "a/b",
        "--pr",
        "1x",
        "--expect",
        "classic",
      ],
      /--pr/,
    ],
    [
      "box with control characters in --since",
      [
        "box",
        "--since",
        "now\u0007",
        "--repo",
        "a/b",
        "--pr",
        "1",
        "--expect",
        "classic",
      ],
      /--since/,
    ],
    [
      "github with a short --head-sha",
      [
        "github",
        "--repo",
        "a/b",
        "--pr",
        "1",
        "--head-sha",
        "abc",
        "--since",
        "2026-10-04T00:00:00Z",
        "--bot",
        "bot[bot]",
      ],
      /--head-sha/,
    ],
    [
      "github with a malformed --bot",
      [
        "github",
        "--repo",
        "a/b",
        "--pr",
        "1",
        "--head-sha",
        "a".repeat(40),
        "--since",
        "2026-10-04T00:00:00Z",
        "--bot",
        "bot;id",
      ],
      /--bot/,
    ],
    [
      "github with control characters in --since",
      [
        "github",
        "--repo",
        "a/b",
        "--pr",
        "1",
        "--head-sha",
        "a".repeat(40),
        "--since",
        "2026-10-04\u0001",
        "--bot",
        "bot[bot]",
      ],
      /--since/,
    ],
  ])("exits 2 on %s", (_name, args, message) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(message);
    expect(result.stdout).not.toContain("ACCEPTANCE:");
  });

  it.skipIf(isRoot)(
    "box refuses a non-root caller with exit 2 before reading anything",
    () => {
      const result = run([
        "box",
        "--since",
        "now",
        "--repo",
        "a/b",
        "--pr",
        "1",
        "--expect",
        "orchestrated",
      ]);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/root/);
      expect(result.stdout).toBe("");
    },
  );

  it("box checks uid 0 and Linux before the first box read", () => {
    const box = fnBody(script, "box_mode");
    const guard = box.indexOf('[ "$(id -u)" = "0" ]');
    const linux = box.indexOf('[ "$(uname -s)" = "Linux" ]');
    expect(guard).toBeGreaterThan(-1);
    expect(linux).toBeGreaterThan(-1);
    for (const read of ["manifest.sha256", "journalctl", "git_ro", "stat "]) {
      expect(box.indexOf(read), read).toBeGreaterThan(Math.max(guard, linux));
    }
  });

  it("every git call goes through ONE hardened helper", () => {
    const helper = fnBody(script, "git_ro");
    for (const token of [
      "-c safe.directory=",
      "-c core.fsmonitor=false",
      "-c core.hooksPath=/dev/null",
      "--no-pager",
      "export GIT_CONFIG_NOSYSTEM=1",
      "export GIT_CONFIG_GLOBAL=/dev/null",
      "unset GIT_DIR GIT_WORK_TREE GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT",
    ]) {
      expect(helper, token).toContain(token);
    }
    const rest = code(script.replace(helper, ""));
    expect(rest).not.toMatch(/(^|[\s;&|(`$])git\s/m);
  });

  it("is read-only: no restarts, installs, git writes or schema pushes", () => {
    const c = code(script);
    expect(c).not.toMatch(/systemctl\s+(restart|stop|start)/);
    expect(c).not.toMatch(/install-batteries\.sh/);
    expect(c).not.toMatch(/rm -rf \//);
    expect(c).not.toMatch(
      /\bgit(_ro)?\s+(fetch|merge|pull|push|commit|checkout|switch|reset)\b/,
    );
    expect(c).not.toMatch(/drizzle/);
    expect(c).not.toMatch(/\b(chmod|chown)\b/);
    expect(c).toContain('WORK="$(mktemp -d');
    expect(c).toContain("trap cleanup EXIT");
  });

  it("every gh api call is a GET on the four allowlisted PR endpoints", () => {
    const ghLines = code(script)
      .split("\n")
      .filter((l) => l.includes("gh api"));
    expect(ghLines).toHaveLength(4);
    for (const line of ghLines) {
      expect(line).toMatch(
        /^\s*gh api --paginate "repos\/\$repo\/(pulls\/\$pr(\/reviews|\/comments)?|issues\/\$pr\/comments)"( >| \|)/,
      );
    }
    const c = code(script);
    for (const flag of [
      "--field",
      "--raw-field",
      " -f ",
      " -F ",
      " -X",
      "--method",
    ]) {
      expect(c, flag).not.toContain(flag);
    }
  });

  it("stays bash 3.2 and POSIX awk compatible", () => {
    const c = code(script);
    for (const token of [
      "declare -A",
      "mapfile",
      "readarray",
      "asort",
      "gensub",
      ",,}",
      "^^}",
    ]) {
      expect(c, token).not.toContain(token);
    }
    expect(c).not.toMatch(/match\([^()]*,[^()]*,[^()]*\)/);
    expect(c).toContain("${AWK:-awk}");
  });

  it("names no customer (public repo)", () => {
    expect(script).not.toMatch(/bangr/i);
  });

  it("box mode checks the install, the gsd agent file and the journal", () => {
    const box = fnBody(script, "box_mode");
    for (const token of [
      "manifest.sha256",
      "manifest.sha256.invalid",
      "cat-file blob HEAD:packages/worker/deploy/batteries.json",
      "gsd-reviewers",
      "agents/gsd-code-reviewer.md",
      "stat -c",
      "journalctl -u automata-worker.service",
      "--no-pager -o short-unix",
      "analyse_review_journal",
    ]) {
      expect(box, token).toContain(token);
    }
  });

  it("prints the manual transcript checklist for both expectations", () => {
    for (const token of [
      "EVIDENCE manual",
      "Agent/Task and Skill",
      "gstack-review and security-audit",
      "gsd-code-reviewer and gsd-security-auditor",
      "06-04 Task 2",
      "parent_tool_use_id",
      "shellcheck/actionlint/gitleaks",
      "json review-intent",
      "## Orchestrated review — you are the lead reviewer",
      'reviewPromptMode "orchestrated"',
      "holding result until exit",
      "REVIEW_POLICY_JOINED",
    ]) {
      expect(script, token).toContain(token);
    }
    expect(script).toContain('echo "ACCEPTANCE: PASS"');
    expect(script).toContain('echo "ACCEPTANCE: FAIL ($FAILURES)"');
  });

  it("local mode runs the phase gates", () => {
    const local = fnBody(script, "local_mode");
    for (const token of [
      "pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/server-lib",
      "git_ro diff --exit-code origin/main -- apps/www/src/server-lib/review/skill-contract-drift.test.ts",
      "NODE_OPTIONS=--max-old-space-size=12288",
      "src/agent-run/orchestrated-review-acceptance.test.ts",
    ]) {
      expect(local, token).toContain(token);
    }
  });

  it("keeps the CHECK names stable", () => {
    for (const name of [
      "SC2 one review run per push",
      "SC2 orchestrated batteries seeded",
      "SC2 orchestrated wire stamped",
      "SC2 latency within budget",
      "SC3 classic run",
      "SC2 exactly one review on head",
      "SC2 zero bot comments",
      "SC2 zero commits from the run",
      "SC2 review latency within budget",
      "box install manifest",
      "box gsd agent file",
    ]) {
      expect(script, name).toContain(name);
    }
  });
});

describe("analyse_review_journal (sourced, fixture journal)", () => {
  const PREFIX = "0123456789ab";
  const T0 = 1759550000;
  const REPO = "o/r";

  const line = (offset: number, tid: string, msg: string) =>
    `${T0 + offset}.123456 box node[42]: [agent-run ${tid}] ${msg}`;
  const start = (tid: string, pr = 7, repo = REPO, lane = "review") =>
    line(
      0,
      tid,
      `run start: lane=${lane} pr=${pr} repo=${repo} branch=f policy=newest-wins`,
    );
  const ORCH_BATT = `batteries: mode=orchestrated packs=gstack-review,somnio-review,gsd-reviewers manifest=${PREFIX}`;
  const AGENT_LINE =
    "review agent: orchestrated → daemon (bashTimeoutMs=300000, maxTurns=unset)";

  const orchestratedRun = (
    tid: string,
    { batt = ORCH_BATT, agent = AGENT_LINE as string | null, span = 600 } = {},
  ) =>
    [
      start(tid),
      line(5, tid, batt),
      ...(agent ? [line(6, tid, agent)] : []),
      line(span, tid, "run finished: complete"),
    ].join("\n");

  function analyse(journal: string, expectMode: string, awk?: string) {
    return withFiles({ "journal.txt": `${journal}\n` }, (p) =>
      callAnalyser(
        "analyse_review_journal",
        [p["journal.txt"]!, REPO, "7", expectMode, PREFIX],
        awk,
      ),
    );
  }

  const checkLine = (out: string, name: string) =>
    out.split("\n").find((l) => l.startsWith(`CHECK ${name}:`)) ?? "";

  it("orchestrated-ok: every CHECK passes, with the judged values as EVIDENCE", () => {
    const out = analyse(orchestratedRun("thr_1"), "orchestrated");
    expect(out).toContain("FAILURES=0");
    expect(checkLine(out, "SC2 one review run per push")).toContain("PASS");
    expect(checkLine(out, "SC2 orchestrated batteries seeded")).toContain(
      "PASS",
    );
    expect(checkLine(out, "SC2 orchestrated wire stamped")).toContain("PASS");
    expect(checkLine(out, "SC2 latency within budget")).toContain("PASS");
    expect(out).toContain("EVIDENCE review thread: thr_1");
    expect(out).toContain(`EVIDENCE review batteries line: ${ORCH_BATT}`);
    expect(out).toContain(`EVIDENCE review agent line: ${AGENT_LINE}`);
    expect(out).toContain("EVIDENCE review journal span seconds: 600");
  });

  it("two distinct threads for the same repo/pr fail one-review-per-push", () => {
    const out = analyse(
      `${orchestratedRun("thr_1")}\n${orchestratedRun("thr_2")}`,
      "orchestrated",
    );
    expect(checkLine(out, "SC2 one review run per push")).toContain("FAIL");
    expect(out).not.toContain("FAILURES=0");
  });

  it.each<[string, string, RegExp]>([
    ["classic batteries", "batteries: mode=classic", /FAIL/],
    [
      "packs=none",
      `batteries: mode=orchestrated packs=none manifest=${PREFIX}`,
      /FAIL/,
    ],
    [
      "a manifest mismatch",
      "batteries: mode=orchestrated packs=gstack-review manifest=ffffffffffff",
      /FAIL/,
    ],
    [
      "unavailable batteries",
      "batteries: unavailable mode=orchestrated reason=manifest-drift",
      /FAIL .*manifest-drift/,
    ],
  ])("orchestrated expected but %s fails seeding", (_name, batt, verdict) => {
    const out = analyse(orchestratedRun("thr_1", { batt }), "orchestrated");
    expect(checkLine(out, "SC2 orchestrated batteries seeded")).toMatch(
      verdict,
    );
    expect(out).not.toContain("FAILURES=0");
  });

  it("orchestrated expected but no review-agent line fails the wire check", () => {
    const out = analyse(
      orchestratedRun("thr_1", { agent: null }),
      "orchestrated",
    );
    expect(checkLine(out, "SC2 orchestrated wire stamped")).toContain("FAIL");
  });

  it("a bounds-rejected line fails the wire check", () => {
    const out = analyse(
      orchestratedRun("thr_1", {
        agent: "review agent: bounds-rejected (maxTurns 0) → classic",
      }),
      "orchestrated",
    );
    expect(checkLine(out, "SC2 orchestrated wire stamped")).toContain("FAIL");
  });

  it("classic-ok passes; classic with an orchestrated wire line fails", () => {
    const classic = [
      start("thr_c"),
      line(5, "thr_c", "batteries: mode=classic"),
      line(300, "thr_c", "run finished: complete"),
    ].join("\n");
    const ok = analyse(classic, "classic");
    expect(ok).toContain("FAILURES=0");
    expect(checkLine(ok, "SC3 classic run")).toContain("PASS");
    const bad = analyse(
      `${classic}\n${line(6, "thr_c", AGENT_LINE)}`,
      "classic",
    );
    expect(checkLine(bad, "SC3 classic run")).toContain("FAIL");
  });

  it("a 1900 s span fails the latency budget", () => {
    const out = analyse(
      orchestratedRun("thr_1", { span: 1900 }),
      "orchestrated",
    );
    expect(checkLine(out, "SC2 latency within budget")).toContain("FAIL");
  });

  it("other repos, other PRs and task lanes are ignored; no match fails", () => {
    const noise = [
      start("thr_other_repo", 7, "o/x"),
      line(5, "thr_other_repo", ORCH_BATT),
      start("thr_other_pr", 8),
      start("thr_task", 7, REPO, "task"),
      line(
        5,
        "thr_task",
        `batteries: lane=task packs=somnio-skills manifest=${PREFIX}`,
      ),
    ].join("\n");
    const withRun = analyse(
      `${noise}\n${orchestratedRun("thr_1")}`,
      "orchestrated",
    );
    expect(withRun).toContain("FAILURES=0");
    const none = analyse(noise, "orchestrated");
    expect(checkLine(none, "SC2 one review run per push")).toContain(
      "FAIL (no lane=review run for o/r pr=7 since --since)",
    );
    expect(none).not.toContain("FAILURES=0");
  });

  it("a trace suffix on the agent-run token is stripped", () => {
    const traced = orchestratedRun("thr_1").replaceAll(
      "[agent-run thr_1]",
      "[agent-run thr_1 trace=00-a-b-01]",
    );
    const out = analyse(traced, "orchestrated");
    expect(out).toContain("FAILURES=0");
    expect(out).toContain("EVIDENCE review thread: thr_1");
  });

  /**
   * Alternate awks the box or CI may run: Ubuntu's default awk is mawk, and
   * BWK ("one true awk") is macOS /usr/bin/awk and Debian's original-awk.
   * Values are passed to the script verbatim as AWK, including the
   * multi-word `busybox awk` (the script splits AWK into an argv).
   */
  function alternateAwks(): string[] {
    const found: string[] = [];
    const runs = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
    if (runs("mawk", ["-W", "version"])) found.push("mawk");
    if (runs("busybox", ["awk", "BEGIN{}"])) found.push("busybox awk");
    if (runs("original-awk", ["BEGIN{}"])) found.push("original-awk");
    const macAwk = spawnSync("/usr/bin/awk", ["--version"], {
      encoding: "utf8",
    });
    if (macAwk.status === 0 && /^awk version \d+/.test(macAwk.stdout)) {
      found.push("/usr/bin/awk");
    }
    return found;
  }

  it('accepts a multi-word AWK (the CI regression: AWK="busybox awk")', () => {
    const out = analyse(orchestratedRun("thr_1"), "orchestrated", "env awk");
    expect(out).not.toMatch(/not found/);
    expect(out).toContain("FAILURES=0");
  });

  it("re-runs the journal fixtures under mawk, busybox awk and BWK awk when installed", (ctx) => {
    const alternates = alternateAwks();
    if (alternates.length === 0) ctx.skip();
    const classic = [
      start("thr_c"),
      line(5, "thr_c", "batteries: mode=classic"),
      line(300, "thr_c", "run finished: complete"),
    ].join("\n");
    const traced = orchestratedRun("thr_1").replaceAll(
      "[agent-run thr_1]",
      "[agent-run thr_1 trace=00-a-b-01]",
    );
    for (const name of alternates) {
      const pass: Array<[string, string, string]> = [
        ["orchestrated-ok", orchestratedRun("thr_1"), "orchestrated"],
        ["classic-ok", classic, "classic"],
        ["trace suffix", traced, "orchestrated"],
      ];
      for (const [fixture, journal, mode] of pass) {
        const out = analyse(journal, mode, name);
        expect(out, `${name}: ${fixture}`).not.toMatch(/not found/);
        expect(out, `${name}: ${fixture}`).toContain("FAILURES=0");
        expect(out, `${name}: ${fixture}`).toContain("EVIDENCE review thread:");
      }
      const fail: Array<[string, string, string, string]> = [
        [
          "two threads",
          `${orchestratedRun("thr_1")}\n${orchestratedRun("thr_2")}`,
          "SC2 one review run per push",
          "FAIL (2 review runs: thr_1 thr_2)",
        ],
        [
          "unavailable batteries",
          orchestratedRun("thr_1", {
            batt: "batteries: unavailable mode=orchestrated reason=manifest-drift",
          }),
          "SC2 orchestrated batteries seeded",
          "FAIL (unavailable: reason=manifest-drift)",
        ],
        [
          "span 1900 s",
          orchestratedRun("thr_1", { span: 1900 }),
          "SC2 latency within budget",
          "FAIL (1900s",
        ],
      ];
      for (const [fixture, journal, check, verdict] of fail) {
        const out = analyse(journal, "orchestrated", name);
        expect(checkLine(out, check), `${name}: ${fixture}`).toContain(verdict);
      }
    }
  });
});

describe("analyse_github (sourced, fixture JSON)", () => {
  const HEAD = "a".repeat(40);
  const SINCE = 1759550000;
  const BOT = "automata-ai-bot[bot]";
  const iso = (offset: number) =>
    new Date((SINCE + offset) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

  const review = (over: Record<string, unknown> = {}) => ({
    id: 101,
    user: { login: BOT },
    commit_id: HEAD,
    state: "CHANGES_REQUESTED",
    submitted_at: iso(900),
    ...over,
  });

  function analyse({
    head = HEAD,
    reviews = [review()] as unknown[],
    issueComments = [] as unknown[],
    reviewComments = [] as unknown[],
  } = {}) {
    return withFiles(
      {
        "pull.json": JSON.stringify({ head: { sha: head } }),
        "reviews.json": JSON.stringify(reviews),
        "issue_comments.json": JSON.stringify(issueComments),
        "review_comments.json": JSON.stringify(reviewComments),
      },
      (p) =>
        callAnalyser("analyse_github", [
          p["pull.json"]!,
          p["reviews.json"]!,
          p["issue_comments.json"]!,
          p["review_comments.json"]!,
          HEAD,
          String(SINCE),
          BOT,
        ]),
    );
  }

  it("ok: one bot review on head, no bot comments, head unchanged", () => {
    const out = analyse({
      reviews: [review(), review({ id: 7, user: { login: "human" } })],
      issueComments: [
        { user: { login: BOT }, created_at: iso(-60) },
        { user: { login: "human" }, created_at: iso(60) },
      ],
      reviewComments: [
        {
          user: { login: BOT },
          created_at: iso(900),
          pull_request_review_id: 101,
        },
      ],
    });
    expect(out).toContain("FAILURES=0");
    expect(out).toContain("EVIDENCE review id: 101");
    expect(out).toContain("EVIDENCE review state: CHANGES_REQUESTED");
    expect(out).toContain(`EVIDENCE review submitted_at: ${iso(900)}`);
    expect(out).toContain("EVIDENCE review latency seconds: 900");
  });

  it.each<[string, Parameters<typeof analyse>[0]]>([
    ["two bot reviews on head", { reviews: [review(), review({ id: 102 })] }],
    ["zero bot reviews on head", { reviews: [] }],
    [
      "a bot issue comment after since",
      { issueComments: [{ user: { login: BOT }, created_at: iso(30) }] },
    ],
    [
      "a bot review comment from another review",
      {
        reviewComments: [
          {
            user: { login: BOT },
            created_at: iso(900),
            pull_request_review_id: 999,
          },
        ],
      },
    ],
    ["a moved PR head", { head: "b".repeat(40) }],
    ["a 2000 s latency", { reviews: [review({ submitted_at: iso(2000) })] }],
  ])("fails on %s", (_name, fixture) => {
    expect(analyse(fixture)).not.toContain("FAILURES=0");
  });
});

describe("runbook (phase 6)", () => {
  const runbook = fs.readFileSync(
    path.join(repoRoot, "deploy", "PILOT-RUNBOOK.md"),
    "utf8",
  );
  const HEADING = "## Orchestrated review canary (phase 6)";
  const PHASE7 = "## Task-run batteries and the Somnio CLI (phase 7)";
  const start = runbook.indexOf(HEADING);
  const next = runbook.indexOf("\n## ", start + HEADING.length);
  const section = runbook.slice(start, next === -1 ? undefined : next);

  it("has the section exactly once, after the phase 7 section", () => {
    expect(runbook.split(HEADING).length - 1).toBe(1);
    expect(runbook.indexOf(PHASE7)).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(runbook.indexOf(PHASE7));
  });

  it("takes the root-owned script copy from the verified HEAD, never mid-review", () => {
    for (const phrase of [
      "merge --ff-only",
      "ls-remote",
      "cat-file blob",
      "Never mid-review",
    ]) {
      expect(section, phrase).toContain(phrase);
    }
  });

  it("names both acceptance angles, the flip-back and the push-only trigger", () => {
    for (const phrase of [
      "orchestrated-review-acceptance.sh box",
      "orchestrated-review-acceptance.sh github",
      "--expect classic",
      "never a bot mention",
      "seed-pilot-mirror.ts",
      "skill-push.ts",
      "--dry-run",
      "always revert the skill version first, then roll back www",
    ]) {
      expect(section, phrase).toContain(phrase);
    }
  });

  it("orders the www deploy before the skill push", () => {
    const deploy = section.indexOf("www deploy");
    expect(deploy).toBeGreaterThan(-1);
    expect(deploy).toBeLessThan(section.indexOf("skill-push.ts"));
  });

  it("names no customer (public repo)", () => {
    expect(section).not.toMatch(/bangr/i);
  });
});
