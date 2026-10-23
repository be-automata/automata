import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  abnormalEndInfo,
  salvageCommitMessage,
  salvageWorkBranch,
  type SalvageWorkBranchArgs,
} from "./abnormal-end";
import {
  runAsAgent,
  type AgentCommandResult,
  type RunAsAgent,
} from "./agent-command";

/**
 * #437 Part B against REAL git: a temp checkout with a bare "GitHub" remote.
 * The broker handoff's gitUrl is a file:// root, so the salvage's push goes
 * through the very `url.<broker>/.insteadOf https://github.com/` rewrite the
 * agent's git uses (brokeredGitAuthConfig) and lands in the bare repo —
 * without the rewrite it would try the real github.com and fail.
 */

const BOT = "automata-ai-bot[bot]";
const BEARER = "BEARER_SENTINEL_9f3c1d";
const WORK_BRANCH = "automata/task-123";
const LIMIT_MS = 30 * 60_000;
const SALVAGE_MESSAGE = "wip: run timed out at 30m (automata salvage)";

/** Test-side git, isolated from the machine's own config. */
const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Agent",
  GIT_AUTHOR_EMAIL: "agent@example.com",
  GIT_COMMITTER_NAME: "Agent",
  GIT_COMMITTER_EMAIL: "agent@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" })
    .toString()
    .trim();
}

/** The fixture, built once and copied per test. */
let template: string;
let root: string;
let remotes: string;
let bare: string;
let work: string;
let logs: string[];

function layout(dir: string) {
  const r = path.join(dir, "remotes");
  return {
    remotes: r,
    bare: path.join(r, "o", "r.git"),
    work: path.join(dir, "repo"),
  };
}

/** The bare remote's refs as `<ref> <sha>` lines. */
function remoteRefs(): Map<string, string> {
  const out = git(bare, "for-each-ref", "--format=%(refname) %(objectname)");
  return new Map(
    out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ") as [string, string]),
  );
}

/** Push `ref` to the bare remote and record it as origin/<ref>, as a fetch would. */
function publish(ref: string): void {
  git(work, "push", "--quiet", bare, `HEAD:refs/heads/${ref}`);
  git(work, "update-ref", `refs/remotes/origin/${ref}`, "HEAD");
}

/** A commit the agent made itself (and never pushed); returns its sha. */
function agentCommit(file: string, message: string): string {
  fs.writeFileSync(path.join(work, file), `// ${message}\n`);
  git(work, "add", file);
  git(work, "commit", "--quiet", "-m", message);
  return git(work, "rev-parse", "HEAD");
}

function args(
  over: Partial<SalvageWorkBranchArgs> = {},
): SalvageWorkBranchArgs {
  return {
    cause: "timeout",
    workBranch: WORK_BRANCH,
    lockLost: false,
    enabled: true,
    containerRun: false,
    broker: { gitUrl: `file://${remotes}`, bearer: BEARER },
    repoFullName: "o/r",
    workdir: work,
    agentUser: "",
    botLogin: BOT,
    egressProxyUrl: null,
    runExecutionTimeoutMs: LIMIT_MS,
    log: (line) => logs.push(line),
    ...over,
  };
}

/** The salvage's result alone (most cases assert on it and the log). */
async function salvage(over: Partial<SalvageWorkBranchArgs> = {}) {
  return (await salvageWorkBranch(args(over))).result;
}

beforeAll(() => {
  template = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "salvage-fixture-")),
  );
  const t = layout(template);
  fs.mkdirSync(t.bare, { recursive: true });
  git(t.bare, "init", "--quiet", "--bare");
  fs.mkdirSync(t.work);
  git(t.work, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(t.work, "README.md"), "hello\n");
  git(t.work, "add", "README.md");
  git(t.work, "commit", "--quiet", "-m", "base");
  // The clone's shape: origin is GitHub, origin/main is the base.
  git(t.work, "remote", "add", "origin", "https://github.com/o/r.git");
  git(t.work, "push", "--quiet", t.bare, "HEAD:refs/heads/main");
  git(t.work, "update-ref", "refs/remotes/origin/main", "HEAD");
  // provisionWorkdir: the work branch, cut from the cloned HEAD.
  git(t.work, "checkout", "--quiet", "-b", WORK_BRANCH);
});

