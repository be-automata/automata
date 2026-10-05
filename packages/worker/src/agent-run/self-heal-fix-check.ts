import path from "node:path";

import type { RunAsAgent } from "./agent-command";
import { gitExec } from "./provision";
import { RUN_OWNED_DIRS } from "./run-owned-paths";
import { runSelfHealChecks } from "./self-heal-checks";
import type { SelfHealRunShape } from "./types";

/**
 * GATE-01 / FENCE-01, execution-plane half (phase 9).
 *
 * After a fix agent is dead (daemon group killed, agent-uid escapees reaped,
 * git and gh brokers closed) the worker runs ONLY the finding's deterministic
 * check, as the agent uid, on a clean checkout of exactly the commit the
 * broker saw pushed, and lists the files that commit changed against the base
 * so www can refuse a fix that touched a denied path. No LLM, no build, no
 * test suite: those run on the repo's own CI on the draft PR.
 *
 * Injection posture is the same as self-heal-checks.ts: every script is a
 * module constant and the shas travel only as positional arguments ($1, $2).
 * They are re-validated as 40-hex before any command runs.
 *
 * The checkout is agent-owned, so its git metadata is untrusted. Hooks and
 * fsmonitor are overridden at command scope, replace refs are disabled by
 * env, and a guard refuses a checkout whose local config or info files could
 * steer git (filters, includes, attributes, grafts). A refusal is "error",
 * never a pass.
 */

export type FixWorkerStatus = "completed" | "aborted" | "error" | "no_branch";
export type FixCheckOutcome = "pass" | "fail" | "error";

export interface FixCheckReport {
  workerStatus: FixWorkerStatus;
  headSha: string | null;
  checkOutcome: FixCheckOutcome | null;
  deniedPaths: string[];
}

/** A report without a check result (the run never got to, or past, the check). */
export function emptyFixReport(
  workerStatus: FixWorkerStatus,
  headSha: string | null = null,
): FixCheckReport {
  return { workerStatus, headSha, checkOutcome: null, deniedPaths: [] };
}

export type SelfHealFixShape = Extract<SelfHealRunShape, { kind: "fix" }>;

/**
 * Mirror of @terragon/shared `FIX_DENY_PATHS` (the worker does not depend on
 * shared at runtime). A drift test compares the lists AND the matcher's
 * behaviour against shared `isDeniedPath`.
 */
export const WORKER_FIX_DENY_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/**",
  "deploy/**",
  "packages/worker/deploy/**",
  ".github/**",
] as const;

/** Agent-instruction names denied at any depth (compared lowercased). */
const DENY_ANY_DEPTH_SEGMENTS: ReadonlySet<string> = new Set([
  "agents.md",
  "claude.md",
  ".claude",
]);

/** The only `.github/**` shape an exception can ever cover. */
const WORKFLOW_FILE_RE = /^\.github\/workflows\/[^/]+$/;

