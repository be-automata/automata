import { redactSecrets } from "@terragon/utils/redact";

import { runAsAgent, type RunAsAgent } from "./agent-command";
import {
  appendGitConfig,
  brokeredGitAuthConfig,
  buildRunProxyEnv,
  gitProxyAuthConfig,
  type BrokerHandoff,
} from "./daemon-env";
import {
  disallowedLocalGitConfigKeys,
  EXIT_UNSAFE_GITDIR,
  GIT_LOCAL_CONFIG_GUARD_SCRIPT,
} from "./git-local-config-guard";
import { formatMemoryMax, MemoryStarvationError } from "./retry-classification";
import { hardenGitEnv } from "./self-heal-fix-check";
import type { TerminalCause } from "./types";
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
    const minutes = Math.round(o.runExecutionTimeoutMs / 60_000);
    return `The run reached its ${minutes}-minute limit.`;
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
    salvage = null,
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

/** The hard budget for the whole commit + push, on a signal of its own. */
export const SALVAGE_BUDGET_MS = 60_000;
export const SALVAGE_COMMIT_MESSAGE =
  "wip: run timed out at 30m (automata salvage)";

// Every script is a module constant; the branch, the message and the push URL
// travel only as positional arguments ($1, $2), the same injection posture as
// the self-heal checks (agent-command.ts). `exec git`: no shell stays between
// the runner and git, so the process a budget kill reaches is git itself.
const REF_FORMAT_SCRIPT = 'exec git check-ref-format "refs/heads/$1"';
// --ignore-submodules=all: a status of a submodule would run git in it, with
// ITS local config, which the guard never read.
const STATUS_SCRIPT = "exec git status --porcelain --ignore-submodules=all";
const ADD_SCRIPT = "exec git add -A";
const COMMIT_SCRIPT =
  'exec git commit --quiet --no-verify --no-gpg-sign -m "$1"';
const HEAD_SCRIPT = 'exec git rev-parse --verify --quiet "HEAD^{commit}"';
// Commits HEAD holds that no origin/* ref does: the agent's unpushed commits
// (and the salvage commit). A work branch cut fresh from the base and never
// committed to counts 0, so it is not pushed as an empty copy of the base.
const UNPUSHED_SCRIPT = "exec git rev-list --count HEAD --not --remotes=origin";
// Never --force, never a second ref: one explicit refspec; tags, submodules
// and signing off whatever push.* the allowlist let the agent write.
const PUSH_SCRIPT =
  'exec git push --quiet --no-verify --no-follow-tags --recurse-submodules=no --no-signed -- "$1" "HEAD:refs/heads/$2"';
/** `git status` output is only tested for being empty; a cap is enough. */
const STATUS_MAX_STDOUT_BYTES = 64 * 1024;

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
  log: (line: string) => void;
  run?: RunAsAgent;
  budgetMs?: number;
}

