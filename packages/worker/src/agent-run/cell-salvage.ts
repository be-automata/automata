import type { CellExecResult, ICellProvider } from "@terragon/types/cell";
import { redactSecrets } from "@terragon/utils/redact";

import {
  runSalvageSteps,
  SalvageStepFailed,
  type SalvageResult,
} from "./abnormal-end";
import type { AgentCommandResult } from "./agent-command";
import { CELL_WORKSPACE } from "./cell-image";
import { appendGitConfig, botGitIdentity } from "./daemon-env";
import { hardenGitEnv } from "./untrusted-checkout-git";

/**
 * Phase 7a of #743: the WIP salvage of a timed-out cell run. A cell has no
 * pause, so the agent's process groups are frozen with an exec signal, then
 * the box's own step sequence (`runSalvageSteps`) commits the dirty tree and
 * pushes it to the run's work branch through the cell's git broker. The
 * broker fences that push to the exact ref and a push is one recorded effect
 * of the step's budget (cell-authority `beginEffect`), so an agent that spent
 * the budget gets a 429; that and every other failure only log a line.
 *
 * Calling this from the timeout path is phase 7b.
 */

/** The freeze (one exec) gets at most this long. */
export const CELL_FREEZE_BUDGET_MS = 3_000;

/**
 * The default bound for the whole salvage (every git step, the push last).
 * Phase 7b's 40 s capture budget splits as pull <= 15 s, freeze <= 3 s, final
 * flush <= 12 s, leaving this 10 s; a caller with more left passes it as
 * `budgetMs`.
 */
export const CELL_SALVAGE_BUDGET_MS = 10_000;

/** Output the salvage reads is capped here; a longer one counts as truncated. */
const MAX_STDOUT_CHARS = 1024 * 1024;

// The daemon is found by its image path (the `[/]` keeps pgrep from matching
// this very script). Its children in a process group of their own are the
// agent groups (the daemon spawns each agent detached); the daemon's own group
// and execd stay running. No daemon found: exit 3, nothing is signalled.
// POSIX sh only (the cell's /bin/sh is dash): `kill -s STOP --`, as the box's
// freeze writes it; dash reads `kill -STOP --` as a pid and signals nothing.
const FREEZE_SCRIPT =
  "d=$(pgrep -o -f '[/]opt/automata/daemon.js') || exit 3; " +
  'own=$(ps -o pgid= -p "$d" | tr -d " "); ' +
  'for c in $(pgrep -P "$d"); do ' +
  'g=$(ps -o pgid= -p "$c" | tr -d " "); ' +
  '[ -n "$g" ] && [ "$g" != "$own" ] && kill -s STOP -- "-$g"; ' +
  "done; exit 0";

/** The argv of the freeze exec: signals process groups only. */
export const CELL_FREEZE_ARGV: readonly string[] = [
  "/bin/sh",
  "-c",
  FREEZE_SCRIPT,
  "sh",
];