/** Same folding as shared normalizeFixPath; null = untrustworthy spelling. */
function normalizePath(p: string): string | null {
  const segments = p.split("/").filter((segment) => segment.length > 0);
  while (segments[0] === ".") segments.shift();
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

function matchesDenyEntry(lowerPath: string, entry: string): boolean {
  const lowerEntry = entry.toLowerCase();
  if (lowerEntry.endsWith("/**")) {
    const dir = lowerEntry.slice(0, -3);
    return lowerPath === dir || lowerPath.startsWith(dir + "/");
  }
  return lowerPath === lowerEntry;
}

/**
 * True when a fix may not change `p`. Identical to shared `isDeniedPath`,
 * except the `ci.*` exception list arrives precomputed in the payload
 * (`denyExceptions` = shared `denyExceptionsFor`). An exception only ever
 * covers an exact `.github/workflows/<file>`; instruction and deploy paths
 * have none.
 */
export function matchesDenyPath(
  p: string,
  denyExceptions: readonly string[],
): boolean {
  const normalized = normalizePath(p);
  if (normalized === null) return true;
  const lower = normalized.toLowerCase();
  if (
    lower.split("/").some((segment) => DENY_ANY_DEPTH_SEGMENTS.has(segment))
  ) {
    return true;
  }
  const matched = WORKER_FIX_DENY_PATHS.filter((entry) =>
    matchesDenyEntry(lower, entry),
  );
  if (matched.length === 0) return false;
  const onlyGithub = matched.every((entry) => entry === ".github/**");
  if (!onlyGithub) return true;
  const exceptions = denyExceptions
    .map(normalizePath)
    .filter((e): e is string => e !== null && WORKFLOW_FILE_RE.test(e));
  return !exceptions.includes(normalized);
}

/** The fix-check route's bounds (09-09): at most 50 entries of 1–300 chars. */
export const MAX_REPORTED_DENIED_PATHS = 50;
const MAX_REPORTED_PATH_LENGTH = 300;

/** The plan's R1 budget for the whole post-agent check. */
export const FIX_CHECK_BUDGET_MS = 180_000;
/** Per git step; the whole check is still bounded by the deadline. */
const GIT_STEP_TIMEOUT_MS = 30_000;
/** Fresh HOME/TMPDIR for the check, created after the clean (agent-free). */
export const FIX_CHECK_SCRATCH_DIR = ".automata-fix-check";

const FULL_SHA = /^[0-9a-f]{40}$/;

const EXIT_UNSAFE_GITDIR = 3;
// The checkout must be a plain .git directory, and none of the info files that
// re-point attributes, history or the object store may exist.
const GUARD_SCRIPT =
  `test -d .git && test ! -L .git || exit ${EXIT_UNSAFE_GITDIR}; ` +
  `test ! -e .git/info/attributes && test ! -e .git/info/grafts && test ! -e .git/commondir || exit ${EXIT_UNSAFE_GITDIR}; ` +
  "exec git config --local --no-includes --name-only --list";
const CAT_FILE_SCRIPT = 'git cat-file -e "$1^{commit}"';
const CHECKOUT_SCRIPT = 'git checkout --quiet --force --detach "$1"';
// -ff: an untracked nested repository is removed too (one -f skips it).
// -x: ignored files the agent planted are removed as well.
// -x ignores info/exclude, so the worker's run-owned dirs (the run HOME with its
// credential, gh-config, tmp) are kept back with -e, which -x still honours: the
// agent uid cannot delete them on Linux (worker-owned), and deleting them would
// tear the run's own HOME away mid-run. They are not repository content.
const CLEAN_SCRIPT = `git clean -ffdxq ${RUN_OWNED_DIRS.map((d) => `-e /${d}/`).join(" ")}`;
const SCRATCH_SCRIPT = `mkdir -m 700 ${FIX_CHECK_SCRATCH_DIR} && mkdir -m 700 ${FIX_CHECK_SCRATCH_DIR}/home ${FIX_CHECK_SCRATCH_DIR}/tmp`;
const MERGE_BASE_SCRIPT = 'git merge-base "$2" "$1"';
// --no-renames: a rename out of a denied path must list the denied side too.
const DIFF_SCRIPT = 'git diff --no-renames --name-only -z "$2" "$1"';

/**
 * Local config keys a clean clone (plus the agent's own commits and pushes)
 * can legitimately carry; single-level push.* / pull.* keys (an agent's
 * `push.autoSetupRemote`) only steer push/pull, which the check never runs.
 * Anything else — filter.*, include.*, core.worktree, diff/alias/extensions
 * keys — could steer the commands below, so the check refuses to run and
 * reports a counted check failure (the agent wrote it).
 */
const ALLOWED_LOCAL_CONFIG =
  /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|remote\.origin\.(url|fetch)|branch\.[^\s]+\.(remote|merge)|user\.(name|email)|(push|pull)\.[a-z]+)$/;

/** Env every command of the check runs with, on top of the caller's. */
export function hardenGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...env,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  let count = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const add = (key: string, value: string): void => {
    out[`GIT_CONFIG_KEY_${count}`] = key;
    out[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  };
  // Command scope wins over the agent-writable .git/config.
  add("core.hooksPath", "/dev/null");
  add("core.fsmonitor", "false");
  out.GIT_CONFIG_COUNT = String(count);
  return out;
}

