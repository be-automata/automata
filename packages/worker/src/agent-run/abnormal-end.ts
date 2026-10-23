import { redactSecrets } from "@terragon/utils/redact";

import {
  runAsAgent,
  type AgentCommandResult,
  type RunAsAgent,
} from "./agent-command";
import { SHA1_HEX } from "./batteries-manifest";
import {
  appendGitConfig,
  botGitIdentity,
  brokeredGitAuthConfig,
  buildRunProxyEnv,
  gitProxyAuthConfig,
  type BrokerHandoff,
} from "./daemon-env";
import { formatMemoryMax, MemoryStarvationError } from "./retry-classification";
import type { TerminalCause } from "./types";
import { checkLocalGitConfig, hardenGitEnv } from "./untrusted-checkout-git";
import {
  postRunTerminal,
  type RunTerminalResult,
  type WwwClientOpts,
} from "./www-client";

/**
 * #437: how a TASK run ended abnormally, as one typed terminal cause.
 *
 * Without this every abnormal end of a task run (timeout, OOM kill, a crash)
 * reached the thread only through onFailure's synthetic `custom-error`:
 * `agent-generic-error` with Hatchet's raw error map as the text and no
 * `terminal_cause` at all. The worker now names the cause itself, inside the
 * run's teardown; onFailure stays the backstop and its later post is absorbed
 * by www's terminal-idempotent write.
 *
 * Only runs that `ownsAbnormalTerminal` (run-lane.ts) classify: review, pr and
 * self-heal terminals are owned elsewhere (postSuperseded, the user-Stop post,
 * the fix check).
 */

/** How far before the execution limit a cancel still counts as the timeout. */
export const TIMEOUT_CANCEL_TOLERANCE_MS = 15_000;

/** What ended the run, as the exit that saw it knows it. */
export interface RunEnd {
  /** The thrown value, when the run threw. */
  thrown?: { error: unknown };
  /** The engine cancelled the run (ctx.cancelled / the run's signal aborted). */
  cancelled: boolean;
  /**
   * The daemon's own OOM signal (cgroup `oom_kill` / container OOMKilled): the
   * terminal error it would fail the run with, or null.
   */
  starvation: unknown;
}

export interface AbnormalEndInput extends RunEnd {
  /** True once the daemon was spawned (`daemon spawned`). */
  daemonStarted: boolean;
  runStartedAt: number;
  now: number;
  runExecutionTimeoutMs: number;
}

/**
 * First match wins (#437 Part A):
 *   1. OOM kill — even when a cancel lands in the same tick → `out-of-memory`
 *   2. cancel at the execution limit → `timeout`
 *   3. an earlier cancel → null (see below)
 *   4. a throw before the daemon started → `run-failed-unreported`
 *   5. any other throw → `daemon-failed`
 * A run that neither threw nor was cancelled ended normally: null.
 *
 * Why an earlier cancel posts nothing (a deliberate departure from #437's
 * `user-cancelled`): a user Stop never gets here — it reaches the worker as
 * the `stopped` outcome and is posted as `user-cancelled` by the run fn. What
 * is left is an engine-side cancel the worker cannot attribute, including a
 * stale attempt cancelled after a heartbeat reassignment while attempt n+1
 * of the SAME workflow run id still works the thread. Closing the thread
 * from that attempt would be wrong; the C4 sweep reconciles, as before.
 *
 * A stale attempt that THROWS still posts (daemon-failed / out-of-memory):
 * that is no new exposure — before #437 the same throw reached the thread
 * through onFailure's generic custom-error under the same run id.
 */
export function classifyAbnormalEnd(o: AbnormalEndInput): TerminalCause | null {
  if (!o.thrown && !o.cancelled) return null;
  if (
    o.starvation != null ||
    o.thrown?.error instanceof MemoryStarvationError
  ) {
    return "out-of-memory";
  }
  if (o.cancelled) {
    const elapsed = o.now - o.runStartedAt;
    return elapsed >= o.runExecutionTimeoutMs - TIMEOUT_CANCEL_TOLERANCE_MS
      ? "timeout"
      : null;
  }
  return o.daemonStarted ? "daemon-failed" : "run-failed-unreported";
}

