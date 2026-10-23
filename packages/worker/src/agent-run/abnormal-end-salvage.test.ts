import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  abnormalEndInfo,
  SALVAGE_COMMIT_MESSAGE,
  salvageWorkBranch,
  type SalvageWorkBranchArgs,
} from "./abnormal-end";
import { runAsAgent, type RunAsAgent } from "./agent-command";

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

let root: string;
let remotes: string;
let bare: string;
let work: string;
let logs: string[];

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
    log: (line) => logs.push(line),
    ...over,
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "salvage-")));
  remotes = path.join(root, "remotes");
  bare = path.join(remotes, "o", "r.git");
  work = path.join(root, "repo");
  fs.mkdirSync(bare, { recursive: true });
  git(bare, "init", "--quiet", "--bare");
  fs.mkdirSync(work);
  git(work, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(work, "README.md"), "hello\n");
  git(work, "add", "README.md");
  git(work, "commit", "--quiet", "-m", "base");
  // The clone's shape: origin is GitHub, origin/main is the base.
  git(work, "remote", "add", "origin", "https://github.com/o/r.git");
  publish("main");
  // provisionWorkdir: the work branch, cut from the cloned HEAD.
  git(work, "checkout", "--quiet", "-b", WORK_BRANCH);
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

    const result = await salvageWorkBranch(args());

    const head = git(work, "rev-parse", "HEAD");
    expect(result).toEqual({ branch: WORK_BRANCH, sha: head });
    expect(remoteRefs().get(`refs/heads/${WORK_BRANCH}`)).toBe(head);
    expect(git(bare, "log", "-1", "--format=%s", head)).toBe(
      SALVAGE_COMMIT_MESSAGE,
    );
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
    fs.writeFileSync(path.join(work, "a.ts"), "export const a = 1;\n");
    git(work, "add", "a.ts");
    git(work, "commit", "--quiet", "-m", "agent: first part");
    const agentHead = git(work, "rev-parse", "HEAD");

    const result = await salvageWorkBranch(args());

    expect(result).toEqual({ branch: WORK_BRANCH, sha: agentHead });
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
    fs.writeFileSync(path.join(work, "b.ts"), "export const b = 2;\n");
    git(work, "add", "b.ts");
    git(work, "commit", "--quiet", "-m", "agent: b");
    expect(remoteRefs().has(`refs/heads/${WORK_BRANCH}`)).toBe(false);

    const result = await salvageWorkBranch(args());

    expect(result?.sha).toBe(git(work, "rev-parse", "HEAD"));
    expect(remoteRefs().get(`refs/heads/${WORK_BRANCH}`)).toBe(result?.sha);
  });

  it("a clean tree with nothing unpushed pushes nothing (AC4)", async () => {
    // protects=AC4 in both shapes: the work branch already on the remote at
    // HEAD, and a fresh work branch never committed to (an empty copy of the
    // base is not "work"); fails_when=anything is committed or pushed, or the
    // line is not `nothing to save`; no_claim=none beyond protects.
    const before = remoteRefs();
    expect(await salvageWorkBranch(args())).toBeNull();
    expect(remoteRefs()).toEqual(before);
    expect(logs).toEqual(["salvage: nothing to save"]);

    fs.writeFileSync(path.join(work, "c.ts"), "export const c = 3;\n");
    git(work, "add", "c.ts");
    git(work, "commit", "--quiet", "-m", "agent: c");
    publish(WORK_BRANCH);
    const pushed = remoteRefs();
    const head = git(work, "rev-parse", "HEAD");
    logs = [];

    expect(await salvageWorkBranch(args())).toBeNull();
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

    const result = await salvageWorkBranch(
      args({ broker: { gitUrl: `file://${missing}`, bearer: BEARER } }),
    );

    expect(result).toBeNull();
    expect(logs).toEqual(["salvage: failed (push failed (exit 128))"]);
    // The commit itself still happened: a later look at the checkout (it is
    // deleted right after) would find it, but nothing claims it was saved.
    expect(git(work, "log", "-1", "--format=%s")).toBe(SALVAGE_COMMIT_MESSAGE);
  });

  it("a push that outlives the 60 s budget is killed and logged, never thrown", async () => {
    // protects=the hard budget on a fresh signal: a hung push cannot hold the
    // teardown (and the box lock) past it; fails_when=the salvage waits for
    // the hung step, throws, or logs anything but `failed (budget
    // exceeded)`; no_claim=the 60 s value itself (a 1.5 s budget stands in;
    // a `sleep 30` stands in for a hung push, killed by the real runAsAgent).
    fs.writeFileSync(path.join(work, "e.ts"), "export const e = 5;\n");
    const run: RunAsAgent = (a) =>
      runAsAgent(
        a.script.includes("git push")
          ? { ...a, script: "sleep 30", args: [] }
          : a,
      );
    const t0 = Date.now();

    const result = await salvageWorkBranch(args({ run, budgetMs: 1_500 }));

    expect(result).toBeNull();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(logs).toEqual(["salvage: failed (budget exceeded)"]);
    expect(remoteRefs().has(`refs/heads/${WORK_BRANCH}`)).toBe(false);
  }, 15_000);

  it("a lost box lock skips the salvage without running a single git command (AC6)", async () => {
    // protects=AC6: another run may own the box once the lock is lost;
    // fails_when=any git runs, anything is committed or pushed, or the line
    // differs; no_claim=how the lock is lost (box-lock tests).
    fs.writeFileSync(path.join(work, "f.ts"), "export const f = 6;\n");
    const run = vi.fn(runAsAgent);

    expect(await salvageWorkBranch(args({ lockLost: true, run }))).toBeNull();

    expect(run).not.toHaveBeenCalled();
    expect(logs).toEqual(["salvage: skipped (lock lost)"]);
    expect(git(work, "status", "--porcelain")).toBe("?? f.ts");
    expect(remoteRefs().has(`refs/heads/${WORK_BRANCH}`)).toBe(false);
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
    fs.writeFileSync(path.join(work, "other.ts"), "export {};\n");
    git(work, "add", "other.ts");
    git(work, "commit", "--quiet", "-m", "other branch");
    git(work, "tag", "-a", "v9", "-m", "a tag");
    git(work, "checkout", "--quiet", WORK_BRANCH);
    fs.writeFileSync(path.join(work, "g.ts"), "export {};\n");
    git(work, "tag", "-a", "v10", "-m", "tag on HEAD's parent");

    const result = await salvageWorkBranch(args());

    expect(result).not.toBeNull();
    expect([...remoteRefs().keys()].sort()).toEqual(
      ["refs/heads/main", `refs/heads/${WORK_BRANCH}`].sort(),
    );
    expect(git(decoy, "for-each-ref")).toBe("");
  });

  it("no log line of any outcome carries the bearer, the auth header or the broker URL (AC12)", async () => {
    // protects=AC12 for Part B's journal lines; fails_when=any line holds the
    // per-run bearer, an Authorization header or the broker URL;
    // no_claim=the persisted terminal info (built from branch + sha only,
    // see abnormalEndInfo below).
    const runs: Array<Partial<SalvageWorkBranchArgs>> = [
      {},
      { broker: { gitUrl: `file://${root}/missing`, bearer: BEARER } },
      { lockLost: true },
      { containerRun: true },
    ];
    for (const over of runs) {
      fs.writeFileSync(path.join(work, "h.ts"), `// ${Math.random()}\n`);
      await salvageWorkBranch(args(over));
    }
    expect(logs).toHaveLength(runs.length);
    for (const line of logs) {
      expect(line).not.toContain(BEARER);
      expect(line.toLowerCase()).not.toContain("authorization");
      expect(line).not.toContain(root);
      expect(line).toMatch(
        /^salvage: (pushed [0-9a-f]{8} to \S+|nothing to save|failed \(.+\)|skipped \(.+\))$/,
      );
    }
  });
});