afterAll(() => {
  fs.rmSync(template, { recursive: true, force: true });
});

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "salvage-")));
  fs.cpSync(template, root, { recursive: true });
  ({ remotes, bare, work } = layout(root));
  logs = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("salvageWorkBranch (#437 Part B) against a real git checkout", () => {
  it("a dirty tree is committed once with the bot identity and pushed to the work branch (AC2)", async () => {
    // protects=AC2: uncommitted (tracked AND untracked) work lands as ONE
    // salvage commit on the work branch on the remote; fails_when=nothing is
    // pushed, the message/identity differ, an untracked file is left out, or
    // the log line is not `pushed <sha8> to <branch>`; no_claim=GitHub and
    // the real git broker (a bare repo behind the same insteadOf rewrite
    // stands in), and running as a separate agent uid (agentUser "").
    fs.writeFileSync(path.join(work, "README.md"), "hello, edited\n");
    fs.writeFileSync(path.join(work, "new.ts"), "export {};\n");

    const outcome = await salvageWorkBranch(args());

    const head = git(work, "rev-parse", "HEAD");
    expect(outcome).toEqual({
      result: { branch: WORK_BRANCH, sha: head },
      spawned: true,
    });
    expect(remoteRefs().get(`refs/heads/${WORK_BRANCH}`)).toBe(head);
    expect(git(bare, "log", "-1", "--format=%s", head)).toBe(SALVAGE_MESSAGE);
    expect(salvageCommitMessage(LIMIT_MS)).toBe(SALVAGE_MESSAGE);
    expect(git(bare, "log", "-1", "--format=%an <%ae>|%cn", head)).toBe(
      `${BOT} <${BOT}@users.noreply.github.com>|${BOT}`,
    );
    expect(git(bare, "rev-list", "--count", `main..${head}`)).toBe("1");
    expect(git(bare, "ls-tree", "--name-only", head).split("\n")).toEqual([
      "README.md",
      "new.ts",
    ]);
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(logs).toEqual([
      `salvage: pushed ${head.slice(0, 8)} to ${WORK_BRANCH}`,
    ]);
  });

  it("a clean tree with commits the agent never pushed is pushed without a new commit (AC3)", async () => {
    // protects=AC3; fails_when=a salvage commit is added on a clean tree or
    // the agent's local commits stay unpushed; no_claim=none beyond protects
    // (same stand-ins as AC2).
    const agentHead = agentCommit("a.ts", "agent: first part");

    expect(await salvage()).toEqual({ branch: WORK_BRANCH, sha: agentHead });
    expect(git(work, "rev-parse", "HEAD")).toBe(agentHead);
    expect(remoteRefs().get(`refs/heads/${WORK_BRANCH}`)).toBe(agentHead);
    expect(git(bare, "log", "-1", "--format=%s", agentHead)).toBe(
      "agent: first part",
    );
    expect(logs).toEqual([
      `salvage: pushed ${agentHead.slice(0, 8)} to ${WORK_BRANCH}`,
    ]);
  });

  it("a clean tree on a work branch the remote has never seen is pushed (remote ref absent)", async () => {
    // protects=AC3's "or that remote ref does not exist" half; fails_when=a
    // work branch that never reached the remote is left unpushed;
    // no_claim=none beyond protects.
    const agentHead = agentCommit("b.ts", "agent: b");
    expect(remoteRefs().has(`refs/heads/${WORK_BRANCH}`)).toBe(false);

    expect((await salvage())?.sha).toBe(agentHead);
    expect(remoteRefs().get(`refs/heads/${WORK_BRANCH}`)).toBe(agentHead);
  });

  it("a clean tree with nothing unpushed pushes nothing (AC4)", async () => {
    // protects=AC4 in both shapes: the work branch already on the remote at
    // HEAD, and a fresh work branch never committed to (an empty copy of the
    // base is not "work"); fails_when=anything is committed or pushed, or the
    // line is not `nothing to save`; no_claim=none beyond protects.
    const before = remoteRefs();
    expect(await salvage()).toBeNull();
    expect(remoteRefs()).toEqual(before);
    expect(logs).toEqual(["salvage: nothing to save"]);

    const head = agentCommit("c.ts", "agent: c");
    publish(WORK_BRANCH);
    const pushed = remoteRefs();
    logs = [];

    expect(await salvage()).toBeNull();
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
    expect(remoteRefs()).toEqual(pushed);
    expect(logs).toEqual(["salvage: nothing to save"]);
  });

  it("a push that fails is logged with a credential-free reason and never throws (AC5)", async () => {
    // protects=AC5 (the run still posts timeout and releases the lock — the
    // workflow tests pin that) and AC12 for the failure text; fails_when=the
    // salvage throws, the reason carries the remote URL, the bearer or git's
    // stderr, or more than one line is logged; no_claim=a network failure
    // specifically (a missing remote stands in for any push refusal).
    fs.writeFileSync(path.join(work, "d.ts"), "export const d = 4;\n");
    const missing = path.join(root, "no-such-remotes");

    const result = await salvage({
      broker: { gitUrl: `file://${missing}`, bearer: BEARER },
    });

    expect(result).toBeNull();
    expect(logs).toEqual(["salvage: failed (push failed (exit 128))"]);
    // The commit itself still happened: a later look at the checkout (it is
    // deleted right after) would find it, but nothing claims it was saved.
    expect(git(work, "log", "-1", "--format=%s")).toBe(SALVAGE_MESSAGE);
  });

  it("a step whose runner never settles (stdio held under sudo) still ends at the budget (job 808)", async () => {
    // protects=job 808 finding 1: a SIGKILLed sudo whose git still holds the
    // stdout pipe never resolves runAsAgent, and the teardown (post, lock
    // release) must not wait on it; fails_when=the salvage waits for the
    // runner, throws, or reports spawned=false (the workflow's second reap
    // keys on it); no_claim=the reap itself (workflow-cleanup tests) — the
    // runner here ignores its signal and never settles.
    const run: RunAsAgent = () => new Promise<AgentCommandResult>(() => {});
    const budgetMs = 100;
    const t0 = Date.now();

    const outcome = await salvageWorkBranch(args({ run, budgetMs }));

    // Budget + timer slack on a loaded box.
    expect(Date.now() - t0).toBeLessThan(budgetMs + 250);
    expect(outcome).toEqual({ result: null, spawned: true });
    expect(logs).toEqual(["salvage: failed (budget exceeded)"]);
  }, 5_000);

  it("a push that outlives the budget is cut off by the budget's own signal and logged, never thrown", async () => {
    // protects=the hard budget on a fresh signal: a hung push cannot hold the
    // teardown (and the box lock) past it; fails_when=the salvage waits for
    // the hung step, throws, or logs anything but `failed (budget
    // exceeded)`; no_claim=the 60 s value (50 ms stands in) and runAsAgent's
    // kill on abort (agent-command tests) — every step here is a fake whose
    // push resolves only when the budget signal aborts.
    const ok = (stdout = "", exitCode = 0): AgentCommandResult => ({
      exitCode,
      stdout,
      timedOut: false,
      truncated: false,
    });
    let pushSignal: AbortSignal | undefined;
    const run: RunAsAgent = async (a) => {
      if (a.script.includes("git push")) {
        pushSignal = a.signal;
        return new Promise((resolve) =>
          a.signal?.addEventListener("abort", () => resolve(ok("", -1)), {
            once: true,
          }),
        );
      }
      if (a.script.includes("git log --format=")) return ok("src/a.ts\0");
      if (a.script.includes("diff --cached")) return ok("", 1);
      if (a.script.includes("rev-list")) return ok(`${"a".repeat(40)}\n`);
      return ok();
    };
    const t0 = Date.now();

    expect(await salvage({ run, budgetMs: 50 })).toBeNull();

    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(pushSignal?.aborted).toBe(true);
    expect(logs).toEqual(["salvage: failed (budget exceeded)"]);
  });

  it("only the work branch is ever pushed, whatever the agent wrote into .git/config", async () => {
    // protects="never push any other ref": no tag, no other branch, no
    // matching push, and origin's URL decides nothing — with only keys the
    // config guard ALLOWS (a remote.origin.push refspec is refused by the
    // guard, see the F1/F2 describe); fails_when=the remote gains any ref but
    // refs/heads/<workBranch>, or the push follows origin's URL;
    // no_claim=a --force (never passed; the refspec has no +).
    git(work, "config", "push.followTags", "true");
    git(work, "config", "push.default", "matching");
    // An agent-redirected origin must not receive the push.
    const decoy = path.join(root, "decoy.git");
    fs.mkdirSync(decoy);
    git(decoy, "init", "--quiet", "--bare");
    git(work, "remote", "set-url", "origin", decoy);
    git(work, "checkout", "--quiet", "-b", "other");
    agentCommit("other.ts", "other branch");
    git(work, "tag", "-a", "v9", "-m", "a tag");
    git(work, "checkout", "--quiet", WORK_BRANCH);
    fs.writeFileSync(path.join(work, "g.ts"), "export {};\n");
    git(work, "tag", "-a", "v10", "-m", "tag on HEAD's parent");

    expect(await salvage()).not.toBeNull();
    expect([...remoteRefs().keys()].sort()).toEqual(
      ["refs/heads/main", `refs/heads/${WORK_BRANCH}`].sort(),
    );
    expect(git(decoy, "for-each-ref")).toBe("");
  });

  it("no log line of a run that reached git carries the bearer, the auth header or the broker URL (AC12)", async () => {
    // protects=AC12 for Part B's journal lines; fails_when=a pushed or failed
    // line holds the per-run bearer, an Authorization header or the broker
    // URL; no_claim=the skip lines (constant text, pinned by the gating
    // table) and the persisted terminal info (branch + sha only, see
    // abnormalEndInfo below).
    const runs: Array<Partial<SalvageWorkBranchArgs>> = [
      {},
      { broker: { gitUrl: `file://${root}/missing`, bearer: BEARER } },
    ];
    for (const over of runs) {
      fs.writeFileSync(path.join(work, "h.ts"), `// ${Math.random()}\n`);
      await salvage(over);
    }
    expect(logs).toHaveLength(runs.length);
    for (const line of logs) {
      expect(line).not.toContain(BEARER);
      expect(line.toLowerCase()).not.toContain("authorization");
      expect(line).not.toContain(root);
      expect(line).toMatch(
        /^salvage: (pushed [0-9a-f]{8} to \S+|failed \(.+\))$/,
      );
    }
  });
});