/**
 * The worker-authored line shown under the error (`detail.info`). Never agent
 * output, never a credential: built only from the cause, the configured limit
 * and the kernel's kill count.
 */
export function abnormalEndInfo(
  cause: TerminalCause,
  o: Pick<RunEnd, "thrown" | "starvation"> & {
    runExecutionTimeoutMs: number;
    /** Part B: what the timeout salvage pushed, if anything. */
    salvage?: SalvageResult | null;
  },
): string | undefined {
  if (cause === "timeout") {
    if (o.salvage) {
      const saved = `Unfinished work was saved to branch ${o.salvage.branch} (commit ${o.salvage.sha.slice(0, 8)}).`;
      // www refuses an info over 300 chars (400 → no typed terminal at all):
      // an extreme branch name falls back to the plain limit line.
      if (saved.length <= TERMINAL_INFO_MAX_CHARS) return saved;
    }
    return `The run reached its ${limitMinutes(o.runExecutionTimeoutMs)}-minute limit.`;
  }
  if (cause === "out-of-memory") {
    // The thrown error when the poll loop raised it, else the daemon's signal
    // (an OOM whose cancel landed in the same tick never threw).
    const oom = [o.thrown?.error, o.starvation].find(
      (e): e is MemoryStarvationError => e instanceof MemoryStarvationError,
    );
    if (oom) {
      return `Memory limit ${formatMemoryMax(oom.memoryMaxBytes)} reached (${oom.oomKills} process(es) killed).`;
    }
  }
  return undefined;
}

/** The run's execution limit in whole minutes (the info line, the salvage commit). */
function limitMinutes(runExecutionTimeoutMs: number): number {
  return Math.round(runExecutionTimeoutMs / 60_000);
}

/** The run-terminal route's `detail.info` bound (www-enforced). */
export const TERMINAL_INFO_MAX_CHARS = 300;

export const TERMINAL_POST_ATTEMPTS = 3;
export const TERMINAL_POST_TIMEOUT_MS = 10_000;
/** Backoff before attempt 2 and 3 (#437 Part A2). */
const TERMINAL_POST_BACKOFF_MS = [1_000, 2_000] as const;

export type TerminalPostResult = "applied" | "noop" | "failed";

/**
 * Post one typed terminal, up to 3 attempts on a FRESH 10 s signal each (a
 * teardown's run signal is already aborted). A 409 (a newer generation owns
 * the thread), `applied: false` or any other 4xx is final, never retried.
 * Never throws: after the last failed attempt the onFailure path still closes
 * the thread, exactly as before #437.
 */
export async function postRunTerminalWithRetry({
  wwwOpts,
  runExternalId,
  cause,
  info,
  log,
  post = postRunTerminal,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  wwwOpts: WwwClientOpts;
  runExternalId: string;
  cause: TerminalCause;
  info?: string;
  log: (line: string) => void;
  post?: typeof postRunTerminal;
  sleep?: (ms: number) => Promise<void>;
}): Promise<TerminalPostResult> {
  for (let attempt = 1; attempt <= TERMINAL_POST_ATTEMPTS; attempt++) {
    let result: RunTerminalResult;
    try {
      result = await post(
        wwwOpts,
        { runExternalId, cause, ...(info ? { info } : {}) },
        AbortSignal.timeout(TERMINAL_POST_TIMEOUT_MS),
      );
    } catch {
      // postRunTerminal never throws; a substituted post might.
      result = "error";
    }
    if (result === "applied") return "applied";
    if (result === "noop" || result === "rejected") return "noop";
    if (result === "refused") {
      // A 4xx (e.g. the token was revoked on the terminal read) will not
      // change on a retry.
      log(`terminal post refused by www (${cause})`);
      return "failed";
    }
    const backoff = TERMINAL_POST_BACKOFF_MS[attempt - 1];
    if (backoff !== undefined) await sleep(backoff);
  }
  log(
    `terminal post failed after ${TERMINAL_POST_ATTEMPTS} attempts (${cause})`,
  );
  return "failed";
}

