import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import type { OpenSandboxCellConfig } from "@terragon/sandbox/opensandbox-cell";
import {
  CELL_DAEMON_TOKEN_PLACEHOLDER,
  CELL_LEASE_STALE_MS,
  type CellCreatePlan,
  type ICellProvider,
} from "@terragon/types/cell";
import { redactSecrets } from "@terragon/utils/redact";

import {
  claimAbnormalEnd,
  postAbnormalEnd,
  type AbnormalEnd,
} from "./abnormal-end";
import {
  CELL_DAEMON_BUNDLE,
  CELL_DAEMON_SOCKET,
  CELL_MESSAGE_DIR,
  CELL_SELF_CHECK_ARGV,
  CELL_WORKSPACE,
  CELL_WRITE_MESSAGE_SH,
  cellCloneArgv,
  cellEntrypoint,
  cellGitConfigArgv,
} from "./cell-image";
import { teardownCellRun } from "./cell-teardown";
import {
  CellPlanRefusedError,
  CellPlanUnavailableError,
  CELL_PLAN_UNAVAILABLE_CODES,
  abortableSleep,
  type CellPlanResult,
  type FailedStep,
  type TeardownCallResult,
} from "./cell-www-client";
import { containerLanePolicy } from "./container-argv";
import { composeContainerSettings } from "./container-policy";
import { admitRunSlot } from "./run-admission";
import { formatRunStartLine } from "./run-lane";
import { classifyNextMessageError } from "./retry-classification";
import { getProcessWorkerId } from "./run-namespace";
import type { RunExecutor, RunExecutorInput } from "./run-executor";
import type { AgentRunOutput, PulledDaemonMessage } from "./types";
import {
  CellStepConflictError,
  CellTerminalUnconfirmedError,
  ThreadStatusHttpError,
  type CellLease,
  type EgressEventWire,
  type PollContext,
  type PollResult,
  type ThreadStatusPoll,
  type WwwClientOpts,
} from "./www-client";

/**
 * The cell executor (#656 PR-E): one run, executed in an OpenSandbox cell. The
 * second executor behind the `RunExecutor` seam; the box path is untouched.
 *
 * Every dependency is injected (the www calls, the provider factory, the clock,
 * sleep), so it runs in tests against fakes and in production against
 * `createOpenSandboxCellProvider`. A cell is torn down by `teardownCellRun`
 * (www revoke first), in one `finally`, on every exit. NEVER logged: the plan,
 * the message, the prompt, a vault entry, an exec stdout, a token.
 */

/** The setup heartbeat: a lease stamp at least this often, from the plan's 200 until the poll loop. */
export const CELL_SETUP_STAMP_MS = 60_000;
/** A heartbeat read's own timeout. */
const HEARTBEAT_TIMEOUT_MS = 10_000;
/** Failed beats in a row that fail the run (about 3 min, under the 5-min stale window). */
const HEARTBEAT_FAILURES = 3;
/** The retry budget for a terminal cell read that answers 500 (Contract 5). */
export const CELL_TERMINAL_RETRY = { tries: 6, delayMs: 5_000 } as const;
/** `refused` reads in a row (heartbeat and poll counted together) that mean a revoked attempt. */
const REFUSED_LIMIT = 2;
const SOCKET_WAIT_MS = 90_000;
const SOCKET_POLL_MS = 1_000;
const EXEC_STDERR_TAIL = 512;
const PGREP_TIMEOUT_MS = 10_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const CONFIRM_RETRY = { tries: 4, backoffMs: [1_000, 2_000, 4_000] } as const;

/** The image user (deploy/images/batteries/Dockerfile): uid 10001. */
const CELL_USER = { owner: "agent", group: "agent" } as const;
const HOME_CLAUDE_DIR = "/home/agent/.claude";
/** A far-future expiry, so the CLI never tries to refresh the placeholder login. */
const PLACEHOLDER_LOGIN_EXPIRY_MS = 4_102_444_800_000;
const MODEL_PLACEHOLDER = "automata-cell-model-placeholder";