describe("salvageWorkBranch gating (#437 Part B)", () => {
  it.each([
    [{ enabled: false }, "salvage: skipped (disabled)"],
    [{ workBranch: undefined }, "salvage: skipped (no work branch)"],
    // AC6: another run may own the box once the lock is lost.
    [{ lockLost: true }, "salvage: skipped (lock lost)"],
    [{ containerRun: true }, "salvage: skipped (container run)"],
    [{ broker: null }, "salvage: skipped (no git broker)"],
  ] as const)(
    "%j logs one skip line, runs no git and leaves the tree as it was",
    async (over, line) => {
      // protects=WORKER_TIMEOUT_SALVAGE=off, a run with no work branch, a
      // lost box lock (AC6), the container path (no broker route until C3)
      // and a legacy-direct box (no second auth path) each skip with their
      // reason; fails_when=git runs, anything is committed or pushed, or the
      // line differs; no_claim=the workflow passing these values
      // (workflow-cleanup tests).
      fs.writeFileSync(path.join(work, "f.ts"), "export const f = 6;\n");
      const run = vi.fn(runAsAgent);

      expect(await salvageWorkBranch(args({ ...over, run }))).toEqual({
        result: null,
        spawned: false,
      });

      expect(run).not.toHaveBeenCalled();
      expect(logs).toEqual([line]);
      expect(git(work, "status", "--porcelain")).toBe("?? f.ts");
      expect(remoteRefs().has(`refs/heads/${WORK_BRANCH}`)).toBe(false);
    },
  );

  it("any cause but timeout is silent and touches nothing", async () => {
    // protects=out-of-memory/daemon-failed/run-failed-unreported keep PR 1's
    // behaviour; fails_when=a non-timeout end salvages or logs a salvage
    // line; no_claim=none beyond protects.
    const run = vi.fn(runAsAgent);
    for (const cause of [
      "out-of-memory",
      "daemon-failed",
      "run-failed-unreported",
    ] as const) {
      expect(await salvageWorkBranch(args({ cause, run }))).toEqual({
        result: null,
        spawned: false,
      });
    }
    expect(run).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });
});