/**
 * The once-per-run state shared by the daemon teardown and the outer
 * pre-daemon catch, so a run posts at most one abnormal terminal whichever
 * exit it took.
 */
export interface AbnormalEndState {
  /** ownsAbnormalTerminal(input): false ⇒ every claim is null. */
  owns: boolean;
  runStartedAt: number;
  runExecutionTimeoutMs: number;
  daemonStarted: boolean;
  claimed: boolean;
  /** When the run's abort signal fired; the timeout check reads this. */
  cancelledAt?: number;
}

export function newAbnormalEndState(o: {
  owns: boolean;
  runStartedAt: number;
  runExecutionTimeoutMs: number;
}): AbnormalEndState {
  return { ...o, daemonStarted: false, claimed: false };
}

/** A claimed abnormal end: its cause, and what it was built from. */
export interface AbnormalEnd extends RunEnd {
  cause: TerminalCause;
}

/**
 * Step 1: claim the run's end (at most once per run) and classify it. Null for
 * a run this plane does not own, a normal end, or an end already claimed.
 * Kept apart from the post so a teardown can act on the cause in between.
 */
export function claimAbnormalEnd(
  state: AbnormalEndState,
  end: RunEnd,
  now: number = Date.now(),
): AbnormalEnd | null {
  if (!state.owns || state.claimed) return null;
  state.claimed = true;
  const cause = classifyAbnormalEnd({
    ...end,
    daemonStarted: state.daemonStarted,
    runStartedAt: state.runStartedAt,
    runExecutionTimeoutMs: state.runExecutionTimeoutMs,
    now: end.cancelled ? (state.cancelledAt ?? now) : now,
  });
  return cause === null ? null : { ...end, cause };
}

/**
 * Step 2: post a claimed end. Logs one line:
 * `abnormal end → <cause> terminal: <applied|noop|failed>`. Never throws.
 */