export interface CellExecutorDeps {
  www: {
    fetchPlan: (
      opts: WwwClientOpts,
      body: { worker: string; epoch: string; requestId: string },
      signal?: AbortSignal,
    ) => Promise<CellPlanResult>;
    revoke: (
      opts: WwwClientOpts,
      attempt: number,
      signal: AbortSignal,
      retry?: { tries: number; backoffMs: readonly number[] },
    ) => Promise<{ result: TeardownCallResult | "unauthorized" }>;
    report: (
      opts: WwwClientOpts,
      attempt: number,
      outcome:
        | { outcome: "clean" }
        | { outcome: "incomplete"; failedSteps: FailedStep[] },
      signal: AbortSignal,
      flags: { retired: boolean },
    ) => Promise<TeardownCallResult>;
    nextMessage: (
      opts: WwwClientOpts,
      signal?: AbortSignal,
    ) => Promise<PulledDaemonMessage | null>;
    pollThreadStatus: (
      opts: WwwClientOpts,
      signal?: AbortSignal,
    ) => Promise<ThreadStatusPoll>;
    pollUntilTerminal: (
      ctx: PollContext,
      opts: WwwClientOpts,
      pollIntervalMs: number,
    ) => Promise<PollResult>;
    postEgress: (
      opts: WwwClientOpts,
      events: EgressEventWire[],
    ) => Promise<void>;
    postAbnormal: typeof postAbnormalEnd;
  };
  /** `createOpenSandboxCellProvider` in production. A closure with no I/O. */
  makeProvider: (cfg: OpenSandboxCellConfig) => ICellProvider;
  /** Resolves early (never rejects) when `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  /** A fresh 24-char base64url id (18 random bytes) for one plan fetch. */
  randomId: () => string;
  /** H7: runs whose terminal read retired the daemon token (onFailure must not post `run-failed`). */
  retiredRuns: Set<string>;
  /** E16-409: runs whose token www deleted on `cell_step_conflict`. */
  tokenGoneRuns: Set<string>;
  /** Runs a newer attempt fenced: onFailure must post nothing for them (the thread is the newer attempt's). */
  fencedRuns: Set<string>;
}

export { abortableSleep };

/**
 * The daemon message for a cell (H11): the pulled body with the PLACEHOLDER
 * token (the sidecar swaps in the real one on `/api/daemon-event`) and
 * `useCredits: false` whatever www sent, so the daemon's Claude adapter sets no
 * token env and uses the HOME login.
 */
export function buildCellMessage(
  pulled: PulledDaemonMessage,
  ids: { threadId: string; threadChatId: string },
): Record<string, unknown> {
  return {
    ...pulled,
    useCredits: false,
    token: CELL_DAEMON_TOKEN_PLACEHOLDER,
    threadId: ids.threadId,
    threadChatId: ids.threadChatId,
  };
}

/** A setup step that stopped because an internal abort (fence, stop, terminal, failure) fired. */
class SetupAbortedError extends Error {
  constructor() {
    super("cell setup aborted");
    this.name = "SetupAbortedError";
  }
}

function isTerminalWriteCode(code: string | undefined): boolean {
  return code === "cell_finish_failed" || code === "cell_retire_failed";
}

export function createCellExecutor(deps: CellExecutorDeps): RunExecutor {
  const epoch = String(deps.now());
  return {
    kind: "cell",
    run: (args) => runCell(deps, epoch, args),
  };
}