/**
 * The env every salvage git runs with: the agent's own brokered auth
 * (brokeredGitAuthConfig, the one the daemon env carries — never a second
 * path, never the installation token), the run's bot identity, the run's
 * egress proxy, and hardenGitEnv's command-scope overrides (no hooks, no
 * fsmonitor, no global/system config) over the agent-writable .git/config.
 *
 * Nothing from a HOME either (review F2): HOME and XDG_CONFIG_HOME point at
 * /dev/null and the attributes/excludes files are pinned to /dev/null at
 * command scope, so even a sudo that resets HOME to the agent account's
 * persistent home cannot hand git a config, attributes or ignore file from
 * it (GIT_CONFIG_GLOBAL is /dev/null too, from hardenGitEnv). push.pushOption
 * is reset (an empty value clears the list): the allowlist admits push.*.
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
  let env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (agentUser) {
    env.USER = agentUser;
    env.LOGNAME = agentUser;
  }
  env.HOME = "/dev/null";
  env.XDG_CONFIG_HOME = "/dev/null";
  // Same identity, both ways, as buildDaemonEnv: the env wins over any
  // user.* the agent wrote into .git/config.
  const botEmail = `${botLogin}@users.noreply.github.com`;
  env.GIT_AUTHOR_NAME = botLogin;
  env.GIT_AUTHOR_EMAIL = botEmail;
  env.GIT_COMMITTER_NAME = botLogin;
  env.GIT_COMMITTER_EMAIL = botEmail;
  env = appendGitConfig(env, [
    ...brokeredGitAuthConfig(broker),
    ["credential.helper", ""],
    ["user.name", botLogin],
    ["user.email", botEmail],
    ...(agentUser
      ? ([["safe.directory", workdir]] as Array<[string, string]>)
      : []),
    ...gitProxyAuthConfig(egressProxyUrl),
    ["core.attributesFile", "/dev/null"],
    ["core.excludesFile", "/dev/null"],
    ["push.pushOption", ""],
  ]);
  if (egressProxyUrl) env = buildRunProxyEnv(egressProxyUrl, env);
  return hardenGitEnv(env);
}

/**
 * #437 Part B: save a timed-out task run's work before its checkout is
 * deleted. Called in the teardown after the agent is dead (daemon killed,
 * uid escapees reaped: nothing writes the tree) and before the git broker
 * closes (the push needs it). As the agent uid, in the checkout:
 *
 *   1. a dirty tree is committed (`git add -A`, SALVAGE_COMMIT_MESSAGE, the
 *      run's bot identity);
 *   2. then, dirty or clean, HEAD is pushed to the work branch — and only
 *      there — when it holds commits no origin/* ref does (the salvage
 *      commit, or commits the agent made and never pushed).
 *
 * The commit and push share one hard 60 s budget on a FRESH signal (the
 * run's own is already aborted). Never throws and never changes the cause;
 * logs exactly one line: `salvage: pushed <sha8> to <branch>` |
 * `salvage: nothing to save` | `salvage: failed (<reason>)` |
 * `salvage: skipped (<reason>)`. A reason is constant text (runAsAgent
 * discards stderr, so no URL or credential can reach it), redacted anyway.
 * No PR is opened.
 *
 * The checkout's .git is the agent's. Before any other git, the shared
 * local-config guard (git-local-config-guard.ts, the self-heal fix check's)
 * runs; any key outside its allowlist — a pushInsteadOf, a pushurl, a longer
 * insteadOf than the broker's (each redirects the push), a filter driver or a
 * receivepack (each runs a command outside the removed run cgroup) — skips
 * the salvage: `skipped (unsafe local git config)`. The self-heal allowlist
 * fits as-is: what it admits beyond a plain clone is user.*, branch
 * tracking, remote.origin.(url|fetch) and single-level push.* and pull.*; the
 * push goes by URL with one refspec (origin and branch tracking decide
 * nothing), the identity is set by env, and every push.* key that changes
 * what or how it pushes is overridden on the command (tags, submodules,
 * signing, push options). A stricter list would only throw away the work of
 * an agent that ran `git config push.autoSetupRemote true`.
 *
 * A budget kill is SIGKILL to the runner's child: as the agent uid that is
 * sudo, which cannot relay it, so git may outlive the budget for a moment.
 * That is bounded by the second agent-uid reap the workflow runs right
 * after the salvage (workflow.ts), before the broker closes.
 *
 * Why a container run is skipped (ADR-013, dev-only): its only route to
 * GitHub is meant to be the git broker bridged in over a unix socket (C3,
 * #430), which does not exist yet — the git broker listens on host TCP
 * loopback, which a `--network none` container cannot reach, and a container
 * run gets no broker at all today (container-daemon-process.ts copyInPolicy),
 * so its agent cannot push either. A salvage container would need that
 * bridge built first. Running the git on the HOST instead, as the worker,
 * would execute the container-written .git/config and attributes (filter
 * drivers) as the worker uid: a way out of the container's hardening. So it
 * logs `salvage: skipped (container run)` until C3 lands the bridge.
 */