/** Race `step` against a wall clock: null when `ms` passes first. */
async function withinMs<T>(step: Promise<T>, ms: number): Promise<T | null> {
  step.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(ms, 0));
  });
  try {
    return await Promise.race([step, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Freeze the agent's process groups in the cell. Never throws, bounded by
 * `budgetMs`; false means nothing is known to be frozen (the salvage still
 * goes on, as the box's does).
 */
export async function freezeCellAgent({
  provider,
  cellId,
  budgetMs = CELL_FREEZE_BUDGET_MS,
}: {
  provider: ICellProvider;
  cellId: string;
  budgetMs?: number;
}): Promise<boolean> {
  try {
    const r = await withinMs(
      provider.exec(cellId, [...CELL_FREEZE_ARGV], { timeoutMs: budgetMs }),
      budgetMs,
    );
    return r !== null && r.exitCode === 0;
  } catch {
    return false;
  }
}

export interface SalvageCellWorkBranchArgs {
  provider: ICellProvider;
  cellId: string;
  /** The run's own work branch; the only ref the push names. */
  workBranch: string | undefined;
  /** The clone's broker URL, `https://<deployment>/api/cell/git/<owner>/<repo>.git`. */
  brokerGitUrl: string;
  botLogin: string;
  /** The effective run budget: names the limit in the commit message. */
  runExecutionTimeoutMs: number;
  log: (line: string) => void;
  /** The bound for the whole salvage; defaults to CELL_SALVAGE_BUDGET_MS. */
  budgetMs?: number;
}

/**
 * The git env of the salvage: hardened, the run's bot identity, no hooks, no
 * maintenance. It holds no secret: the vault puts the broker bearer on the
 * wire. Every value is a plain `KEY=VALUE` pair for `/usr/bin/env`.
 */
function salvageEnvPairs(botLogin: string): string[] {
  const identity = botGitIdentity(botLogin);
  const env = hardenGitEnv(
    appendGitConfig({ ...identity.env }, [
      ["credential.helper", ""],
      ...identity.config,
      ["safe.directory", CELL_WORKSPACE],
      ["push.pushOption", ""],
      ["maintenance.auto", "false"],
      ["gc.auto", "0"],
    ]),
  );
  return Object.entries(env).flatMap(([key, value]) =>
    value === undefined ? [] : [`${key}=${value}`],
  );
}

/** The exec argv of one salvage git step: `/usr/bin/env <pairs> /bin/sh -c <script> sh <args>`. */
export function cellSalvageArgv(
  envPairs: readonly string[],
  script: string,
  scriptArgs: readonly string[],
): string[] {
  return [
    "/usr/bin/env",
    ...envPairs,
    "/bin/sh",
    "-c",
    script,
    "sh",
    ...scriptArgs,
  ];
}

/**
 * Save a timed-out cell run's work: commit a dirty tree and push HEAD to the
 * run's own work branch through the broker. Never throws, never delays the
 * caller beyond `budgetMs`, opens no PR. Logs exactly one line:
 * `salvage: pushed <sha8> to <branch>` | `salvage: nothing to push` |
 * `salvage: failed (<reason>)` | `salvage: skipped (<reason>)`.
 */
export async function salvageCellWorkBranch(
  args: SalvageCellWorkBranchArgs,
): Promise<SalvageResult | null> {
  const done = (
    line: string,
    result: SalvageResult | null = null,
  ): SalvageResult | null => {
    args.log(redactSecrets(`salvage: ${line}`));
    return result;
  };
  const { workBranch } = args;
  if (!workBranch) return done("skipped (no work branch)");

  const budgetMs = args.budgetMs ?? CELL_SALVAGE_BUDGET_MS;
  const started = Date.now();
  const left = () => budgetMs - (Date.now() - started);
  const envPairs = salvageEnvPairs(args.botLogin);

  const git = async (
    script: string,
    scriptArgs: string[] = [],
  ): Promise<AgentCommandResult> => {
    const remaining = left();
    if (remaining <= 0) throw new SalvageStepFailed("budget exceeded");
    const r: CellExecResult | null = await withinMs(
      args.provider.exec(
        args.cellId,
        cellSalvageArgv(envPairs, script, scriptArgs),
        { cwd: CELL_WORKSPACE, timeoutMs: remaining },
      ),
      remaining,
    );
    if (r === null) throw new SalvageStepFailed("budget exceeded");
    return {
      exitCode: r.exitCode,
      stdout: r.stdout.slice(0, MAX_STDOUT_CHARS),
      timedOut: false,
      truncated: r.stdout.length > MAX_STDOUT_CHARS,
    };
  };

  try {
    const outcome = await runSalvageSteps({
      git,
      workBranch,
      runExecutionTimeoutMs: args.runExecutionTimeoutMs,
      pushUrl: args.brokerGitUrl,
    });
    if (outcome.kind === "skipped") return done(`skipped (${outcome.reason})`);
    if (outcome.kind === "nothing") return done("nothing to push");
    return done(`pushed ${outcome.sha.slice(0, 8)} to ${workBranch}`, {
      branch: workBranch,
      sha: outcome.sha,
    });
  } catch (err) {
    if (err instanceof SalvageStepFailed) {
      // A 403 (fence), a 429 (effect budget) or any other refusal: git's
      // stderr is not read, so the reason is one constant line.
      const reason = err.message.startsWith("push failed")
        ? "push failed"
        : err.message;
      return done(`failed (${reason})`);
    }
    return done(
      `failed (runner threw (${err instanceof Error ? err.name : "unknown"}))`,
    );
  }
}