async function runCell(
  deps: CellExecutorDeps,
  epoch: string,
  args: RunExecutorInput,
): Promise<AgentRunOutput> {
  const { input, ctx, config, wwwOpts, runKey, abnormal, cellConfig } = args;
  const runSignal = ctx.abortController?.signal;
  const step = (msg: string) => ctx.log(`[agent-run ${input.threadId}] ${msg}`);
  const runId = wwwOpts.runExternalId ?? "";
  const ids = { threadId: input.threadId, threadChatId: input.threadChatId };

  // A poll slower than a quarter of the stale window could let a healthy
  // lease age out between reads.
  if (config.pollIntervalMs > CELL_LEASE_STALE_MS / 4) {
    throw new NonRetryableError(
      `cell_poll_interval_too_long: WORKER_POLL_INTERVAL_MS ${config.pollIntervalMs} exceeds ${CELL_LEASE_STALE_MS / 4}`,
    );
  }
  step(formatRunStartLine(input));

  // 1. Admission, the same as a box run: a cell still spends this box's memory.
  const admitted = await admitRunSlot({
    input,
    ctx,
    config,
    wwwOpts,
    runKey,
    signal: runSignal,
    step,
    admissionLog: step,
  });
  if (admitted.kind === "skipped") return admitted.output;
  const releaseAdmission = async () => {
    admitted.reservation?.release();
    await admitted.boxLock.release();
  };

  // 2. The plan, once per run invocation and never again after a create.
  // Nothing is revoked or reported on a failure here: no attempt is known.
  let plan: CellCreatePlan;
  let attempt: number;
  try {
    const fetched = await deps.www.fetchPlan(
      wwwOpts,
      {
        worker: getProcessWorkerId(),
        epoch,
        requestId: deps.randomId(),
      },
      runSignal,
    );
    if (!fetched.ok) {
      if (CELL_PLAN_UNAVAILABLE_CODES.has(fetched.code)) {
        throw new CellPlanUnavailableError(
          fetched.code as "cell_plan_unavailable" | "cell_plan_superseded",
          fetched.status,
        );
      }
      throw new CellPlanRefusedError(fetched.code, fetched.status);
    }
    ({ plan, attempt } = fetched);
  } catch (error) {
    await releaseAdmission();
    throw error;
  }

  // From here the attempt is open: every exit runs the teardown.
  const cellOpts: WwwClientOpts = { ...wwwOpts, cellAttempt: attempt };
  const deployment = plan.tags.deployment;
  const stepKey = plan.tags.stepKey;
  // The run's state, set by the lease handler and the heartbeat.
  const st = {
    fenced: false,
    stopRequested: false,
    terminal: false,
    terminalStatus: undefined as string | undefined,
    conflict: false,
    refusedStreak: 0,
    failure: null as Error | null,
    /** A heartbeat saw a terminal-write 500: settled in the main catch, before teardown (M1). */
    pendingSettle: null as ThreadStatusHttpError | null,
  };
  const inner = new AbortController();
  const live = runSignal
    ? AbortSignal.any([runSignal, inner.signal])
    : inner.signal;
  const markRetired = () => {
    if (runId) deps.retiredRuns.add(runId);
  };

  const onLease = (lease: CellLease): void => {
    switch (lease) {
      case "renewed":
        st.refusedStreak = 0;
        return;
      case "refused":
        st.refusedStreak += 1;
        if (st.refusedStreak >= REFUSED_LIMIT && st.failure === null) {
          abnormal.daemonStarted = true;
          st.failure = new NonRetryableError("cell_attempt_revoked");
          inner.abort();
        }
        return;
      case "superseded":
        // A database fact in www: one read is enough (Decision 12).
        st.fenced = true;
        if (runId) deps.fencedRuns.add(runId);
        inner.abort();
        return;
      case "finished":
        st.terminal = true;
        markRetired();
        return;
      case "error":
        step("cell.lease_error (ignored)");
        return;
    }
  };

  /** Settles a terminal read that answered a 500/401 the way the poll loop does (Contract 5, Decision 11). */
  const confirmRetired = async (
    signal: AbortSignal,
  ): Promise<"retired" | "gone" | "unknown"> => {
    const out = await deps.www.revoke(cellOpts, attempt, signal, CONFIRM_RETRY);
    if (out.result === "ok") return "retired";
    return out.result === "unauthorized" ? "gone" : "unknown";
  };

  /** After a terminal-read error code: the same retry budget as the poll (E16). */
  const settleTerminalError = async (
    first: ThreadStatusHttpError,
  ): Promise<void> => {
    let code = first.code;
    for (let tries = 1; ; tries++) {
      if (tries >= CELL_TERMINAL_RETRY.tries) {
        throw new CellTerminalUnconfirmedError(code ?? "unknown");
      }
      await deps.sleep(CELL_TERMINAL_RETRY.delayMs, runSignal);
      if (runSignal?.aborted) throw new SetupAbortedError();
      let poll: ThreadStatusPoll;
      try {
        poll = await deps.www.pollThreadStatus(
          cellOpts,
          runSignal
            ? AbortSignal.any([
                AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
                runSignal,
              ])
            : AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
        );
      } catch (error) {
        if (error instanceof ThreadStatusHttpError) {
          if (error.status === 409 && error.code === "cell_step_conflict") {
            throw new CellStepConflictError();
          }
          if (error.status === 500 && isTerminalWriteCode(error.code)) {
            code = error.code;
            continue;
          }
        }
        continue;
      }
      if (poll.kind === "auth-error") {
        if (poll.httpStatus === 401 && code === "cell_retire_failed") {
          const confirmed = await confirmRetired(
            AbortSignal.timeout(CELL_TERMINAL_RETRY.delayMs * 4),
          );
          if (confirmed === "retired") {
            st.terminal = true;
            markRetired();
            return;
          }
        }
        throw new CellTerminalUnconfirmedError(code ?? "unknown");
      }
      if (poll.terminal) {
        onLease("finished");
        st.terminal = true;
        st.terminalStatus = poll.status;
        return;
      }
    }
  };

  // 3. The setup heartbeat: a lease stamp every CELL_SETUP_STAMP_MS.
  const heartbeatStop = new AbortController();
  let heartbeatFailures = 0;
  const failHeartbeat = () => {
    heartbeatFailures += 1;
    step(`cell.heartbeat_failed ${heartbeatFailures}/${HEARTBEAT_FAILURES}`);
    if (heartbeatFailures >= HEARTBEAT_FAILURES && st.failure === null) {
      abnormal.daemonStarted = true;
      st.failure = new Error("cell_heartbeat_lost");
      inner.abort();
    }
  };
  const beat = async (): Promise<void> => {
    try {
      const poll = await deps.www.pollThreadStatus(
        cellOpts,
        AbortSignal.any([
          AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
          heartbeatStop.signal,
          live,
        ]),
      );
      if (poll.kind === "auth-error") {
        failHeartbeat();
        return;
      }
      heartbeatFailures = 0;
      if (poll.lease !== undefined) onLease(poll.lease);
      if (poll.terminal) {
        // A finished step during setup (E12): nothing is sent to the daemon.
        st.terminal = true;
        st.terminalStatus = poll.status;
        if (poll.lease === undefined) markRetired();
        inner.abort();
      } else if (poll.status === "stopping") {
        st.stopRequested = true;
        inner.abort();
      }
    } catch (error) {
      if (heartbeatStop.signal.aborted || live.aborted) return;
      if (error instanceof ThreadStatusHttpError) {
        if (error.status === 409 && error.code === "cell_step_conflict") {
          st.conflict = true;
          st.failure = new CellStepConflictError();
          inner.abort();
          return;
        }
        if (error.status === 500 && isTerminalWriteCode(error.code)) {
          // Setup is aborted at once (Decision 7); the retry budget and the
          // retired-token confirmation run in the main catch, BEFORE teardown.
          st.pendingSettle = error;
          inner.abort();
          return;
        }
      }
      failHeartbeat();
    }
  };
  void (async () => {
    while (!heartbeatStop.signal.aborted && !live.aborted) {
      await deps.sleep(CELL_SETUP_STAMP_MS, heartbeatStop.signal);
      if (heartbeatStop.signal.aborted || live.aborted) break;
      await beat();
    }
  })();

  let provider: ICellProvider | null = null;
  let cellId: string | null = null;
  let vaultRevoked = false;
  let result: AgentRunOutput | undefined;
  let thrown: { error: unknown } | null = null;

  const ensureLive = () => {
    if (live.aborted) throw new SetupAbortedError();
  };
  // Rejects the moment `live` aborts (a fence, a Stop, a lost heartbeat, the
  // run's timeout), so the teardown starts at once even while a provider call
  // is still in flight: the cell is deleted anyway (M2).
  const abortedLive = new Promise<never>((_, reject) => {
    if (live.aborted) reject(new SetupAbortedError());
    else {
      live.addEventListener("abort", () => reject(new SetupAbortedError()), {
        once: true,
      });
    }
  });
  abortedLive.catch(() => undefined); // read by the races below; never unhandled
  const raceLive = async <T>(call: Promise<T>): Promise<T> => {
    call.catch(() => undefined); // a call that loses the race must not become unhandled
    return Promise.race([call, abortedLive]);
  };
  const execOk = async (
    argv: string[],
    label: string,
    timeoutMs?: number,
    logStderr = true,
  ): Promise<void> => {
    ensureLive();
    const out = await raceLive(
      (provider as ICellProvider).exec(
        cellId as string,
        argv,
        timeoutMs !== undefined ? { timeoutMs } : undefined,
      ),
    );
    if (out.exitCode !== 0) {
      // The message write's stderr is never logged: it may echo the staged message.
      step(
        logStderr
          ? `cell setup: ${label} failed (exit ${out.exitCode}): ${redactSecrets(out.stderr).slice(-EXEC_STDERR_TAIL)}`
          : `cell setup: ${label} failed (exit ${out.exitCode})`,
      );
      throw new Error(`cell setup: ${label} failed (exit ${out.exitCode})`);
    }
  };
  const putFile = async (
    path: string,
    text: string,
    mode: number,
  ): Promise<void> => {
    ensureLive();
    await raceLive(
      (provider as ICellProvider).copyIn(
        cellId as string,
        path,
        new TextEncoder().encode(text),
        { mode, ...CELL_USER },
      ),
    );
  };

  try {
    // 4. The provider, per run (the entrypoint depends on the plan's host).
    // The config selectRunExecutor read, passed through: read once per run.
    const cfg = cellConfig;
    if (cfg === undefined || cfg.kind !== "on") {
      throw new CellPlanRefusedError("cells_unconfigured", 0);
    }
    let entrypoint: string[];
    try {
      entrypoint = cellEntrypoint(deployment);
    } catch {
      throw new NonRetryableError("cell_bad_deployment_host");
    }
    provider = deps.makeProvider({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      image: cfg.image.reference,
      entrypoint,
      selfCheck: { argv: CELL_SELF_CHECK_ARGV },
    });
    step(
      `cell: image=${cfg.image.digest} attempt=${attempt} deployment=${deployment}`,
    );

    // Before the create, a newer attempt removes its predecessors' cells on
    // this server (Decision 13): vault first, then quarantine, then delete.
    await raceLive(
      reapPriorAttempts(provider, { stepKey, deployment, attempt }, step),
    );
    ensureLive();

    // 5. Create. Once it has been sent the plan is never fetched again.
    const creating = provider.create(plan);
    try {
      ({ cellId } = await raceLive(creating));
    } catch (error) {
      if (error instanceof SetupAbortedError) {
        // Aborted while the create was in flight: the teardown's readback finds
        // a cell that already exists, and one that appears later is removed here.
        void removeLateCell(provider, creating, step);
        throw error;
      }
      const code =
        typeof (error as { code?: unknown })?.code === "string"
          ? (error as { code: string }).code
          : "unknown";
      throw new Error(`cell create failed: ${code}`);
    }
    ensureLive();

    // 6. The self-check's measured block is the one egress row a cell posts.
    try {
      await deps.www.postEgress(cellOpts, [
        {
          destinationHost: "example.org",
          destinationPort: 443,
          action: "deny",
          policyLevel: "domain",
          mode: "enforce",
          source: "worker",
        },
      ]);
    } catch {
      // Best effort: audit delivery never fails a run.
    }

    // 7. Bootstrap: the clone, the git identity, HOME, and the entry's socket.
    for (const argv of cellCloneArgv({
      brokerHost: deployment,
      repoFullName: input.repoFullName,
      branch: input.branch,
      workBranch: input.workBranch,
      baseBranch:
        input.baseBranch && input.baseBranch !== input.branch
          ? input.baseBranch
          : undefined,
    })) {
      await execOk(argv, `git ${argv[1] ?? ""}`, CLONE_TIMEOUT_MS);
    }
    step("cell: clone complete");
    for (const argv of cellGitConfigArgv(config.botLogin)) {
      await execOk(argv, "git config");
    }
    await execOk(
      ["/bin/mkdir", "-p", "-m", "700", HOME_CLAUDE_DIR],
      "mkdir home",
    );
    let batteries: unknown = null;
    try {
      const raw = await raceLive(
        provider.copyOut(cellId, `${HOME_CLAUDE_DIR}/settings.batteries.json`),
      );
      batteries = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      // Absent or unparseable: the hooks are simply not merged (as on the box).
    }
    await putFile(
      `${HOME_CLAUDE_DIR}/settings.json`,
      JSON.stringify(
        composeContainerSettings(containerLanePolicy("task"), batteries),
        null,
        2,
      ),
      600,
    );
    await putFile(
      "/home/agent/.claude.json",
      JSON.stringify({
        hasCompletedOnboarding: true,
        projects: {
          [CELL_WORKSPACE]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
          },
        },
      }),
      600,
    );
    // A placeholder login: the CLI needs a login to attempt a call, and the
    // vault's model binding sets the real bearer on api.anthropic.com. No real
    // token is ever written into the guest (R3).
    await putFile(
      `${HOME_CLAUDE_DIR}/.credentials.json`,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: MODEL_PLACEHOLDER,
          refreshToken: MODEL_PLACEHOLDER,
          expiresAt: PLACEHOLDER_LOGIN_EXPIRY_MS,
          scopes: ["user:inference", "user:profile"],
        },
      }),
      600,
    );
    // The entry is the create entrypoint: only wait for the daemon's socket.
    const socketDeadline = deps.now() + SOCKET_WAIT_MS;
    for (;;) {
      ensureLive();
      const probe = await raceLive(
        provider.exec(cellId, ["/usr/bin/test", "-S", CELL_DAEMON_SOCKET], {
          timeoutMs: PGREP_TIMEOUT_MS,
        }),
      );
      if (probe.exitCode === 0) break;
      if (deps.now() >= socketDeadline) {
        throw new Error(
          `cell daemon socket not ready after ${SOCKET_WAIT_MS}ms`,
        );
      }
      await deps.sleep(SOCKET_POLL_MS, live);
    }
    abnormal.daemonStarted = true;
    step("cell: daemon socket ready");

    // 8. The next message, with the real token, from the worker.
    ensureLive();
    let pulled: PulledDaemonMessage | null;
    try {
      pulled = await deps.www.nextMessage(cellOpts, live);
    } catch (error) {
      throw classifyNextMessageError(error);
    }
    if (!pulled) {
      step("next-message: 204 (nothing to run)");
      result = { ...ids, outcome: "nothing-to-run" };
    } else {
      step(
        `next-message: got message (agent=${pulled.agent}, model=${pulled.model})`,
      );
      // 9. The prompt rides in a file, never in argv (execd logs argv).
      const messagePath = `${CELL_MESSAGE_DIR}/msg-${deps.randomId()}.json`;
      await putFile(
        messagePath,
        JSON.stringify(buildCellMessage(pulled, ids)),
        600,
      );
      await execOk(
        ["/bin/bash", "-c", CELL_WRITE_MESSAGE_SH, "cell-write", messagePath],
        "message write",
        undefined,
        false,
      );
      step("cell: message written to the daemon");

      // 10. The poll loop takes over from the heartbeat.
      heartbeatStop.abort();
      let daemonGone = false;
      const cellProvider = provider;
      const liveCellId = cellId;
      const poll = await deps.www.pollUntilTerminal(
        {
          get cancelled() {
            return ctx.cancelled;
          },
          log: step,
          signal: live,
          agentFailure: () =>
            daemonGone
              ? new Error(
                  "the cell's daemon process exited mid-run without the thread reaching a terminal status",
                )
              : null,
          // The pgrep runs at most once per poll, before the read, with its own timeout.
          beforeStatusRead: async () => {
            try {
              const out = await raceLive(
                cellProvider.exec(
                  liveCellId,
                  [
                    "/usr/bin/pgrep",
                    "-f",
                    `[${CELL_DAEMON_BUNDLE[0]}]${CELL_DAEMON_BUNDLE.slice(1)}`,
                  ],
                  { timeoutMs: PGREP_TIMEOUT_MS },
                ),
              );
              daemonGone = out.exitCode === 1;
            } catch {
              // Unknown is not dead.
              daemonGone = false;
            }
          },
          onLease,
          cellTerminalRetry: { ...CELL_TERMINAL_RETRY },
          confirmRetired,
        },
        cellOpts,
        config.pollIntervalMs,
      );
      if (st.fenced || st.failure !== null || st.pendingSettle !== null) {
        throw new SetupAbortedError();
      }
      if (poll.outcome === "completed") {
        st.terminal = true;
        result = {
          ...ids,
          outcome: "completed",
          finalStatus: poll.finalStatus,
        };
      } else if (poll.outcome === "stopped") {
        result = { ...ids, outcome: "stopped", finalStatus: poll.finalStatus };
      } else {
        result = {
          ...ids,
          outcome: "cancelled",
          finalStatus: poll.finalStatus,
        };
      }
    }
  } catch (error) {
    if (error instanceof CellStepConflictError) st.conflict = true;
    if (st.pendingSettle !== null && !st.fenced && st.failure === null) {
      // A heartbeat saw a terminal-write 500: the same retry budget and the
      // retired-token confirmation as the poll, each read under its own 10 s
      // timeout, and BEFORE the teardown so its report lands on a settled token.
      const first = st.pendingSettle;
      st.pendingSettle = null;
      try {
        await settleTerminalError(first);
      } catch (settled) {
        if (settled instanceof CellStepConflictError) st.conflict = true;
        if (!(settled instanceof SetupAbortedError)) {
          abnormal.daemonStarted = true;
          st.failure =
            settled instanceof Error ? settled : new Error(String(settled));
        }
      }
    }
    if (st.fenced) {
      result = { ...ids, outcome: "fenced" };
    } else if (error instanceof SetupAbortedError) {
      if (st.failure !== null) thrown = { error: st.failure };
      else if (st.terminal) {
        result = {
          ...ids,
          outcome: "completed",
          finalStatus: st.terminalStatus,
        };
      } else if (st.stopRequested) {
        result = { ...ids, outcome: "stopped" };
      } else {
        // The run's own signal aborted (cancel or timeout).
        result = { ...ids, outcome: "cancelled" };
      }
    } else {
      thrown = { error };
    }
  } finally {
    heartbeatStop.abort();
  }
  // A terminal read that confirmed the retire, while the poll loop was running.
  if (st.conflict && thrown === null && st.failure !== null) {
    thrown = { error: st.failure };
  }

  // The finally: claim the end, then R -> T -> B -> A -> P, then give the slot back.
  try {
    if (st.fenced) {
      // The fence is a database fact: the vault goes FIRST, before anything
      // else is stopped or any www call is made, to shut the window in which
      // this cell's daemon can still post daemon-events (R9).
      if (provider !== null && cellId !== null) {
        try {
          await provider.revoke(cellId);
          vaultRevoked = true;
        } catch {
          vaultRevoked = false;
        }
      }
      abnormal.claimed = true; // no end: the outer catch posts nothing
    }
    let end: AbnormalEnd | null = null;
    if (!st.fenced && !st.conflict) {
      end = claimAbnormalEnd(abnormal, {
        thrown: thrown ?? undefined,
        cancelled:
          ctx.cancelled || ctx.abortController?.signal.aborted === true,
        starvation: null,
      });
    } else {
      abnormal.claimed = true;
    }
    if (st.conflict && runId) deps.tokenGoneRuns.add(runId);
    const teardownProvider = provider;
    if (teardownProvider !== null || attempt > 0) {
      const noProvider: Pick<
        ICellProvider,
        "revoke" | "quarantine" | "delete" | "listByTags"
      > = {
        revoke: async () => {},
        quarantine: async () => {},
        delete: async () => "gone",
        listByTags: async () => [] as never,
      };
      const finalEnd = end;
      await teardownCellRun(
        {
          stepKey,
          attempt,
          deployment,
          cellId,
          skipWww: st.conflict,
          vaultRevoked,
        },
        {
          // Each www call has its OWN signal: the run's may already be aborted.
          revoke: async (a, signal) => {
            const out = await deps.www.revoke(cellOpts, a, signal);
            return {
              result: out.result === "unauthorized" ? "failed" : out.result,
            };
          },
          report: (a, outcome, signal) =>
            deps.www.report(cellOpts, a, outcome, signal, {
              retired: runId !== "" && deps.retiredRuns.has(runId),
            }),
          provider: teardownProvider ?? noProvider,
          postAbnormal: async () => {
            if (finalEnd) {
              await deps.www.postAbnormal(abnormal, finalEnd, {
                wwwOpts,
                log: step,
              });
            }
          },
          now: deps.now,
          log: step,
        },
      );
    }
  } finally {
    await releaseAdmission();
  }

  if (thrown !== null) throw thrown.error;
  return result ?? { ...ids, outcome: "cancelled" };
}