describe("abnormalEndInfo with a salvage (#437 Part B)", () => {
  const LIMIT = { runExecutionTimeoutMs: LIMIT_MS, starvation: null };
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("names the branch and the short sha; without a salvage the limit line stays", () => {
    // protects=AC2's thread text and the PR 1 line when nothing was saved;
    // fails_when=the info misses the branch/sha8 or a salvage-less timeout
    // changes text; no_claim=www storing it (route tests).
    expect(
      abnormalEndInfo("timeout", {
        ...LIMIT,
        salvage: { branch: WORK_BRANCH, sha: SHA },
      }),
    ).toBe(
      `Unfinished work was saved to branch ${WORK_BRANCH} (commit 01234567).`,
    );
    expect(abnormalEndInfo("timeout", { ...LIMIT, salvage: null })).toBe(
      "The run reached its 30-minute limit.",
    );
  });

  it("falls back to the limit line when the branch would push the info past 300 chars", () => {
    // protects=the post itself: www 400s an info over 300 chars and the run
    // would get no typed terminal; fails_when=an over-long info is sent;
    // no_claim=none beyond protects.
    expect(
      abnormalEndInfo("timeout", {
        ...LIMIT,
        salvage: { branch: "b".repeat(280), sha: SHA },
      }),
    ).toBe("The run reached its 30-minute limit.");
  });
});