describe("salvageWorkBranch gating (#437 Part B)", () => {
  it.each([
    [{ enabled: false }, "salvage: skipped (disabled)"],
    [{ workBranch: undefined }, "salvage: skipped (no work branch)"],
    [{ containerRun: true }, "salvage: skipped (container run)"],
    [{ broker: null }, "salvage: skipped (no git broker)"],
  ] as const)("%j logs one skip line and runs no git", async (over, line) => {
    // protects=WORKER_TIMEOUT_SALVAGE=off, a run with no work branch, the
    // container path (no broker route until C3) and a legacy-direct box (no
    // second auth path) each skip with their reason; fails_when=git runs or
    // the line differs; no_claim=the workflow passing these values
    // (workflow-cleanup tests).
    const run = vi.fn(runAsAgent);
    expect(await salvageWorkBranch(args({ ...over, run }))).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(logs).toEqual([line]);
  });

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
      expect(await salvageWorkBranch(args({ cause, run }))).toBeNull();
    }
    expect(run).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });
});

describe("abnormalEndInfo with a salvage (#437 Part B)", () => {
  const LIMIT = { runExecutionTimeoutMs: 30 * 60_000, starvation: null };
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
    [
      "url.<decoy>.pushInsteadOf",
      (): [string, string] => [
        `url.${decoy}.pushInsteadOf`,
        "https://github.com/o/r.git",
      ],
    ],
    [
      "remote.<url>.pushurl",
      (): [string, string] => [
        "remote.https://github.com/o/r.git.pushurl",
        decoy,
      ],
    ],
    // Longer than the broker's `https://github.com/`, so it wins the rewrite.
    [
      "a longer url.<decoy>.insteadOf",
      (): [string, string] => [
        `url.${decoy}/.insteadOf`,
        "https://github.com/o/",
      ],
    ],
  ] as const)(
    "%s: skipped (unsafe local git config), nothing reaches the decoy",
    async (_name, entry) => {
      // protects=F1: the push lands on the run's repository through the
      // broker or not at all; fails_when=a local key redirects the push and
      // the salvage reports `pushed`, or anything reaches the decoy;
      // no_claim=GitHub (bare repos stand in for the broker's target and the
      // agent's decoy).
      const [key, value] = entry();
      git(work, "config", key, value);
      if (key.endsWith(".insteadOf")) {
        // The decoy as a "remote root": <decoy>/r.git under o/.
        fs.mkdirSync(path.join(decoy, "r.git"));
        git(path.join(decoy, "r.git"), "init", "--quiet", "--bare");
      }

      const result = await salvageWorkBranch(args());

      expect(result).toBeNull();
      expect(logs).toEqual(["salvage: skipped (unsafe local git config)"]);
      expect(git(decoy, "for-each-ref")).toBe("");
      if (key.endsWith(".insteadOf")) {
        expect(git(path.join(decoy, "r.git"), "for-each-ref")).toBe("");
      }
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

    const result = await salvageWorkBranch(args());

    expect(result).toBeNull();
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

    await salvageWorkBranch(args());

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

    const result = await salvageWorkBranch(args());

    expect(result).not.toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("the allowed keys an agent commonly writes do not block the salvage", async () => {
    // protects=the guard is not so strict it throws away work for ordinary
    // config (the self-heal allowlist: user.*, push.*, branch tracking);
    // fails_when=such a checkout is skipped; no_claim=none beyond protects.
    git(work, "config", "user.name", "Agent");
    git(work, "config", "push.autoSetupRemote", "true");
    git(work, "config", `branch.${WORK_BRANCH}.remote`, "origin");

    expect(await salvageWorkBranch(args())).not.toBeNull();
    expect(remoteRefs().has(`refs/heads/${WORK_BRANCH}`)).toBe(true);
  });
});