export interface RunFixCheckArgs {
  fix: SelfHealFixShape;
  /** The commit the broker saw pushed AND GitHub confirms; null = nothing landed. */
  pushedSha: string | null;
  /** origin/<baseBranch>, pinned by the worker BEFORE the agent ran. */
  baseSha: string | null;
  workdir: string;
  /** Sudo target; "" runs as the current user (dev). */
  agentUser: string;
  run: RunAsAgent;
  /** PATH/LANG/proxy/safe.directory; HOME and TMPDIR are replaced. */
  env: NodeJS.ProcessEnv;
  /** Epoch ms; nothing new starts after it. */
  deadlineAt: number;
  signal?: AbortSignal;
  now?: () => number;
  /** Operator-visible reason lines (constant text, never agent output). */
  note?: (message: string) => void;
}

function aggregate(outcomes: FixCheckOutcome[]): FixCheckOutcome {
  if (outcomes.length === 0) return "error";
  if (outcomes.includes("error")) return "error";
  if (outcomes.includes("fail")) return "fail";
  return "pass";
}

/** Denied paths in diff order, deduplicated and fitted to the route's bounds. */
export function reportableDeniedPaths(
  changed: readonly string[],
  denyExceptions: readonly string[],
): string[] {
  const out: string[] = [];
  for (const p of changed) {
    if (p.length === 0 || !matchesDenyPath(p, denyExceptions)) continue;
    const fitted = p.slice(0, MAX_REPORTED_PATH_LENGTH);
    if (!out.includes(fitted)) out.push(fitted);
    if (out.length >= MAX_REPORTED_DENIED_PATHS) break;
  }
  return out;
}

/**
 * Run the finding's check on a clean checkout of `pushedSha` and list the
 * denied paths it changed. Never throws.
 */
export async function runFixCheck(
  args: RunFixCheckArgs,
): Promise<FixCheckReport> {
  const now = args.now ?? Date.now;
  const pushedSha = args.pushedSha;
  if (pushedSha === null) return emptyFixReport("no_branch");
  const headSha = FULL_SHA.test(pushedSha) ? pushedSha : null;
  const failed = (
    workerStatus: FixWorkerStatus,
    reason?: string,
  ): FixCheckReport => {
    if (reason) args.note?.(reason);
    return emptyFixReport(workerStatus, headSha);
  };
  const stop = (): FixCheckReport | null => {
    if (args.signal?.aborted) return failed("aborted");
    if (now() >= args.deadlineAt) return failed("error", "deadline reached");
    return null;
  };
  if (headSha === null) return failed("error", "pushed sha is not 40-hex");
  if (args.baseSha === null || !FULL_SHA.test(args.baseSha)) {
    return failed("error", "base sha was not pinned");
  }

  const env = hardenGitEnv(args.env);
  const git = async (script: string, scriptArgs: string[]) =>
    args.run({
      agentUser: args.agentUser,
      cwd: args.workdir,
      script,
      args: scriptArgs,
      env,
      timeoutMs: Math.max(
        1,
        Math.min(GIT_STEP_TIMEOUT_MS, args.deadlineAt - now()),
      ),
      signal: args.signal,
    });
  const ok = (r: Awaited<ReturnType<RunAsAgent>>): boolean =>
    !r.timedOut && !r.truncated && r.exitCode === 0;

  try {
    const steps: Array<[string, string[], string]> = [
      [CAT_FILE_SCRIPT, [headSha], "pushed commit is not in the checkout"],
      [CHECKOUT_SCRIPT, [headSha], "checkout of the pushed commit failed"],
      [CLEAN_SCRIPT, [], "clean of the checkout failed"],
      [SCRATCH_SCRIPT, [], "scratch HOME could not be created"],
    ];
    let early = stop();
    if (early) return early;
    const guard = await git(GUARD_SCRIPT, []);
    if (!ok(guard)) {
      return stop() ?? failed("error", "unsafe or unreadable .git");
    }
    const keys = guard.stdout.split("\n").filter((k) => k.length > 0);
    if (keys.some((k) => !ALLOWED_LOCAL_CONFIG.test(k.toLowerCase()))) {
      // The agent wrote it: a counted failure of the fix (R2), never an
      // infra error that is refunded and re-run.
      args.note?.("unsafe local git config");
      return {
        workerStatus: "completed",
        headSha,
        checkOutcome: "fail",
        deniedPaths: [],
      };
    }
    for (const [script, scriptArgs, reason] of steps) {
      early = stop();
      if (early) return early;
      const r = await git(script, scriptArgs);
      if (!ok(r)) return stop() ?? failed("error", reason);
    }

    early = stop();
    if (early) return early;
    const mb = await git(MERGE_BASE_SCRIPT, [headSha, args.baseSha]);
    const mergeBase = mb.stdout.trim();
    if (!ok(mb) || !FULL_SHA.test(mergeBase)) {
      return stop() ?? failed("error", "no merge-base with the pinned base");
    }

    early = stop();
    if (early) return early;
    const diff = await git(DIFF_SCRIPT, [headSha, mergeBase]);
    if (!ok(diff)) return stop() ?? failed("error", "diff failed");
    const deniedPaths = reportableDeniedPaths(
      diff.stdout.split("\0"),
      args.fix.denyExceptions,
    );

    if (args.signal?.aborted) return failed("aborted");
    const scratch = path.join(args.workdir, FIX_CHECK_SCRATCH_DIR);
    const checkEnv: NodeJS.ProcessEnv = {
      ...env,
      HOME: path.join(scratch, "home"),
      TMPDIR: path.join(scratch, "tmp"),
    };
    const remaining = args.deadlineAt - now();
    const results =
      remaining <= 0
        ? args.fix.checks.map((c) => ({
            fingerprint: c.fingerprint,
            outcome: "error" as const,
          }))
        : await runSelfHealChecks({
            checks: args.fix.checks,
            run: args.run,
            agentUser: args.agentUser,
            workdir: args.workdir,
            env: checkEnv,
            budgetMs: remaining,
            perCheckMs: remaining,
            signal: args.signal,
            now,
          });
    if (args.signal?.aborted) return failed("aborted");
    return {
      workerStatus: "completed",
      headSha,
      checkOutcome: aggregate(results.map((r) => r.outcome)),
      deniedPaths,
    };
  } catch (err) {
    if (args.signal?.aborted) return failed("aborted");
    return failed(
      "error",
      "runner threw (" + (err instanceof Error ? err.name : "unknown") + ")",
    );
  }
}