export async function postAbnormalEnd(
  state: AbnormalEndState,
  end: AbnormalEnd,
  {
    wwwOpts,
    log,
    salvage,
    post,
    sleep,
  }: {
    wwwOpts: WwwClientOpts;
    log: (line: string) => void;
    /** Part B: what the timeout salvage pushed (names the branch in the info). */
    salvage?: SalvageResult | null;
    post?: typeof postRunTerminal;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<TerminalPostResult | null> {
  const runExternalId = wwwOpts.runExternalId;
  if (!runExternalId) {
    log(`abnormal end → ${end.cause}: terminal not posted (no workflowRunId)`);
    return null;
  }
  const result = await postRunTerminalWithRetry({
    wwwOpts,
    runExternalId,
    cause: end.cause,
    info: abnormalEndInfo(end.cause, {
      ...end,
      runExecutionTimeoutMs: state.runExecutionTimeoutMs,
      salvage,
    }),
    log,
    ...(post ? { post } : {}),
    ...(sleep ? { sleep } : {}),
  });
  log(`abnormal end → ${end.cause} terminal: ${result}`);
  return result;
}

/**
 * #437 Part B: what a timeout salvage pushed — the work branch and the full
 * sha of the commit now at its head on GitHub.
 */
export interface SalvageResult {
  branch: string;
  sha: string;
}

/** What the salvage did, and whether it ran any git as the agent uid. */
export interface SalvageOutcome {
  result: SalvageResult | null;
  spawned: boolean;
}

/** The hard budget for the whole salvage, on a signal of its own. */
export const SALVAGE_BUDGET_MS = 60_000;

/** `wip: run timed out at <limit>m (automata salvage)`. */
export function salvageCommitMessage(runExecutionTimeoutMs: number): string {
  return `wip: run timed out at ${limitMinutes(runExecutionTimeoutMs)}m (automata salvage)`;
}

// Every script is a module constant; the branch, the message and the push URL
// travel only as positional arguments ($1, $2), the same injection posture as
// the self-heal checks (agent-command.ts). `exec git`: no shell stays between
// the runner and git, so the process a budget kill reaches is git itself.
const REF_FORMAT_SCRIPT = 'exec git check-ref-format "refs/heads/$1"';
// HEAD must be the work branch itself, with no merge, rebase, cherry-pick or
// revert half done: else what would be pushed is not the agent's work on
// that branch. Paths via --git-path, so nothing assumes the .git layout.
const EXIT_HEAD_ELSEWHERE = 10;
const EXIT_OPERATION_IN_PROGRESS = 11;
const HEAD_STATE_SCRIPT =
  `head=$(git symbolic-ref -q HEAD) || exit ${EXIT_HEAD_ELSEWHERE}; ` +
  `[ "$head" = "refs/heads/$1" ] || exit ${EXIT_HEAD_ELSEWHERE}; ` +
  "for p in MERGE_HEAD rebase-merge rebase-apply CHERRY_PICK_HEAD REVERT_HEAD; do " +
  `[ ! -e "$(git rev-parse --git-path "$p")" ] || exit ${EXIT_OPERATION_IN_PROGRESS}; ` +
  "done";
// `add -A` runs `git status` INSIDE every tracked gitlink, under that
// submodule's own agent-writable config and attributes, which no guard read
// (a filter there runs as the agent uid; diff.ignoreSubmodules does not stop
// it). So no gitlink (mode 160000) may be in the index, and no .gitmodules
// may exist. NUL-separated records, so a path cannot fake a mode; a path
// holding a newline can only cause a refusal. Listed twice so a failing
// ls-files fails the step instead of passing the pipeline.
const EXIT_SUBMODULES = 12;
const SUBMODULE_SCRIPT =
  `test ! -e .gitmodules || exit ${EXIT_SUBMODULES}; ` +
  "git ls-files -s -z >/dev/null || exit 1; " +
  `if git ls-files -s -z | tr '\\0' '\\n' | grep -q '^160000 '; then exit ${EXIT_SUBMODULES}; fi`;
// A run killed at its limit can die inside a git command and leave the index,
// HEAD or work-branch ref lock behind; add/commit would then exit 128 and the
// work be lost. Safe to clear: the agent and its escapees are reaped and the
// box lock is held, so no git of this run is still writing. As the agent uid,
// so it can only remove what the agent could.
const STALE_LOCKS_SCRIPT =
  'for p in index.lock HEAD.lock "refs/heads/$1.lock"; do ' +
  'f=$(git rev-parse --git-path "$p") || exit 1; rm -f -- "$f" || exit 1; ' +
  "done";
const ADD_SCRIPT = "exec git add -A";
// Every secret-named path the push would ADD: each commit HEAD holds that no
// origin/* ref does — the salvage commit AND the agent's own unpushed
// commits. Only adds: a fixture the repo already tracks (.env.test) may be
// edited; --no-renames keeps a rename onto a secret name visible as an add.
// --cc: a merge commit lists what its resolution adds in NEITHER parent (a
// plain log lists nothing for merges), while a file merged in from the base
// is not listed (first-parent diffs would refuse every upstream fixture).
const UNPUSHED_ADDED_SCRIPT =
  "exec git log --format= --name-only -z --no-renames --diff-filter=A --cc --ignore-submodules=all HEAD --not --remotes=origin";
// Exit 1 = something is staged (no gitlink is in the index: see above).
const STAGED_SCRIPT = "exec git diff --cached --quiet --ignore-submodules=all";
const COMMIT_SCRIPT =
  'exec git commit --quiet --no-verify --no-gpg-sign -m "$1"';
// The newest commit HEAD holds that no origin/* ref does (the salvage commit,
// or the agent's unpushed work); empty = nothing to save. A work branch cut
// fresh from the base and never committed to is not pushed as a copy of it.
const UNPUSHED_HEAD_SCRIPT =
  "exec git rev-list --max-count=1 HEAD --not --remotes=origin";
// Never --force, never a second ref: one explicit refspec; tags, submodules
// and signing off whatever push.* the guard's allowlist let the agent write.
const PUSH_SCRIPT =
  'exec git push --quiet --no-verify --no-follow-tags --recurse-submodules=no --no-signed -- "$1" "HEAD:refs/heads/$2"';

const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Basenames the salvage never publishes (some target repos are public): the
 * repo's own .claude/settings.json secret-file denylist, plus SSH private
 * keys (not a `.pub` public key, nor a source file such as `id_rsa.ts`),
 * package-registry auth files and direnv's `.envrc` (it usually exports
 * secrets). Matched case-insensitively on the basename. `.env.example` and
 * `.env.sample` are allowed — the conventional committed placeholders.
 */
const SECRET_FILE_NAMES: readonly RegExp[] = [
  /^\.env$/,
  /^\.env\..+$/,
  /\.env$/,
  /\.(pem|key|p8|p12|pfx|jks|keystore)$/,
  /^service-account.*\.json$/,
  /credentials.*\.json$/,
  /^auth\.json$/,
  /^\.netrc$/,
  /^\.(npmrc|pypirc|envrc)$/,
  // No dot after the key type: id_rsa.pub and id_rsa.ts are not keys.
  /^id_(rsa|dsa|ecdsa|ed25519)([_-][a-z0-9_-]*)?$/,
];
const ALLOWED_ENV_PLACEHOLDERS = new Set([".env.example", ".env.sample"]);

/** Would publishing this path risk a secret file? */
export function isPossibleSecretFile(filePath: string): boolean {
  const base = (filePath.split("/").pop() ?? "").toLowerCase();
  if (ALLOWED_ENV_PLACEHOLDERS.has(base)) return false;
  return SECRET_FILE_NAMES.some((re) => re.test(base));
}

/** A salvage step that did not succeed; its message is constant text. */
class SalvageStepFailed extends Error {}

export interface SalvageWorkBranchArgs {
  /** The claimed cause: only `timeout` is salvaged; any other is silent. */
  cause: TerminalCause;
  workBranch: string | undefined;
  /** The box lock was lost: another run may own the agent uid and box now. */
  lockLost: boolean;
  /** config.timeoutSalvage !== "off". */
  enabled: boolean;
  /** An ADR-013 container run (see the skip below). */
  containerRun: boolean;
  /** The run's git broker handoff; null on a legacy-direct (unbrokered) box. */
  broker: Pick<BrokerHandoff, "gitUrl" | "bearer"> | null;
  repoFullName: string;
  /** The run's checkout. */
  workdir: string;
  /** The slot's agent account; "" runs git as the worker (dev). */
  agentUser: string;
  botLogin: string;
  egressProxyUrl: string | null;
  /** The run's execution limit (names it in the salvage commit). */
  runExecutionTimeoutMs: number;
  log: (line: string) => void;
  run?: RunAsAgent;
  budgetMs?: number;
}

/**
 * The env every salvage git runs with: the agent's own brokered auth
 * (brokeredGitAuthConfig — never a second path, never the installation
 * token), the run's bot identity, the run's egress proxy, and hardenGitEnv
 * (untrusted-checkout-git.ts). push.pushOption is reset (an empty value
 * clears the list): the guard's allowlist admits push.*.
 */
export function salvageGitEnv({
  agentUser,
  workdir,
  broker,
  botLogin,
  egressProxyUrl,
}: Pick<
  SalvageWorkBranchArgs,
  "agentUser" | "workdir" | "botLogin" | "egressProxyUrl"
> & {
  broker: Pick<BrokerHandoff, "gitUrl" | "bearer">;
}): NodeJS.ProcessEnv {
  const identity = botGitIdentity(botLogin);
  let env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (agentUser) {
    env.USER = agentUser;
    env.LOGNAME = agentUser;
  }
  Object.assign(env, identity.env);
  env = appendGitConfig(env, [
    ...brokeredGitAuthConfig(broker),
    ["credential.helper", ""],
    ...identity.config,
    ...(agentUser
      ? ([["safe.directory", workdir]] as Array<[string, string]>)
      : []),
    ...gitProxyAuthConfig(egressProxyUrl),
    ["push.pushOption", ""],
    // `git commit` otherwise spawns a DETACHED `git maintenance run --auto`.
    ["maintenance.auto", "false"],
    ["gc.auto", "0"],
  ]);
  if (egressProxyUrl) env = buildRunProxyEnv(egressProxyUrl, env);
  return hardenGitEnv(env);
}

/**
 * #437 Part B: save a timed-out task run's work before its checkout is
 * deleted — after the agent is dead and reaped, before the git broker closes.
 * As the agent uid, in the checkout: refuse an agent-steered .git
 * (checkLocalGitConfig, untrusted-checkout-git.ts), commit a dirty tree
 * (salvageCommitMessage, the bot identity), then push HEAD to the work branch
 * — by URL, one refspec, never forced — when it holds unpushed commits. One
 * hard budget on a FRESH signal (the run's is already aborted). Never throws,
 * never changes the cause, opens no PR; logs exactly one line:
 * `salvage: pushed <sha8> to <branch>` | `salvage: nothing to save` |
 * `salvage: failed (<reason>)` | `salvage: skipped (<reason>)`, the reason
 * constant text (runAsAgent discards stderr). The budget ends the salvage
 * even when a step's runner never settles (a killed sudo whose git still
 * holds its pipe); the workflow's post-salvage reap kills that git.
 */
export async function salvageWorkBranch(
  args: SalvageWorkBranchArgs,
): Promise<SalvageOutcome> {
  let spawned = false;
  if (args.cause !== "timeout") return { result: null, spawned };
  const done = (
    line: string,
    result: SalvageResult | null = null,
  ): SalvageOutcome => {
    args.log(redactSecrets(`salvage: ${line}`));
    return { result, spawned };
  };
  const skipped = (reason: string) => done(`skipped (${reason})`);
  const { workBranch, broker } = args;
  if (!args.enabled) return skipped("disabled");
  if (!workBranch) return skipped("no work branch");
  if (args.lockLost) return skipped("lock lost");
  // ADR-013 (dev-only): a container's only route to GitHub is meant to be the
  // git broker bridged in over a unix socket (C3, #430), not built yet; host
  // git as the worker on the container-written .git would run its config as
  // the worker uid. Unlocked by C3.
  if (args.containerRun) return skipped("container run");
  if (!broker) return skipped("no git broker");
  if (!REPO_SLUG.test(args.repoFullName)) {
    return skipped("invalid repository name");
  }

  const run = args.run ?? runAsAgent;
  const budgetMs = args.budgetMs ?? SALVAGE_BUDGET_MS;
  // The one clock: runAsAgent SIGKILLs its child when this signal aborts.
  const budget = AbortSignal.timeout(budgetMs);
  try {
    const env = salvageGitEnv({ ...args, broker });
    const git = async (script: string, scriptArgs: string[] = []) => {
      if (budget.aborted) throw new SalvageStepFailed("budget exceeded");
      spawned = true;
      const step = run({
        agentUser: args.agentUser,
        cwd: args.workdir,
        script,
        args: scriptArgs,
        env,
        timeoutMs: budgetMs,
        signal: budget,
      });
      // The budget ends the step even when the runner never settles: a
      // SIGKILLed sudo whose git still holds the stdout pipe never closes.
      // That step is left to settle unobserved (the post-salvage reap kills
      // its git); the abort listener goes with every step.
      step.catch(() => {});
      let onAbort = (): void => {};
      const aborted = new Promise<null>((resolve) => {
        onAbort = () => resolve(null);
        budget.addEventListener("abort", onAbort, { once: true });
      });
      let r: AgentCommandResult | null;
      try {
        r = await Promise.race([step, aborted]);
      } finally {
        budget.removeEventListener("abort", onAbort);
      }
      if (r === null || r.timedOut || budget.aborted) {
        throw new SalvageStepFailed("budget exceeded");
      }
      return r;
    };
    const ok = async (verb: string, script: string, scriptArgs?: string[]) => {
      const r = await git(script, scriptArgs);
      if (r.exitCode !== 0) {
        throw new SalvageStepFailed(
          `${verb} failed (exit ${r.exitCode ?? "killed"})`,
        );
      }
      return r;
    };

    const guard = await checkLocalGitConfig((script) => git(script));
    if (guard === "unsafe") return skipped("unsafe local git config");
    if (guard === "error") throw new SalvageStepFailed("config guard failed");
    await ok("work branch check", REF_FORMAT_SCRIPT, [workBranch]);
    const headState = await git(HEAD_STATE_SCRIPT, [workBranch]);
    if (headState.exitCode === EXIT_HEAD_ELSEWHERE) {
      return skipped("HEAD not on work branch");
    }
    if (headState.exitCode === EXIT_OPERATION_IN_PROGRESS) {
      return skipped("merge or rebase in progress");
    }
    if (headState.exitCode !== 0) {
      throw new SalvageStepFailed(
        `head check failed (exit ${headState.exitCode ?? "killed"})`,
      );
    }
    const submodules = await git(SUBMODULE_SCRIPT);
    // Its own reason: a repo that legitimately uses submodules is not one
    // whose config was tampered with.
    if (submodules.exitCode === EXIT_SUBMODULES) return skipped("submodules");
    if (submodules.exitCode !== 0) {
      throw new SalvageStepFailed(
        `submodule check failed (exit ${submodules.exitCode ?? "killed"})`,
      );
    }
    await ok("stale lock cleanup", STALE_LOCKS_SCRIPT, [workBranch]);
    await ok("add", ADD_SCRIPT);
    const staged = await git(STAGED_SCRIPT);
    if (staged.exitCode === 1) {
      await ok("commit", COMMIT_SCRIPT, [
        salvageCommitMessage(args.runExecutionTimeoutMs),
      ]);
    } else if (staged.exitCode !== 0) {
      throw new SalvageStepFailed(
        `staged check failed (exit ${staged.exitCode ?? "killed"})`,
      );
    }
    const sha = (await ok("rev-list", UNPUSHED_HEAD_SCRIPT)).stdout.trim();
    if (sha === "") return done("nothing to save");
    if (!SHA1_HEX.test(sha)) {
      throw new SalvageStepFailed("rev-list output unreadable");
    }
    // The whole range the push would send, after the salvage's own commit: a
    // refused salvage leaves that commit local, and the workdir is wiped.
    // Never logs the path.
    const names = await ok("unpushed list", UNPUSHED_ADDED_SCRIPT);
    if (names.truncated) {
      throw new SalvageStepFailed("unpushed list unreadable");
    }
    if (names.stdout.split("\0").some(isPossibleSecretFile)) {
      return skipped("possible secret file");
    }
    // The run's own repository, by URL: the broker's insteadOf rewrite
    // carries it to GitHub, so whatever the agent set remote.origin.url to
    // decides nothing.
    await ok("push", PUSH_SCRIPT, [
      `https://github.com/${args.repoFullName}.git`,
      workBranch,
    ]);
    return done(`pushed ${sha.slice(0, 8)} to ${workBranch}`, {
      branch: workBranch,
      sha,
    });
  } catch (err) {
    const reason =
      err instanceof SalvageStepFailed
        ? err.message
        : `runner threw (${err instanceof Error ? err.name : "unknown"})`;
    return done(`failed (${reason})`);
  }
}