/**
 * Removes the cells of earlier attempts of this step on THIS server before a
 * newer attempt's create. Entries with an equal or higher attempt are never
 * touched. A failure is logged and never blocks the create: the predecessor's
 * attempt is already fenced in www and the reconciler reaps it.
 */
async function reapPriorAttempts(
  provider: ICellProvider,
  key: { stepKey: string; deployment: string; attempt: number },
  log: (line: string) => void,
): Promise<void> {
  if (key.attempt <= 1) return;
  let listed: Awaited<ReturnType<ICellProvider["listByTags"]>>;
  try {
    listed = await provider.listByTags({
      automata: "cell",
      stepKey: key.stepKey,
      deployment: key.deployment,
    });
  } catch {
    log(
      `cell.prior_reap_failed ${JSON.stringify({ stepKey: key.stepKey, attempt: key.attempt })}`,
    );
    return;
  }
  for (const entry of listed) {
    const old = Number(entry.tags.attempt);
    if (!Number.isInteger(old) || old >= key.attempt) continue;
    try {
      await provider.revoke(entry.cellId);
      await provider.quarantine(entry.cellId);
      await provider.delete(entry.cellId);
    } catch {
      log(
        `cell.prior_reap_failed ${JSON.stringify({ stepKey: key.stepKey, attempt: old })}`,
      );
    }
  }
}

/**
 * A create that was in flight when the run aborted: if it later returns a cell
 * the teardown's readback missed, remove it (best effort, never throws).
 */
async function removeLateCell(
  provider: ICellProvider,
  creating: Promise<{ cellId: string }>,
  log: (line: string) => void,
): Promise<void> {
  try {
    const { cellId } = await creating;
    await provider.revoke(cellId);
    await provider.quarantine(cellId);
    await provider.delete(cellId);
  } catch {
    log("cell.late_create_cleanup_failed");
  }
}