/**
 * Security review of the salvage (F1/F2): the checkout's .git is the agent's,
 * written while it ran. Every case plants config a hostile agent could, then
 * runs the real salvage against real git.
 */
describe("salvageWorkBranch refuses an agent-steered checkout (#437 review F1/F2)", () => {
  let decoy: string;

  beforeEach(() => {
    decoy = path.join(root, "decoy.git");
    fs.mkdirSync(decoy);
    git(decoy, "init", "--quiet", "--bare");
    // Dirty, so a salvage that proceeds would commit and push.
    fs.writeFileSync(path.join(work, "wip.ts"), "export const wip = 1;\n");
  });

  it.each([
    {
      name: "url.<decoy>.pushInsteadOf",
      entry: (): [string, string] => [
        `url.${decoy}.pushInsteadOf`,
        "https://github.com/o/r.git",
      ],
      nestedDecoy: false,
    },
    {
      name: "remote.<url>.pushurl",
      entry: (): [string, string] => [
        "remote.https://github.com/o/r.git.pushurl",
        decoy,
      ],
      nestedDecoy: false,
    },
    {
      // Longer than the broker's `https://github.com/`, so it wins the
      // rewrite; the decoy is then a "remote root" holding r.git.
      name: "a longer url.<decoy>.insteadOf",
      entry: (): [string, string] => [
        `url.${decoy}/.insteadOf`,
        "https://github.com/o/",
      ],
      nestedDecoy: true,
    },
  ])(
    "$name: skipped (unsafe local git config), nothing reaches the decoy",
    async ({ entry, nestedDecoy }) => {
      // protects=F1: the push lands on the run's repository through the
      // broker or not at all; fails_when=a local key redirects the push and
      // the salvage reports `pushed`, or anything reaches the decoy;
      // no_claim=GitHub (bare repos stand in for the broker's target and the
      // agent's decoy).
      const [key, value] = entry();
      git(work, "config", key, value);
      const nested = path.join(decoy, "r.git");
      if (nestedDecoy) {
        fs.mkdirSync(nested);
        git(nested, "init", "--quiet", "--bare");
      }

      expect(await salvage()).toBeNull();

      expect(logs).toEqual(["salvage: skipped (unsafe local git config)"]);
      expect(git(decoy, "for-each-ref")).toBe("");
      if (nestedDecoy) expect(git(nested, "for-each-ref")).toBe("");
      expect(remoteRefs().has(`refs/heads/${WORK_BRANCH}`)).toBe(false);
    },
  );

  it("a .gitattributes clean filter configured locally never runs (F2)", async () => {
    // protects=F2: no agent-configured command runs as the agent uid outside
    // the (already removed) run cgroup; fails_when=the filter's marker file
    // is written; no_claim=the cgroup itself (the second reap is the
    // backstop, workflow-cleanup tests).
    const marker = path.join(root, "FILTER_RAN");
    fs.writeFileSync(path.join(work, ".gitattributes"), "* filter=x\n");
    git(work, "config", "filter.x.clean", `touch ${marker}; cat`);

    expect(await salvage()).toBeNull();

    expect(logs).toEqual(["salvage: skipped (unsafe local git config)"]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("a remote.<url>.receivepack never runs (F2)", async () => {
    // protects=F2's second vector: a local transport's receive-pack command
    // is agent-chosen; fails_when=its marker is written or the push
    // proceeds; no_claim=none beyond protects.
    const marker = path.join(root, "RECEIVEPACK_RAN");
    git(
      work,
      "config",
      // The remote is named by the URL the salvage pushes to.
      "remote.https://github.com/o/r.git.receivepack",
      `touch ${marker}; git-receive-pack`,
    );

    await salvage();

    expect(logs).toEqual(["salvage: skipped (unsafe local git config)"]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("a post-commit hook in .git/hooks never runs (pins core.hooksPath)", async () => {
    // protects=hooks stay off at command scope (`--no-verify` alone skips
    // only pre-commit and commit-msg); fails_when=the hook's marker is
    // written; no_claim=none beyond protects.
    const marker = path.join(root, "HOOK_RAN");
    const hook = path.join(work, ".git", "hooks", "post-commit");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });

    expect(await salvage()).not.toBeNull();

    expect(fs.existsSync(marker)).toBe(false);
  });

  /** A nested repo `dir` in the checkout whose own config runs a clean filter writing `marker`. */
  function nestedRepoWithFilter(dir: string, marker: string): void {
    const sub = path.join(work, dir);
    fs.mkdirSync(sub);
    git(sub, "init", "--quiet", "-b", "main");
    fs.writeFileSync(path.join(sub, "f"), "one\n");
    fs.writeFileSync(path.join(sub, ".gitattributes"), "* filter=x\n");
    git(sub, "add", "f", ".gitattributes");
    git(sub, "commit", "--quiet", "-m", "sub");
    // Configured after the sub's own commits, so only a later git run in
    // the sub can trigger it.
    git(sub, "config", "filter.x.clean", `touch ${marker}; cat`);
  }

  it("a tracked gitlink is refused before `add -A` enters it, and its filter never runs (job 801)", async () => {
    // protects=job 801 finding 1: `add -A` runs `git status` inside every
    // tracked gitlink, under the SUBMODULE's agent-writable config, which
    // the guard never read; fails_when=the sub's filter marker is written or
    // anything is pushed; no_claim=none beyond protects.
    const marker = path.join(root, "SUBMODULE_FILTER_RAN");
    nestedRepoWithFilter("s", marker);
    git(work, "-c", "advice.addEmbeddedRepo=false", "add", "s");
    git(work, "commit", "--quiet", "-m", "agent: add gitlink s");
    expect(git(work, "ls-files", "-s", "s").startsWith("160000 ")).toBe(true);
    fs.writeFileSync(path.join(work, "s", "f"), "two\n");
    fs.writeFileSync(path.join(work, "top.ts"), "export {};\n");

    const result = await salvage();

    expect(fs.existsSync(marker)).toBe(false);
    expect(result).toBeNull();
    expect(logs).toEqual(["salvage: skipped (unsafe local git config)"]);
    expect(remoteRefs().has(`refs/heads/${WORK_BRANCH}`)).toBe(false);
  });

  it("a .gitmodules file is refused the same way (job 801)", async () => {
    // protects=the declared-submodule shape of the same hole; fails_when=the
    // salvage proceeds; no_claim=none beyond protects.
    fs.writeFileSync(
      path.join(work, ".gitmodules"),
      '[submodule "s"]\n\tpath = s\n\turl = https://github.com/o/s.git\n',
    );

    expect(await salvage()).toBeNull();

    expect(logs).toEqual(["salvage: skipped (unsafe local git config)"]);
    expect(remoteRefs().has(`refs/heads/${WORK_BRANCH}`)).toBe(false);
  });

  it("an UNTRACKED nested repo is still salvaged, never entered, and lands as a gitlink only (job 801)", async () => {
    // protects=what `add -A` does with an untracked nested repo: it records
    // the nested HEAD as an embedded gitlink without running git inside it,
    // so the nested filter never runs and none of the nested repo's files
    // are published; fails_when=the marker is written, the salvage is
    // refused, or nested content reaches the remote; no_claim=the gitlink
    // itself pointing at a commit GitHub does not have (documented).
    const marker = path.join(root, "NESTED_FILTER_RAN");
    nestedRepoWithFilter("inner", marker);
    fs.writeFileSync(path.join(work, "inner", "f"), "two\n");
    fs.writeFileSync(path.join(work, "top.ts"), "export {};\n");

    const result = await salvage();

    expect(fs.existsSync(marker)).toBe(false);
    expect(result).not.toBeNull();
    const tree = git(bare, "ls-tree", result!.sha);
    expect(tree).toMatch(/^160000 commit [0-9a-f]{40}\tinner$/m);
    expect(tree).toMatch(/\ttop\.ts$/m);
    expect(git(bare, "ls-tree", "-r", "--name-only", result!.sha)).not.toMatch(
      /^inner\//m,
    );
  });

  it("the allowed keys an agent commonly writes do not block the salvage", async () => {
    // protects=the guard is not so strict it throws away work for ordinary
    // config (the self-heal allowlist: user.*, push.*, branch tracking);
    // fails_when=such a checkout is skipped; no_claim=none beyond protects.
    git(work, "config", "user.name", "Agent");
    git(work, "config", "push.autoSetupRemote", "true");
    git(work, "config", `branch.${WORK_BRANCH}.remote`, "origin");

    expect(await salvage()).not.toBeNull();
    expect(remoteRefs().has(`refs/heads/${WORK_BRANCH}`)).toBe(true);
  });
});

/**
 * Roborev job 796: what the salvage publishes. Some target repos are public,
 * so a staged secret file is refused before the commit (finding 1), and HEAD
 * must be the work branch with no merge or rebase in progress (finding 2).
 */
describe("salvageWorkBranch refuses to publish secrets or a foreign HEAD (#437 review, job 796)", () => {
  it.each([
    ".env",
    "config/prod.pem",
    "deploy/prod.env",
    ".env.local",
    "keys/id_ed25519",
  ])(
    "an untracked %s is refused before the push, and nothing reaches the remote",
    async (file) => {
      // protects=finding 1: `git add -A` never publishes a secret file the
      // agent wrote (e.g. a .env from injected repo/org env vars), and the
      // path never reaches the journal; fails_when=the remote gains the work
      // branch or the log names the file;
      // no_claim=secrets inside ordinarily named files (out of scope: a name
      // denylist, mirroring .claude/settings.json).
      fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
      fs.writeFileSync(path.join(work, file), "SECRET=1\n");
      fs.writeFileSync(path.join(work, "ok.ts"), "export {};\n");

      expect(await salvage()).toBeNull();

      expect(logs).toEqual(["salvage: skipped (possible secret file)"]);
      // The range is scanned after the salvage's own commit: that commit
      // stays local (the workdir is wiped), and nothing reaches the remote.
      expect(git(work, "log", "-1", "--format=%s")).toBe(SALVAGE_MESSAGE);
      expect(remoteRefs().has(`refs/heads/${WORK_BRANCH}`)).toBe(false);
    },
  );

  it("a .env the agent committed itself, on a clean tree, is refused and never pushed (job 800)", async () => {
    // protects=finding 1 for the agent's OWN unpushed commits: the push would
    // send them, so they are scanned too; fails_when=the salvage pushes a
    // commit holding a secret file because its tree was clean;
    // no_claim=secrets in ordinarily named files (a name denylist).
    agentCommit(".env", "agent: config");
    agentCommit("later.ts", "agent: later");
    expect(git(work, "status", "--porcelain")).toBe("");

    expect(await salvage()).toBeNull();

    expect(logs).toEqual(["salvage: skipped (possible secret file)"]);
    expect(remoteRefs().has(`refs/heads/${WORK_BRANCH}`)).toBe(false);
  });

  it.each([".env.test", "config/dev.env"])(
    "an edited, already-tracked %s fixture is salvaged (job 801)",
    async (file) => {
      // protects=job 801 finding 2: only secret-named files NEW to the
      // range are refused, so a fixture the repo commits on purpose does not
      // block the agent's work on it; fails_when=the edit is refused;
      // no_claim=none beyond protects.
      fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
      agentCommit(file, "repo: fixture");
      publish(WORK_BRANCH);
      fs.writeFileSync(path.join(work, file), "EDITED=1\n");

      const result = await salvage();

      expect(result).not.toBeNull();
      expect(remoteRefs().get(`refs/heads/${WORK_BRANCH}`)).toBe(result?.sha);
    },
  );

  /** origin/<work> published, then main gains `.env.test` upstream. */
  function workAndBaseDiverged(): void {
    agentCommit("w.ts", "agent: work");
    publish(WORK_BRANCH);
    git(work, "checkout", "--quiet", "main");
    agentCommit(".env.test", "repo: fixture upstream");
    publish("main");
    git(work, "checkout", "--quiet", WORK_BRANCH);
  }

  it("a merge whose resolution adds a .env (in neither parent) is refused (job 808)", async () => {
    // protects=job 808 finding 2: a merge commit's own additions are
    // scanned (dense combined diff); fails_when=the resolution's .env is
    // pushed; no_claim=none beyond protects.
    workAndBaseDiverged();
    git(work, "merge", "--quiet", "--no-ff", "--no-commit", "main");
    fs.writeFileSync(path.join(work, ".env"), "SECRET=1\n");
    git(work, "add", ".env");
    git(work, "commit", "--quiet", "-m", "agent: merge main");

    expect(await salvage()).toBeNull();

    expect(logs).toEqual(["salvage: skipped (possible secret file)"]);
    expect(remoteRefs().get(`refs/heads/${WORK_BRANCH}`)).not.toBe(
      git(work, "rev-parse", "HEAD"),
    );
  });

  it("an ordinary merge of a base that added a tracked .env.test fixture is salvaged (job 808)", async () => {
    // protects=the merge scan does not refuse what the base itself added
    // (first-parent diffs would flag .env.test); fails_when=the merge is
    // refused; no_claim=none beyond protects.
    workAndBaseDiverged();
    git(work, "merge", "--quiet", "--no-ff", "--no-edit", "main");
    const head = git(work, "rev-parse", "HEAD");

    expect(await salvage()).toEqual({ branch: WORK_BRANCH, sha: head });
    expect(remoteRefs().get(`refs/heads/${WORK_BRANCH}`)).toBe(head);
  });

  it("a .env added in one unpushed commit and modified in a later one is still refused (job 801)", async () => {
    // protects=the add stays visible across the range even when a later
    // commit only modifies it; fails_when=the push goes out; no_claim=none
    // beyond protects.
    agentCommit(".env", "agent: add env");
    fs.writeFileSync(path.join(work, ".env"), "SECRET=2\n");
    git(work, "commit", "--quiet", "-am", "agent: change env");

    expect(await salvage()).toBeNull();

    expect(logs).toEqual(["salvage: skipped (possible secret file)"]);
    expect(remoteRefs().has(`refs/heads/${WORK_BRANCH}`)).toBe(false);
  });

  it("near-miss names (.envrc, environment.ts, env.ts, .env.example, .env.sample) are salvaged", async () => {
    // protects=the denylist matches names, not substrings: ordinary files,
    // and the committed-by-convention example/sample env files, are still
    // saved; fails_when=any of them blocks the salvage; no_claim=none beyond
    // protects.
    for (const f of [
      ".envrc",
      "environment.ts",
      "env.ts",
      ".env.example",
      ".env.sample",
      "src/keystore.ts",
    ]) {
      fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
      fs.writeFileSync(path.join(work, f), "x\n");
    }

    const result = await salvage();

    expect(result).not.toBeNull();
    expect(remoteRefs().get(`refs/heads/${WORK_BRANCH}`)).toBe(result?.sha);
  });

  it.each([
    ["a detached HEAD", () => git(work, "checkout", "--quiet", "--detach")],
    [
      "another branch",
      () => git(work, "checkout", "--quiet", "-b", "elsewhere"),
    ],
  ])(
    "%s is skipped (HEAD not on work branch) and nothing is pushed",
    async (_name, move) => {
      // protects=finding 2: the push sends exactly the work branch's own HEAD;
      // fails_when=a commit made on another branch or a detached HEAD reaches
      // refs/heads/<workBranch>; no_claim=none beyond protects.
      move();
      agentCommit("elsewhere.ts", "agent: off the work branch");

      expect(await salvage()).toBeNull();

      expect(logs).toEqual(["salvage: skipped (HEAD not on work branch)"]);
      expect(remoteRefs().has(`refs/heads/${WORK_BRANCH}`)).toBe(false);
    },
  );

  it("a merge in progress is skipped (merge or rebase in progress) and nothing is pushed", async () => {
    // protects=finding 2: a half-done merge is never committed and pushed as
    // the agent's work; fails_when=the salvage commits the conflicted tree or
    // pushes; no_claim=rebase/cherry-pick (same script, same check).
    git(work, "checkout", "--quiet", "-b", "side", "main");
    fs.writeFileSync(path.join(work, "README.md"), "side\n");
    git(work, "commit", "--quiet", "-am", "side");
    git(work, "checkout", "--quiet", WORK_BRANCH);
    fs.writeFileSync(path.join(work, "README.md"), "work\n");
    git(work, "commit", "--quiet", "-am", "work");
    expect(() => git(work, "merge", "--quiet", "side")).toThrow();
    const before = git(work, "rev-parse", "HEAD");

    expect(await salvage()).toBeNull();

    expect(logs).toEqual(["salvage: skipped (merge or rebase in progress)"]);
    expect(git(work, "rev-parse", "HEAD")).toBe(before);
    expect(remoteRefs().has(`refs/heads/${WORK_BRANCH}`)).toBe(false);
  });
});