/**
 * origin/<baseBranch> in the fresh clone, read by the WORKER before the agent
 * exists: the agent can rewrite its own remote-tracking refs, so the diff base
 * must be pinned first. null when it cannot be resolved (the check then
 * reports error). Never throws.
 */
export async function pinFixBaseSha({
  workdir,
  baseBranch,
  runGit = gitExec,
}: {
  workdir: string;
  baseBranch: string;
  runGit?: typeof gitExec;
}): Promise<string | null> {
  try {
    const { stdout } = await runGit(
      [
        "-C",
        workdir,
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        "refs/remotes/origin/" + baseBranch + "^{commit}",
      ],
      { timeout: GIT_STEP_TIMEOUT_MS },
    );
    const sha = String(stdout).trim();
    return FULL_SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * The attempt branch's head on GitHub, or null when the branch does not
 * exist. A 2xx receive-pack can still carry a per-ref rejection, so the
 * broker's lastPushedSha is confirmed here before anything is checked. Runs
 * as the worker with the installation token in a one-shot header; gitExec
 * keeps it out of any failure text. Throws on a git/network failure.
 */
export async function remoteBranchHead({
  repoFullName,
  branch,
  installationToken,
  runGit = gitExec,
}: {
  repoFullName: string;
  branch: string;
  installationToken: string;
  runGit?: typeof gitExec;
}): Promise<string | null> {
  const authHeader =
    "AUTHORIZATION: basic " +
    Buffer.from("x-access-token:" + installationToken).toString("base64");
  const ref = "refs/heads/" + branch;
  const { stdout } = await runGit(
    [
      "-c",
      "http.extraHeader=" + authHeader,
      "ls-remote",
      "--end-of-options",
      "https://github.com/" + repoFullName + ".git",
      ref,
    ],
    { timeout: GIT_STEP_TIMEOUT_MS },
  );
  for (const line of String(stdout).split("\n")) {
    const [sha, name] = line.trim().split("\t");
    if (name === ref && sha !== undefined && FULL_SHA.test(sha)) return sha;
  }
  return null;
}