export async function salvageWorkBranch(
  args: SalvageWorkBranchArgs,
): Promise<SalvageResult | null> {
  if (args.cause !== "timeout") return null;
  const log = (line: string) => args.log(redactSecrets(`salvage: ${line}`));
  const skipped = (reason: string): null => {
    log(`skipped (${reason})`);
    return null;
  };
  const { workBranch, broker } = args;
  if (!args.enabled) return skipped("disabled");
  if (!workBranch) return skipped("no work branch");
  if (args.lockLost) return skipped("lock lost");
  if (args.containerRun) return skipped("container run");
  if (!broker) return skipped("no git broker");
  if (!REPO_SLUG.test(args.repoFullName)) {
    return skipped("invalid repository name");
  }

  const run = args.run ?? runAsAgent;
  const budgetMs = args.budgetMs ?? SALVAGE_BUDGET_MS;
  const budget = AbortSignal.timeout(budgetMs);
  const deadline = Date.now() + budgetMs;
  let env: NodeJS.ProcessEnv = {};
  const git = async (
    script: string,
    scriptArgs: string[],
    maxStdoutBytes?: number,
  ) => {
    if (budget.aborted) throw new SalvageStepFailed("budget exceeded");
    const r = await run({
      agentUser: args.agentUser,
      cwd: args.workdir,
      script,
      args: scriptArgs,
      env,
      timeoutMs: Math.max(1, deadline - Date.now()),
      signal: budget,
      ...(maxStdoutBytes !== undefined ? { maxStdoutBytes } : {}),
    });
    if (r.timedOut || budget.aborted) {
      throw new SalvageStepFailed("budget exceeded");
    }
    return r;
  };
  const ok = async (
    verb: string,
    script: string,
    scriptArgs: string[] = [],
    maxStdoutBytes?: number,
  ) => {
    const r = await git(script, scriptArgs, maxStdoutBytes);
    if (r.exitCode !== 0) {
      throw new SalvageStepFailed(
        `${verb} failed (exit ${r.exitCode ?? "killed"})`,
      );
    }
    return r;
  };

  try {
    env = salvageGitEnv({ ...args, broker });
    const guard = await git(GIT_LOCAL_CONFIG_GUARD_SCRIPT, []);
    if (guard.exitCode === EXIT_UNSAFE_GITDIR) {
      return skipped("unsafe local git config");
    }
    if (guard.exitCode !== 0 || guard.truncated) {
      throw new SalvageStepFailed(
        `config guard failed (exit ${guard.exitCode ?? "killed"})`,
      );
    }
    if (disallowedLocalGitConfigKeys(guard.stdout).length > 0) {
      return skipped("unsafe local git config");
    }
    await ok("work branch check", REF_FORMAT_SCRIPT, [workBranch]);
    const status = await ok(
      "status",
      STATUS_SCRIPT,
      [],
      STATUS_MAX_STDOUT_BYTES,
    );
    const dirty = status.truncated || status.stdout.trim().length > 0;
    if (dirty) {
      await ok("add", ADD_SCRIPT);
      await ok("commit", COMMIT_SCRIPT, [SALVAGE_COMMIT_MESSAGE]);
    }
    const head = await git(HEAD_SCRIPT, []);
    const sha = head.stdout.trim();
    if (head.exitCode !== 0 || !FULL_SHA.test(sha)) {
      // No commit at all (an empty repository): nothing was ever made.
      if (!dirty) {
        log("nothing to save");
        return null;
      }
      throw new SalvageStepFailed("rev-parse failed");
    }
    const unpushed = await ok("rev-list", UNPUSHED_SCRIPT);
    const count = Number.parseInt(unpushed.stdout.trim(), 10);
    if (!Number.isSafeInteger(count)) {
      throw new SalvageStepFailed("rev-list output unreadable");
    }
    if (count === 0) {
      log("nothing to save");
      return null;
    }
    // The run's own repository, by URL: the broker's insteadOf rewrite
    // carries it to GitHub, so whatever the agent set remote.origin.url to
    // decides nothing.
    await ok("push", PUSH_SCRIPT, [
      `https://github.com/${args.repoFullName}.git`,
      workBranch,
    ]);
    log(`pushed ${sha.slice(0, 8)} to ${workBranch}`);
    return { branch: workBranch, sha };
  } catch (err) {
    const reason =
      err instanceof SalvageStepFailed
        ? err.message
        : `runner threw (${err instanceof Error ? err.name : "unknown"})`;
    log(`failed (${reason})`);
    return null;
  }
}
