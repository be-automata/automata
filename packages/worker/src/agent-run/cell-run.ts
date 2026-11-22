import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import type { OpenSandboxCellConfig } from "@terragon/sandbox/opensandbox-cell";
import {
  CELL_MEMORY_BYTES,
  CELL_DAEMON_TOKEN_PLACEHOLDER,
  CELL_LEASE_STALE_MS,
  type CellCreatePlan,
  type ICellProvider,
} from "@terragon/types/cell";
import type { CellSessionManifest } from "@terragon/types/cell-session-checkpoint";
import { createValueRedactor } from "@terragon/utils/redact";

import {
  claimAbnormalEnd,
  postAbnormalEnd,
  type AbnormalEnd,
  type AbnormalEndState,
  type SalvageResult,
} from "./abnormal-end";
import {
  CELL_DAEMON_BUNDLE,
  CELL_DAEMON_SOCKET,
  CELL_GH_CONFIG_DIR,
  CELL_GH_NOTE,
  CELL_MESSAGE_DIR,
  CELL_SELF_CHECK_ARGV,
  CELL_WORKSPACE,
  CELL_WRITE_MESSAGE_SH,
  cellCloneArgv,
  cellEntrypoint,
  cellGhSetup,
  cellGitConfigArgv,
} from "./cell-image";
import {
  filterRepoEnv,
  repoEnvDroppedNote,
  type FilteredRepoEnv,
} from "./repo-env";
import {
  CELL_FREEZE_BUDGET_MS,
  freezeCellAgent,
  salvageCellWorkBranch,
} from "./cell-salvage";
import { prepareCheckpoint, type TurnState } from "./cell-session-checkpoint";
import { createSessionRedactor } from "./cell-session-redact";
import { teardownCellRun } from "./cell-teardown";
import {
  CELL_TEST_DB_ENV,
  CELL_TEST_DB_MKDIR_ARGV,
  CELL_TEST_DB_PASSWORD_FILE,
  CELL_TEST_DB_READY_ARGV,
  CELL_TEST_DB_ROLE_SH,
  CELL_TEST_DB_START_SH,
  CELL_TEST_DB_STOP_SH,
  cellTestDbUrl,
  planCellTestDb,
} from "./cell-test-db";
import {
  CellPlanRefusedError,
  CellPlanUnavailableError,
  CELL_PLAN_UNAVAILABLE_CODES,
  withTimeout,
  type CellPlanResult,
  type CheckpointResult,
  type FailedStep,
  type TeardownCallResult,
} from "./cell-www-client";
import { containerLanePolicy } from "./container-argv";
import { composeContainerSettings } from "./container-policy";
import { admitRunSlot } from "./run-admission";
import { formatRunStartLine, resolveRunLane } from "./run-lane";
import type { Reservation } from "./headroom";
import { parseMemoryAnon } from "./run-memory";
import { classifyNextMessageError } from "./retry-classification";
import { getProcessWorkerId } from "./run-namespace";
import {
  CONTAINER_PINS_FILE,
  MAX_MARKER_BYTES,
  isSafeFlutterVersion,
  type CheckoutProbe,
} from "./container-entry";
import {
  FLUTTER_MARKER_FILES,
  detectFlutterRequirementFrom,
  flutterAgentNote,
  flutterJournalLine,
  flutterInstallFailedLine,
  flutterInstallFailedNote,
  flutterWrapperArgv,
  selectFlutterSdk,
  type FlutterRequirement,
  type FlutterSelection,
} from "./flutter-sdk";
import type { RunExecutor, RunExecutorInput } from "./run-executor";
import type { AgentRunOutput, PulledDaemonMessage } from "./types";
import type { RunEndMark } from "./run-end-marks";
import {
  CellStepConflictError,
  CellTerminalUnconfirmedError,
  ThreadStatusHttpError,
  createTerminalReadRetry,
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
const FLUTTER_EXEC_TIMEOUT_MS = 20_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const CONFIRM_RETRY = { tries: 4, backoffMs: [1_000, 2_000, 4_000] } as const;
/** The test database's readiness budget (#707): well under one setup stamp. */
const TEST_DB_READY_MS = 30_000;
const TEST_DB_POLL_MS = 500;
/** initdb + a non-waiting start; with the 30 s ready budget the steps stay under one setup stamp. */
const TEST_DB_START_TIMEOUT_MS = 20_000;

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
  /**
   * #743 phase 6: the per-turn session capture. Off unless BOTH `checkpoint`
   * and `sessionContinuation` are set and the latter returns true for the run
   * (phase 11 wires the `cellSessionContinuation` flag here; the default is off).
   */
  sessionContinuation?: () => boolean;
  checkpoint?: {
    putBlob: (
      opts: WwwClientOpts,
      sha256: string,
      bytes: Uint8Array,
      signal: AbortSignal,
    ) => Promise<CheckpointResult<{ created: boolean }>>;
    commit: (
      opts: WwwClientOpts,
      manifest: CellSessionManifest,
      expectedVersion: number,
      signal: AbortSignal,
    ) => Promise<CheckpointResult<{ version: number }>>;
  };
  /** A fresh 24-char base64url id (18 random bytes) for one plan fetch. */
  randomId: () => string;
  /** A fresh 48-char hex password (24 random bytes) for one cell's test database (#707). */
  testDbPassword: () => string;
  /** The box test-services file (tests); default BOX_TEST_SERVICES_ENV_PATH. */
  boxTestServicesEnvPath?: string;
  /**
   * How the run ended, for onFailure (run-end-marks.ts): `retired` (the terminal
   * read retired the token, H7), `tokenGone` (E16-409) or `fenced` (a newer
   * attempt owns the thread). The registry keeps the strongest mark per run.
   */
  marks: { mark: (runId: string, kind: RunEndMark) => void };
}

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

/** The test database's readiness budget ran out; its message holds no exec text, so it is logged. */
class TestDbNotReadyError extends Error {
  constructor() {
    super(`cell test database not ready after ${TEST_DB_READY_MS}ms`);
    this.name = "TestDbNotReadyError";
  }
}

/** The run's test database state: a password (and its URL) only when one is started. */
function cellTestDbState(
  plan: "start" | "owner" | "off",
  newPassword: () => string,
): CellRunState["testDb"] {
  if (plan !== "start") return { plan };
  const password = newPassword();
  return { plan, password, url: cellTestDbUrl(password) };
}

export function createCellExecutor(deps: CellExecutorDeps): RunExecutor {
  const epoch = String(deps.now());
  return {
    kind: "cell",
    run: (args) => runCell(deps, epoch, args),
  };
}

/** What the run knows, shared by the heartbeat, the bootstrap, the exit decision and the teardown. */
interface CellRunState {
  deps: CellExecutorDeps;
  args: RunExecutorInput;
  step: (msg: string) => void;
  runId: string;
  ids: { threadId: string; threadChatId: string };
  runSignal: AbortSignal | undefined;
  /** Internal abort: a fence, a Stop, a terminal read, a failure ends setup. */
  inner: AbortController;
  /** The run's signal and the internal one. */
  live: AbortSignal;
  /** Rejects the moment `live` aborts (see raceLive). */
  abortedLive: Promise<never>;
  heartbeatStop: AbortController;
  /** #749: stops the memory sampler at the run's end (the heartbeat stops at the message write). */
  memorySampleStop: AbortController;
  /** #743: stops the per-turn session capture loop at the run's end, before teardown. */
  captureStop: AbortController;
  /**
   * #743 phase 7b: bounds the capture's pulls. Unlike the run's own signal it
   * stays live through a timeout, so an in-flight pull can finish inside the
   * timeout capture budget (F2); aborted at once on every other end.
   */
  captureAbort: AbortController;
  /** #743: the running capture, when the gate is on. */
  capture: CaptureHandle | null;
  cellOpts: WwwClientOpts;
  attempt: number;
  stepKey: string;
  deployment: string;
  abnormal: AbnormalEndState;
  provider: ICellProvider | null;
  cellId: string | null;
  /** The owner's repo env, filtered for a cell (#706). Its values are never logged. */
  repoEnv: FilteredRepoEnv;
  /** The 4+ char repo env value scrub for exec text, run on the whole text before a cut. */
  scrub: (text: string) => string;
  /** What this run does about a test database (#707), and its password when it starts one. Never logged. */
  testDb:
    | { plan: "start"; password: string; url: string }
    | { plan: "owner" | "off" };
  /** Whether the settings `env` block carries the test database URL (set by bootstrap). */
  testDbDelivered: boolean;
  st: {
    fenced: boolean;
    stopRequested: boolean;
    terminal: boolean;
    terminalStatus: string | undefined;
    conflict: boolean;
    /** This run's terminal read retired the token (the report's `retired` flag). */
    retired: boolean;
    refusedStreak: number;
    failure: Error | null;
    /** A heartbeat saw a terminal-write 500: settled in decideExit, before teardown (M1). */
    pendingSettle: ThreadStatusHttpError | null;
  };
}

async function runCell(
  deps: CellExecutorDeps,
  epoch: string,
  args: RunExecutorInput,
): Promise<AgentRunOutput> {
  const { input, ctx, config, wwwOpts, runKey, abnormal, cellConfig } = args;
  const runSignal = ctx.abortController?.signal;
  // The repo env value scrub (#706), the dropped values too (a dropped value
  // can still be echoed). Exec text, which can echo anything, is scrubbed from
  // 4 chars; every cell log line from 8, so a common short value (`agent`,
  // `true`) cannot blank the platform's own words in every line.
  const repoEnv = filterRepoEnv(args.secrets.repoEnv);
  // The test database (#707): its password is scrubbed like a repo env value.
  const testDbPlan = planCellTestDb({
    input,
    lane: resolveRunLane(input),
    repoEnv: repoEnv.env,
    envPath: deps.boxTestServicesEnvPath,
  });
  const testDb = cellTestDbState(testDbPlan, deps.testDbPassword);
  const repoValues = [
    ...Object.values(args.secrets.repoEnv ?? {}),
    ...(testDb.plan === "start" ? [testDb.password] : []),
  ];
  const scrub = createValueRedactor(repoValues);
  const scrubLine = createValueRedactor(repoValues, 8);
  const step = (msg: string) =>
    ctx.log(scrubLine(`[agent-run ${input.threadId}] ${msg}`));
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
    // #749: the cell's memory is outside this run's cgroup; reserve all of it.
    commitBytes: CELL_MEMORY_BYTES,
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
      throw new CellPlanRefusedError(
        fetched.code,
        fetched.status,
        fetched.reason,
      );
    }
    ({ plan, attempt } = fetched);
  } catch (error) {
    await releaseAdmission();
    throw error;
  }

  // From here the attempt is open: every exit runs the teardown.
  const inner = new AbortController();
  const live = runSignal
    ? AbortSignal.any([runSignal, inner.signal])
    : inner.signal;
  const abortedLive = new Promise<never>((_, reject) => {
    if (live.aborted) reject(new SetupAbortedError());
    else {
      live.addEventListener("abort", () => reject(new SetupAbortedError()), {
        once: true,
      });
    }
  });
  abortedLive.catch(() => undefined); // read by raceLive; never unhandled
  const r: CellRunState = {
    deps,
    args,
    step,
    runId: wwwOpts.runExternalId ?? "",
    ids,
    runSignal,
    inner,
    live,
    abortedLive,
    heartbeatStop: new AbortController(),
    memorySampleStop: new AbortController(),
    captureStop: new AbortController(),
    captureAbort: new AbortController(),
    capture: null,
    cellOpts: { ...wwwOpts, cellAttempt: attempt },
    attempt,
    stepKey: plan.tags.stepKey,
    deployment: plan.tags.deployment,
    abnormal,
    provider: null,
    cellId: null,
    repoEnv,
    scrub,
    testDb,
    testDbDelivered: false,
    st: {
      fenced: false,
      stopRequested: false,
      terminal: false,
      terminalStatus: undefined,
      conflict: false,
      retired: false,
      refusedStreak: 0,
      failure: null,
      pendingSettle: null,
    },
  };
  const { st } = r;

  // 3. The setup heartbeat: a lease stamp every CELL_SETUP_STAMP_MS.
  startHeartbeat(r);

  let result: AgentRunOutput | undefined;
  let thrown: { error: unknown } | null = null;
  /** When the poll loop (or the throw that ended it) returned: the timeout capture's clock starts here. */
  let pollReturnedAt: number | null = null;
  try {
    // 4. The provider, per run (the entrypoint depends on the plan's host).
    // The config selectRunExecutor read is passed through: read once per run.
    if (cellConfig === undefined || cellConfig.kind !== "on") {
      throw new CellPlanRefusedError("cells_unconfigured", 0);
    }
    let entrypoint: string[];
    try {
      entrypoint = cellEntrypoint(r.deployment);
    } catch {
      throw new NonRetryableError("cell_bad_deployment_host");
    }
    const provider = deps.makeProvider({
      baseUrl: cellConfig.baseUrl,
      apiKey: cellConfig.apiKey,
      image: cellConfig.image.reference,
      entrypoint,
      selfCheck: { argv: CELL_SELF_CHECK_ARGV },
    });
    r.provider = provider;
    step(
      `cell: image=${cellConfig.image.digest} attempt=${attempt} deployment=${r.deployment}`,
    );

    // Before the create, a newer attempt removes its predecessors' cells on
    // this server (Decision 13): vault first, then quarantine, then delete.
    await raceLive(
      r,
      reapPriorAttempts(
        provider,
        { stepKey: r.stepKey, deployment: r.deployment, attempt },
        step,
      ),
    );
    ensureLive(r);

    // 5. Create. Once it has been sent the plan is never fetched again.
    const creating = provider.create(plan);
    try {
      ({ cellId: r.cellId } = await raceLive(r, creating));
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
    ensureLive(r);

    // 6. The self-check's measured block is the one egress row a cell posts.
    try {
      await deps.www.postEgress(r.cellOpts, [
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
    await bootstrap(r);
    // #749: the cell's memory is in its own cgroup, outside this run's; sample
    // what the kernel already charges it so the reservation holds only the rest
    // (a busy cell is otherwise counted twice: in Committed_AS and reserved).
    startCellMemorySampler(r, admitted.reservation);

    // 8. The next message, with the real token, from the worker.
    ensureLive(r);
    let pulled: PulledDaemonMessage | null;
    try {
      pulled = await deps.www.nextMessage(r.cellOpts, live);
    } catch (error) {
      // An abort (a Stop, a fence, a terminal read, the run's cancel) rejects the
      // pending read: let decideExit pick that outcome. A real error on a live
      // signal keeps its classification (4xx NonRetryable, 5xx/network retryable).
      if (r.live.aborted) throw new SetupAbortedError();
      throw classifyNextMessageError(error);
    }
    if (!pulled) {
      step("next-message: 204 (nothing to run)");
      result = { ...ids, outcome: "nothing-to-run" };
    } else {
      step(
        `next-message: got message (agent=${pulled.agent}, model=${pulled.model})`,
      );
      // The settings `env` block is read by the Claude CLI only: say so
      // rather than drop the repo env silently for another agent.
      if (
        pulled.agent !== "claudeCode" &&
        Object.keys(r.repoEnv.env).length > 0
      ) {
        step(`cell: repo env not delivered (agent=${pulled.agent})`);
      }
      if (pulled.agent !== "claudeCode" && r.testDbDelivered) {
        step(`cell: test database env not delivered (agent=${pulled.agent})`);
      }
      // 9. The prompt rides in a file, never in argv (execd logs argv).
      const messagePath = `${CELL_MESSAGE_DIR}/msg-${deps.randomId()}.json`;
      await putFile(
        r,
        messagePath,
        JSON.stringify(buildCellMessage(pulled, ids)),
        600,
      );
      await execOk(
        r,
        ["/bin/bash", "-c", CELL_WRITE_MESSAGE_SH, "cell-write", messagePath],
        "message write",
        undefined,
        false,
      );
      step("cell: message written to the daemon");

      // 10. The poll loop takes over from the heartbeat.
      r.heartbeatStop.abort();
      startSessionCapture(r, pulled);
      const poll = await deps.www.pollUntilTerminal(
        pollContext(r, provider, r.cellId),
        r.cellOpts,
        config.pollIntervalMs,
      );
      if (st.fenced || st.failure !== null || st.pendingSettle !== null) {
        throw new SetupAbortedError();
      }
      if (poll.outcome === "completed") st.terminal = true;
      result = { ...ids, outcome: poll.outcome, finalStatus: poll.finalStatus };
    }
  } catch (error) {
    pollReturnedAt = Date.now();
    const exit = await decideExit(r, error);
    result = exit.result ?? result;
    thrown = exit.thrown ?? null;
  } finally {
    pollReturnedAt ??= Date.now();
    r.heartbeatStop.abort();
    r.memorySampleStop.abort();
    r.captureStop.abort();
  }
  // A terminal read that confirmed the retire, while the poll loop was running.
  if (st.conflict && thrown === null && st.failure !== null) {
    thrown = { error: st.failure };
  }

  // #743 phase 7b: the end is claimed BEFORE anything else, so a typed `timeout`
  // can capture the session and salvage the work first. Any other end skips
  // the capture and keeps today's teardown.
  const end = claimEnd(r, thrown);
  let salvage: SalvageResult | null = null;
  try {
    if (end?.cause === "timeout") {
      salvage = await captureOnTimeout(r, pollReturnedAt ?? Date.now());
    } else {
      r.captureAbort.abort();
    }
  } catch {
    // captureOnTimeout never throws; a guard so the teardown below always runs.
  }
  // The finally: R -> T -> B -> A -> P, then give the slot back.
  try {
    await tearDown(r, end, salvage);
  } finally {
    await releaseAdmission();
  }

  if (thrown !== null) throw thrown.error;
  return result ?? { ...ids, outcome: "cancelled" };
}

// ---- shared state helpers ---------------------------------------------------

function ensureLive(r: CellRunState): void {
  if (r.live.aborted) throw new SetupAbortedError();
}

/**
 * Races a provider call against `live`, so a fence, a Stop, a lost heartbeat or
 * the run's timeout starts the teardown at once even while the call is still in
 * flight: the cell is deleted anyway (M2).
 */
async function raceLive<T>(r: CellRunState, call: Promise<T>): Promise<T> {
  call.catch(() => undefined); // a call that loses the race must not become unhandled
  return Promise.race([call, r.abortedLive]);
}

function markRetired(r: CellRunState): void {
  r.st.retired = true;
  r.deps.marks.mark(r.runId, "retired");
}

function onLease(r: CellRunState, lease: CellLease): void {
  const { st } = r;
  switch (lease) {
    case "renewed":
      st.refusedStreak = 0;
      return;
    case "refused":
      st.refusedStreak += 1;
      if (st.refusedStreak >= REFUSED_LIMIT && st.failure === null) {
        r.abnormal.daemonStarted = true;
        st.failure = new NonRetryableError("cell_attempt_revoked");
        r.inner.abort();
      }
      return;
    case "superseded":
      // A database fact in www: one read is enough (Decision 12).
      st.fenced = true;
      r.deps.marks.mark(r.runId, "fenced");
      r.inner.abort();
      return;
    case "finished":
      st.terminal = true;
      markRetired(r);
      return;
    case "error":
      r.step("cell.lease_error (ignored)");
      return;
  }
}

/** Settles a terminal read that answered a 500/401 the way the poll loop does (Contract 5, Decision 11). */
async function confirmRetired(
  r: CellRunState,
  signal: AbortSignal,
): Promise<"retired" | "gone" | "unknown"> {
  const out = await r.deps.www.revoke(
    r.cellOpts,
    r.attempt,
    signal,
    CONFIRM_RETRY,
  );
  if (out.result === "ok") return "retired";
  return out.result === "unauthorized" ? "gone" : "unknown";
}

/** After a terminal-read error code: the same retry rule and budget as the poll (E16). */
async function settleTerminalError(
  r: CellRunState,
  first: ThreadStatusHttpError,
): Promise<void> {
  const retry = createTerminalReadRetry(CELL_TERMINAL_RETRY);
  let code = retry.onFailure(first)?.code ?? first.code;
  for (let pass = 1; pass < CELL_TERMINAL_RETRY.tries; pass++) {
    await r.deps.sleep(CELL_TERMINAL_RETRY.delayMs, r.runSignal);
    if (r.runSignal?.aborted) throw new SetupAbortedError();
    let poll: ThreadStatusPoll;
    try {
      poll = await r.deps.www.pollThreadStatus(
        r.cellOpts,
        withTimeout(HEARTBEAT_TIMEOUT_MS, r.runSignal),
      );
    } catch (error) {
      code = retry.onFailure(error)?.code ?? code;
      continue;
    }
    if (poll.kind === "auth-error") {
      const retired = await retry.onUnauthorized(
        poll.httpStatus,
        (signal) => confirmRetired(r, signal),
        AbortSignal.timeout(CELL_TERMINAL_RETRY.delayMs * 4),
      );
      if (retired) {
        r.st.terminal = true;
        markRetired(r);
        return;
      }
      throw new CellTerminalUnconfirmedError(code ?? "unknown");
    }
    if (poll.terminal) {
      onLease(r, "finished");
      r.st.terminal = true;
      r.st.terminalStatus = poll.status;
      return;
    }
  }
  throw new CellTerminalUnconfirmedError(code ?? "unknown");
}

// ---- the heartbeat -----------------------------------------------------------

/**
 * How often a live cell's anonymous memory is re-read for the headroom
 * reservation. Short, because a sample older than a drop in the cell's usage
 * over-shrinks the reservation until the next read.
 */
export const CELL_MEMORY_SAMPLE_MS = 4_000;

/**
 * #749: read the cell's own cgroup (`/sys/fs/cgroup/memory.stat`, anon + shmem,
 * the box path's measure) every CELL_MEMORY_SAMPLE_MS for the whole run, the
 * agent's work included (its own stop signal, aborted at the run's end, before
 * teardown), and hand admission a synchronous getter. The getter returns the
 * LOWER of the last two samples: the box path's rule is that the subtracted
 * anon never exceeds what the kernel charges now, and a sample taken before a
 * drop would exceed it, so a drop counts at once and a rise only once seen
 * twice. Fail
 * open: a failed read keeps the previous sample (null until the first), which
 * only ever over-reserves.
 */
function startCellMemorySampler(
  r: CellRunState,
  reservation: Reservation | null,
): void {
  if (reservation === null) return;
  let last: number | null = null;
  let previous: number | null = null;
  reservation.observe(() =>
    last === null ? null : previous === null ? last : Math.min(last, previous),
  );
  const provider = r.provider as ICellProvider;
  const cellId = r.cellId as string;
  const stop = r.memorySampleStop.signal;
  void (async () => {
    while (!stop.aborted) {
      try {
        const out = await provider.exec(
          cellId,
          ["cat", "/sys/fs/cgroup/memory.stat"],
          { timeoutMs: 5_000 },
        );
        const read = out.exitCode === 0 ? parseMemoryAnon(out.stdout) : null;
        if (read !== null) {
          previous = last;
          last = read;
        }
      } catch {
        // Keep the last sample: never fail a run over a memory probe.
      }
      await r.deps.sleep(CELL_MEMORY_SAMPLE_MS, stop);
    }
  })();
}

// ---- the per-turn session capture (#743 phase 6) ------------------------------

/**
 * How often the capture loop looks at the cell's transcript. Distinct from
 * CELL_MEMORY_SAMPLE_MS and from the run's poll interval (WORKER_POLL_INTERVAL_MS,
 * default 7 s): the test harness keys its sleeps on the value (the #749 collision).
 */
export const CELL_CAPTURE_POLL_MS = 6_500;
/** With no sign of growth (or a failed probe), pull anyway after this long (Q-1). */
export const CELL_CAPTURE_IDLE_PULL_MS = 60_000;
/** One pull (the exec checks and the copyOut) is abandoned after this long. */
export const CELL_CAPTURE_POLL_BUDGET_MS = 15_000;
/**
 * #743 phase 7b (OQ-4, F2): the whole timeout capture (freeze, the wait for an
 * in-flight pull, the final pull, the salvage), from the poll loop's return to
 * the teardown's first step. A test pins this + the teardown's worst case + 30 s
 * of slack under onFailure's typed-terminal wait.
 */
export const CELL_TIMEOUT_CAPTURE_BUDGET_MS = 40_000;
/** The final pull's share of that budget. */
const CELL_TIMEOUT_FINAL_FLUSH_MS = 12_000;

const CELL_PROJECTS_DIR = `${HOME_CLAUDE_DIR}/projects`;
/** F6: every project dir at depth 2, no hard-coded name. `-type f` neither follows nor lists a symlink (F9). */
const CAPTURE_PROBE_ARGV = [
  "/usr/bin/find",
  "-P",
  CELL_PROJECTS_DIR,
  "-mindepth",
  "2",
  "-maxdepth",
  "2",
  "-type",
  "f",
  "-name",
  "*.jsonl",
  "-printf",
  "%s %T@ %P\\n",
];
const PROBE_LINE =
  /^(\d+) (\d+(?:\.\d+)?) (-[A-Za-z0-9-]{1,200})\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

/** The running per-turn capture, for the timeout capture (phase 7b). */
interface CaptureHandle {
  /** The pull running now, if any. Never rejects. */
  inflight(): Promise<void> | null;
  /** One ungated pull on `signal`. Never throws; skipped while another pull runs. */
  final(signal: AbortSignal): Promise<void>;
}

interface SessionFile {
  projectDir: string;
  sessionId: string;
  size: number;
}

/** The session file by id (F6), else the newest UUID-named one. Names that are not UUIDs are ignored. */
function chooseSessionFile(
  stdout: string,
  sessionId: string | null,
): SessionFile | null {
  let best: (SessionFile & { mtime: number }) | null = null;
  for (const line of stdout.split("\n")) {
    const m = PROBE_LINE.exec(line);
    if (!m) continue;
    const id = (m[4] as string).toLowerCase();
    if (sessionId !== null && id !== sessionId.toLowerCase()) continue;
    const mtime = Number(m[2]);
    if (best === null || mtime > best.mtime) {
      best = {
        projectDir: m[3] as string,
        sessionId: id,
        size: Number(m[1]),
        mtime,
      };
    }
  }
  return best;
}

function causeClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "unknown";
}

/** Rejects when `signal` aborts (the pull's budget, the stop or `live`). */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
    promise.then(resolve, reject);
  });
}

/**
 * Starts the capture loop for the agent's working life, from the message write
 * to the run's end (stopped before teardown by `captureStop`). The worker pulls
 * the session file with `copyOut` (Q-1: the cell's reachable surface does not
 * change), redacts it here before anything leaves the box, and writes through
 * the checkpoint route. Fail open: a failure is one journal line with the cause
 * class and never fails the run; no transcript byte or token is ever logged.
 */
function startSessionCapture(
  r: CellRunState,
  pulled: PulledDaemonMessage,
): void {
  r.capture = openSessionCapture(r, pulled);
}

function openSessionCapture(
  r: CellRunState,
  pulled: PulledDaemonMessage,
): CaptureHandle | null {
  const { checkpoint, sessionContinuation } = r.deps;
  if (!checkpoint || !sessionContinuation?.()) return null;
  if (pulled.agent !== "claudeCode") return null;
  const provider = r.provider as ICellProvider;
  const cellId = r.cellId as string;
  const stop = r.captureStop.signal;

  let redactor: ReturnType<typeof createSessionRedactor>;
  try {
    redactor = createSessionRedactor({
      values: [
        ...Object.values(r.repoEnv.env),
        ...(r.testDb.plan === "start" ? [r.testDb.password] : []),
      ],
    });
  } catch (error) {
    r.step(`cell: checkpoint skipped (error ${causeClass(error)})`);
    return null;
  }

  let sessionId: string | null = pulled.sessionId;
  let projectDir: string | null = null;
  let lastSize = 0;
  let consumed = 0;
  let lastPullAt = r.deps.now();
  let manifest: CellSessionManifest | null = null;
  let native: Uint8Array = new Uint8Array(0);
  let version = 0;
  let turnState: TurnState | undefined;
  let stopped = false;

  // A pull ends with the run's internal aborts (fence, Stop, failure) and with
  // captureAbort, never with the run's own cancel: a timeout keeps its pull alive.
  const loopSignal = (): AbortSignal =>
    withTimeout(
      CELL_CAPTURE_POLL_BUDGET_MS,
      r.captureAbort.signal,
      r.inner.signal,
    );

  const pullOnce = async (
    file: SessionFile,
    budget: AbortSignal,
  ): Promise<void> => {
    const path = `${CELL_PROJECTS_DIR}/${file.projectDir}/${file.sessionId}.jsonl`;
    // F9: re-check right before the read that it is still a regular file.
    const check = await raceSignal(
      provider.exec(
        cellId,
        [
          "/usr/bin/find",
          "-P",
          path,
          "-maxdepth",
          "0",
          "-type",
          "f",
          "-print",
          "-quit",
        ],
        { timeoutMs: 5_000 },
      ),
      budget,
    );
    if (check.exitCode !== 0 || check.stdout.trim() !== path) {
      r.step("cell: checkpoint skipped (not a regular file)");
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await raceSignal(provider.copyOut(cellId, path), budget);
    } catch {
      r.step("cell: checkpoint skipped (copy-out failed)");
      return;
    }
    lastPullAt = r.deps.now();
    lastSize = file.size;
    // A pull with no new bytes writes nothing (A-12).
    if (bytes.length <= consumed) return;

    const started = r.deps.now();
    const result = prepareCheckpoint({
      previous: manifest,
      previousNative: native,
      newBytes: bytes.subarray(consumed),
      ...(turnState ? { turnState } : {}),
      context: {
        threadId: r.ids.threadId,
        threadChatId: r.ids.threadChatId,
        sessionId: file.sessionId,
        runExternalId: r.runId,
        projectDir: file.projectDir,
        git: null,
      },
      redactor,
      log: r.step,
    });
    if (result.kind === "skipped") {
      if (result.reason !== "redactor error") stopped = true;
      return;
    }
    // Only a completed turn is a checkpoint; the bytes stay unconsumed until one is.
    if (result.kind !== "write" || !result.turnAdvanced) return;

    for (const blob of result.blobs) {
      const put = await checkpoint.putBlob(
        r.cellOpts,
        blob.sha256,
        blob.body,
        budget,
      );
      if (!put.ok) return failed(put);
    }
    const commit = await checkpoint.commit(
      r.cellOpts,
      result.manifest,
      version,
      budget,
    );
    if (!commit.ok) return failed(commit);

    manifest = result.manifest;
    native = result.native;
    version = commit.version;
    turnState = result.turnState;
    consumed += result.consumedRawBytes;
    r.step(
      `cell: checkpoint turn=${result.manifest.turn} native=${result.manifest.native.bytes} chunks=${result.manifest.native.chunks.length} hits=${result.manifest.redaction.hits} v=${commit.version} in ${r.deps.now() - started}ms`,
    );
  };

  const failed = (f: { code: string; status: number }): void => {
    if (f.code === "head_moved") {
      r.step("cell: checkpoint skipped (head moved; capture stopped)");
      stopped = true;
    } else if (
      f.code === "superseded" ||
      f.status === 401 ||
      f.status === 403
    ) {
      r.step("cell: checkpoint skipped (fenced; capture stopped)");
      stopped = true;
    } else {
      r.step(`cell: checkpoint skipped (www ${f.code})`);
    }
  };

  const captureOnce = async (
    budget: AbortSignal,
    force: boolean,
  ): Promise<void> => {
    let file: SessionFile | null = null;
    try {
      const out = await raceSignal(
        provider.exec(cellId, CAPTURE_PROBE_ARGV, { timeoutMs: 5_000 }),
        budget,
      );
      if (out.exitCode === 0) file = chooseSessionFile(out.stdout, sessionId);
    } catch {
      file = null;
    }
    const idle = r.deps.now() - lastPullAt >= CELL_CAPTURE_IDLE_PULL_MS;
    if (file !== null) {
      sessionId = file.sessionId;
      projectDir = file.projectDir;
      // The size is the turn signal the worker can observe (Q-1).
      if (file.size <= lastSize && !idle && !force) return;
    } else if (projectDir !== null && sessionId !== null && (idle || force)) {
      file = { projectDir, sessionId, size: lastSize };
    } else {
      return;
    }
    await pullOnce(file, budget);
  };

  /** The pull running now (the loop's or the final one); one at a time, they share state. */
  let running: Promise<void> | null = null;
  const track = (work: Promise<void>): Promise<void> => {
    const tracked: Promise<void> = work.finally(() => {
      if (running === tracked) running = null;
    });
    running = tracked;
    return tracked;
  };

  void (async () => {
    while (!stop.aborted && !r.live.aborted && !stopped) {
      try {
        await track(captureOnce(loopSignal(), false));
      } catch (error) {
        if (!stop.aborted) {
          r.step(`cell: checkpoint skipped (error ${causeClass(error)})`);
        }
      }
      await r.deps.sleep(CELL_CAPTURE_POLL_MS, stop);
    }
  })();

  return {
    inflight: () => (running === null ? null : running.catch(() => {})),
    final: async (signal) => {
      if (stopped) return;
      if (running !== null) {
        r.step("cell: checkpoint final skipped (a pull is still running)");
        return;
      }
      try {
        await track(captureOnce(signal, true));
      } catch (error) {
        r.step(`cell: checkpoint final skipped (error ${causeClass(error)})`);
      }
    },
  };
}

/** One lease stamp every CELL_SETUP_STAMP_MS until the poll loop takes over (or the run ends). */
function startHeartbeat(r: CellRunState): void {
  const { st, live } = r;
  let failures = 0;
  const fail = () => {
    failures += 1;
    r.step(`cell.heartbeat_failed ${failures}/${HEARTBEAT_FAILURES}`);
    if (failures >= HEARTBEAT_FAILURES && st.failure === null) {
      r.abnormal.daemonStarted = true;
      st.failure = new Error("cell_heartbeat_lost");
      r.inner.abort();
    }
  };
  const beat = async (): Promise<void> => {
    try {
      const poll = await r.deps.www.pollThreadStatus(
        r.cellOpts,
        withTimeout(HEARTBEAT_TIMEOUT_MS, r.heartbeatStop.signal, live),
      );
      if (poll.kind === "auth-error") {
        fail();
        return;
      }
      failures = 0;
      if (poll.lease !== undefined) onLease(r, poll.lease);
      if (poll.terminal) {
        // A finished step during setup (E12): nothing is sent to the daemon.
        st.terminal = true;
        st.terminalStatus = poll.status;
        if (poll.lease === undefined) markRetired(r);
        r.inner.abort();
      } else if (poll.status === "stopping") {
        st.stopRequested = true;
        r.inner.abort();
      }
    } catch (error) {
      if (r.heartbeatStop.signal.aborted || live.aborted) return;
      if (error instanceof ThreadStatusHttpError) {
        if (error.status === 409 && error.code === "cell_step_conflict") {
          st.conflict = true;
          st.failure = new CellStepConflictError();
          r.inner.abort();
          return;
        }
        if (
          error.status === 500 &&
          (error.code === "cell_finish_failed" ||
            error.code === "cell_retire_failed")
        ) {
          // Setup is aborted at once (Decision 7); the retry budget and the
          // retired-token confirmation run in decideExit, BEFORE teardown.
          st.pendingSettle = error;
          r.inner.abort();
          return;
        }
      }
      fail();
    }
  };
  void (async () => {
    while (!r.heartbeatStop.signal.aborted && !live.aborted) {
      await r.deps.sleep(CELL_SETUP_STAMP_MS, r.heartbeatStop.signal);
      if (r.heartbeatStop.signal.aborted || live.aborted) break;
      await beat();
    }
  })();
}

// ---- the bootstrap -----------------------------------------------------------

async function execOk(
  r: CellRunState,
  argv: string[],
  label: string,
  timeoutMs?: number,
  logStderr = true,
): Promise<void> {
  ensureLive(r);
  const out = await raceLive(
    r,
    (r.provider as ICellProvider).exec(
      r.cellId as string,
      argv,
      timeoutMs !== undefined ? { timeoutMs } : undefined,
    ),
  );
  if (out.exitCode !== 0) {
    // The message write's stderr is never logged: it may echo the staged message.
    r.step(
      logStderr
        ? `cell setup: ${label} failed (exit ${out.exitCode}): ${r.scrub(out.stderr).slice(-EXEC_STDERR_TAIL)}`
        : `cell setup: ${label} failed (exit ${out.exitCode})`,
    );
    throw new Error(`cell setup: ${label} failed (exit ${out.exitCode})`);
  }
}

async function putFile(
  r: CellRunState,
  path: string,
  text: string,
  mode: number,
): Promise<void> {
  ensureLive(r);
  await raceLive(
    r,
    (r.provider as ICellProvider).copyIn(
      r.cellId as string,
      path,
      new TextEncoder().encode(text),
      { mode, ...CELL_USER },
    ),
  );
}

/** Probes `argv` until it exits 0, pausing `pollMs` between probes; past `deadline` throws `onTimeout()`. Raced against `live`. */
async function waitForExitZero(
  r: CellRunState,
  argv: string[],
  deadline: number,
  pollMs: number,
  onTimeout: () => Error,
): Promise<void> {
  const provider = r.provider as ICellProvider;
  for (;;) {
    ensureLive(r);
    const probe = await raceLive(
      r,
      provider.exec(r.cellId as string, argv, { timeoutMs: PGREP_TIMEOUT_MS }),
    );
    if (probe.exitCode === 0) return;
    if (r.deps.now() >= deadline) throw onTimeout();
    await r.deps.sleep(pollMs, r.live);
  }
}

/**
 * The cell's own test database (#707), when planCellTestDb said `start`: a
 * 0700 dir, the password copied in (never in argv), initdb and a start, a
 * bounded readiness loop (the setup heartbeat keeps stamping meanwhile), then
 * the role. Returns the agent's env. A failure that is not an abort is logged
 * and the run goes on without the variable: a repo whose suites need no
 * database still runs. The elapsed time is logged (AC 4).
 */
async function startTestDb(r: CellRunState): Promise<Record<string, string>> {
  const { testDb } = r;
  if (testDb.plan === "owner") {
    r.step(
      `cell: test database not started (the owner's ${CELL_TEST_DB_ENV} wins)`,
    );
    return {};
  }
  if (testDb.plan !== "start") return {};
  const provider = r.provider as ICellProvider;
  const cellId = r.cellId as string;
  const started = r.deps.now();
  try {
    await execOk(r, [...CELL_TEST_DB_MKDIR_ARGV], "test database dir");
    await putFile(r, CELL_TEST_DB_PASSWORD_FILE, testDb.password, 600);
    await execOk(
      r,
      ["/bin/bash", "-c", CELL_TEST_DB_START_SH, "cell-test-db"],
      "test database start",
      TEST_DB_START_TIMEOUT_MS,
    );
    await waitForExitZero(
      r,
      [...CELL_TEST_DB_READY_ARGV],
      started + TEST_DB_READY_MS,
      TEST_DB_POLL_MS,
      () => new TestDbNotReadyError(),
    );
    await execOk(
      r,
      ["/bin/bash", "-c", CELL_TEST_DB_ROLE_SH, "cell-test-db"],
      "test database role",
      PGREP_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof SetupAbortedError || r.live.aborted) throw error;
    // Best effort: no half-made server or staged password is left behind.
    await raceLive(
      r,
      provider.exec(cellId, ["/bin/bash", "-c", CELL_TEST_DB_STOP_SH], {
        timeoutMs: PGREP_TIMEOUT_MS,
      }),
    ).catch(() => undefined);
    ensureLive(r);
    r.step(
      "cell: test database not started; the run goes on without it" +
        (error instanceof TestDbNotReadyError ? ` (${error.message})` : ""),
    );
    return {};
  }
  r.step(`cell: test database ready in ${r.deps.now() - started}ms`);
  return { [CELL_TEST_DB_ENV]: testDb.url };
}

/**
 * The gh note as user memory (#727 B), appended, never replacing what the
 * image ships. A probe tells absent (exit 1: the note is the whole file) from
 * present; a present file that cannot be read is left alone and the note
 * skipped, since `copyOut` cannot tell "absent" from a failed read.
 */
async function writeGhNote(
  r: CellRunState,
  extra: string | null,
): Promise<void> {
  const path = `${HOME_CLAUDE_DIR}/CLAUDE.md`;
  // #742: the Flutter SDK note rides with the gh note (one user-memory file).
  const note =
    extra === null ? CELL_GH_NOTE : `${CELL_GH_NOTE.trimEnd()}\n\n${extra}\n`;
  const provider = r.provider as ICellProvider;
  ensureLive(r);
  const probe = await raceLive(
    r,
    provider.exec(r.cellId as string, ["/usr/bin/test", "-e", path], {
      timeoutMs: PGREP_TIMEOUT_MS,
    }),
  );
  if (probe.exitCode === 1) {
    await putFile(r, path, note, 600);
    return;
  }
  const bytes =
    probe.exitCode === 0
      ? await raceLive(r, provider.copyOut(r.cellId as string, path)).catch(
          () => null,
        )
      : null;
  ensureLive(r);
  if (bytes === null) {
    r.step("cell: gh note not added (~/.claude/CLAUDE.md could not be read)");
    return;
  }
  const existing = new TextDecoder().decode(bytes);
  await putFile(
    r,
    path,
    existing.trim() === "" ? note : `${existing.trimEnd()}\n\n${note}`,
    600,
  );
}

/** Rethrow what must stop the setup (a Stop, a fence, the run's cancel). */
function rethrowAbort(r: CellRunState, error: unknown): void {
  if (error instanceof SetupAbortedError || r.live.aborted) throw error;
}

/** The checkout's Flutter marker files via copyOut: absent, unreadable or oversized = none. */
async function readFlutterMarkers(
  r: CellRunState,
): Promise<Record<string, string>> {
  const provider = r.provider as ICellProvider;
  const files: Record<string, string> = {};
  // Read only regular files under the cap: a marker that is a symlink, a
  // device, a FIFO or oversized (a hostile repo pointing `.fvmrc` at
  // /dev/zero) is never copied out, so it cannot stall the bootstrap.
  // `find -P` does not follow symlinks; `-size -Nc` is strictly under N bytes.
  const probe = await raceLive(
    r,
    provider.exec(
      r.cellId as string,
      [
        "/usr/bin/find",
        "-P",
        ...FLUTTER_MARKER_FILES.map((rel) => `${CELL_WORKSPACE}/${rel}`),
        "-maxdepth",
        "0",
        "-type",
        "f",
        "-size",
        `-${MAX_MARKER_BYTES + 1}c`,
        "-print",
      ],
      { timeoutMs: FLUTTER_EXEC_TIMEOUT_MS },
    ),
  );
  const readable = new Set(
    probe.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== ""),
  );
  // No inner catch: a transport error on one marker must not fall through to
  // a lower-precedence one and pick a different SDK; the caller fails open.
  for (const rel of FLUTTER_MARKER_FILES) {
    if (!readable.has(`${CELL_WORKSPACE}/${rel}`)) continue;
    const raw = await raceLive(
      r,
      provider.copyOut(r.cellId as string, `${CELL_WORKSPACE}/${rel}`),
    );
    if (raw.length <= MAX_MARKER_BYTES) {
      files[rel] = new TextDecoder().decode(raw);
    }
  }
  return files;
}

interface ImageFlutter {
  defaultVersion: string;
  /** The extra SDKs the image bakes (safe versions only). */
  available: string[];
}

/**
 * The image's Flutter SDKs from its one pins file: the default and the extras
 * (`FLUTTER_EXTRA_VERSIONS`, absent on an older image). Only versions that pass
 * the safe shape survive; null when the default is missing or unsafe. A read
 * error propagates (the caller fails open).
 */
async function readImageFlutter(r: CellRunState): Promise<ImageFlutter | null> {
  const raw = await raceLive(
    r,
    (r.provider as ICellProvider).copyOut(
      r.cellId as string,
      CONTAINER_PINS_FILE,
    ),
  );
  const text = new TextDecoder().decode(raw);
  const v = /^FLUTTER_VERSION=(\S+)$/m.exec(text)?.[1];
  if (v === undefined || !isSafeFlutterVersion(v)) return null;
  const extras =
    /^FLUTTER_EXTRA_VERSIONS='?([^'\n]*)'?$/m.exec(text)?.[1] ?? "";
  return {
    defaultVersion: v,
    available: extras.split(/\s+/).filter(isSafeFlutterVersion),
  };
}

/**
 * Write the wrappers for the selected SDK. Journals the selection only once
 * they are in place; a failure keeps the default SDK and journals that instead.
 * Returns the agent's note.
 */
async function installFlutterWrappers(
  r: CellRunState,
  sel: Extract<FlutterSelection, { kind: "use" }>,
  req: FlutterRequirement,
  defaultVersion: string,
): Promise<string | null> {
  const out = await raceLive(
    r,
    (r.provider as ICellProvider).exec(
      r.cellId as string,
      flutterWrapperArgv(sel.version),
      { timeoutMs: FLUTTER_EXEC_TIMEOUT_MS },
    ),
  );
  if (out.exitCode !== 0) {
    r.step(flutterInstallFailedLine(sel.version, out.exitCode, defaultVersion));
    return flutterInstallFailedNote(sel.version, defaultVersion);
  }
  r.step(flutterJournalLine(sel, req, defaultVersion));
  return flutterAgentNote(sel, defaultVersion);
}

/**
 * #742 OD-3: the Flutter SDK the project pins, selected from the SDKs the
 * image bakes. Runs after the clone: reads the markers (CELL-ONLY pubspec
 * reading; the box path is unchanged), decides in flutter-sdk.ts, and writes the
 * wrappers into the shim dir the cell image already puts first on PATH. A miss
 * keeps the default SDK and journals it. Returns the agent's CLAUDE.md note, or
 * null when there is nothing to say. The pins file is read only when a marker
 * carries a requirement.
 */
async function decideFlutterSdk(r: CellRunState): Promise<string | null> {
  const files = await readFlutterMarkers(r);
  const probe: CheckoutProbe = {
    readFile: (rel) => files[rel] ?? null,
    isDir: () => false,
    list: () => [],
  };
  const req = detectFlutterRequirementFrom(probe);
  if (req.kind === "none") return null;
  const image = await readImageFlutter(r);
  if (image === null) {
    r.step("cell: flutter selection skipped (the image default is unknown)");
    return null;
  }
  const { defaultVersion } = image;
  const sel = selectFlutterSdk(req, image.available, defaultVersion);
  if (sel.kind === "use") {
    return installFlutterWrappers(r, sel, req, defaultVersion);
  }
  r.step(flutterJournalLine(sel, req, defaultVersion));
  return flutterAgentNote(sel, defaultVersion);
}

/** Fails open: a selection error never fails the run (an abort still does). */
async function selectFlutterSdkForRun(r: CellRunState): Promise<string | null> {
  try {
    return await decideFlutterSdk(r);
  } catch (error) {
    rethrowAbort(r, error);
    r.step("cell: flutter selection failed; using the image default SDK");
    return null;
  }
}

/** The clone, the git identity, HOME (settings, trust seed, placeholder login), and the entry's socket. */
async function bootstrap(r: CellRunState): Promise<void> {
  const { input, config } = r.args;
  const provider = r.provider as ICellProvider;
  const cellId = r.cellId as string;
  for (const argv of cellCloneArgv({
    brokerHost: r.deployment,
    repoFullName: input.repoFullName,
    branch: input.branch,
    workBranch: input.workBranch,
    baseBranch:
      input.baseBranch && input.baseBranch !== input.branch
        ? input.baseBranch
        : undefined,
  })) {
    await execOk(r, argv, `git ${argv[1] ?? ""}`, CLONE_TIMEOUT_MS);
  }
  r.step("cell: clone complete");
  const flutterNote = await selectFlutterSdkForRun(r);
  for (const argv of cellGitConfigArgv(config.botLogin)) {
    await execOk(r, argv, "git config");
  }
  await execOk(
    r,
    ["/bin/mkdir", "-p", "-m", "700", HOME_CLAUDE_DIR, CELL_GH_CONFIG_DIR],
    "mkdir home",
  );
  let batteries: unknown = null;
  try {
    const raw = await raceLive(
      r,
      provider.copyOut(cellId, `${HOME_CLAUDE_DIR}/settings.batteries.json`),
    );
    batteries = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    // Absent or unparseable: the hooks are simply not merged (as on the box).
  }
  // The owner's repo env rides in the settings `env` block (#706, OD-1): the
  // CLI applies it to the agent's process env. Names only in the log.
  const repoEnv = r.repoEnv.env;
  const delivered = Object.keys(repoEnv).length;
  const droppedNote = repoEnvDroppedNote(r.repoEnv);
  if (droppedNote) r.step(`cell: ${droppedNote}`);
  if (delivered > 0) r.step(`cell: repo env: ${delivered} names`);
  // The test database URL rides in the same block (#707); the owner's own
  // TEST_DATABASE_ADMIN_URL wins, as on the box (planCellTestDb starts none then).
  const testDbEnv = await startTestDb(r);
  r.testDbDelivered = Object.keys(testDbEnv).length > 0;
  // gh reads GitHub through the broker (#727 B): the host login holds the
  // placeholder only; the vault's broker binding puts the bearer on the wire.
  const gh = cellGhSetup({
    brokerHost: r.deployment,
    repoFullName: input.repoFullName,
    botLogin: config.botLogin,
  });
  await putFile(r, `${CELL_GH_CONFIG_DIR}/hosts.yml`, gh.hostsYml, 600);
  await writeGhNote(r, flutterNote);
  // GH_* is reserved for repo env, so the owner's names never collide.
  const settingsEnv = { ...testDbEnv, ...repoEnv, ...gh.env };
  await putFile(
    r,
    `${HOME_CLAUDE_DIR}/settings.json`,
    JSON.stringify(
      composeContainerSettings(
        containerLanePolicy("task"),
        batteries,
        Object.keys(settingsEnv).length > 0 ? settingsEnv : null,
      ),
      null,
      2,
    ),
    600,
  );
  await putFile(
    r,
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
    r,
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
  await waitForExitZero(
    r,
    ["/usr/bin/test", "-S", CELL_DAEMON_SOCKET],
    r.deps.now() + SOCKET_WAIT_MS,
    SOCKET_POLL_MS,
    () => new Error(`cell daemon socket not ready after ${SOCKET_WAIT_MS}ms`),
  );
  r.abnormal.daemonStarted = true;
  r.step("cell: daemon socket ready");
}

/** The poll loop's context: the lease handler, the retry budget, and the once-per-poll daemon probe. */
function pollContext(
  r: CellRunState,
  provider: ICellProvider,
  cellId: string | null,
): PollContext {
  let daemonGone = false;
  return {
    get cancelled() {
      return r.args.ctx.cancelled;
    },
    log: r.step,
    signal: r.live,
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
          r,
          provider.exec(
            cellId as string,
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
    onLease: (lease) => onLease(r, lease),
    cellTerminalRetry: { ...CELL_TERMINAL_RETRY },
    confirmRetired: (signal) => confirmRetired(r, signal),
  };
}

// ---- the exit decision ---------------------------------------------------------

/**
 * What a run's main try ended in, as a result or a throw: the pending terminal
 * settle first (before any teardown), then the fence, the internal aborts
 * (failure, terminal, Stop) and the run's own cancel.
 */
async function decideExit(
  r: CellRunState,
  error: unknown,
): Promise<{ result?: AgentRunOutput; thrown?: { error: unknown } }> {
  const { st, ids } = r;
  if (error instanceof CellStepConflictError) st.conflict = true;
  if (st.pendingSettle !== null && !st.fenced && st.failure === null) {
    // A heartbeat saw a terminal-write 500: the same retry budget and the
    // retired-token confirmation as the poll, each read under its own 10 s
    // timeout, and BEFORE the teardown so its report lands on a settled token.
    const first = st.pendingSettle;
    st.pendingSettle = null;
    try {
      await settleTerminalError(r, first);
    } catch (settled) {
      if (settled instanceof CellStepConflictError) st.conflict = true;
      if (!(settled instanceof SetupAbortedError)) {
        r.abnormal.daemonStarted = true;
        st.failure =
          settled instanceof Error ? settled : new Error(String(settled));
      }
    }
  }
  if (st.fenced) return { result: { ...ids, outcome: "fenced" } };
  if (!(error instanceof SetupAbortedError)) return { thrown: { error } };
  if (st.failure !== null) return { thrown: { error: st.failure } };
  if (st.terminal) {
    return {
      result: { ...ids, outcome: "completed", finalStatus: st.terminalStatus },
    };
  }
  if (st.stopRequested) return { result: { ...ids, outcome: "stopped" } };
  // The run's own signal aborted (cancel or timeout).
  return { result: { ...ids, outcome: "cancelled" } };
}

// ---- the teardown --------------------------------------------------------------

const NO_PROVIDER: Pick<
  ICellProvider,
  "revoke" | "quarantine" | "delete" | "listByTags"
> = {
  revoke: async () => {},
  quarantine: async () => {},
  delete: async () => "gone",
  listByTags: async () => [] as never,
};

/**
 * Claims the run's end (once). A fenced or conflicted run claims nothing: its
 * token is retired or the attempt is not ours. Runs before the timeout capture
 * so only a typed `timeout` triggers it (#743 phase 7b).
 */
function claimEnd(
  r: CellRunState,
  thrown: { error: unknown } | null,
): AbnormalEnd | null {
  const { st } = r;
  const { ctx, abnormal } = r.args;
  if (st.fenced || st.conflict) {
    abnormal.claimed = true;
    return null;
  }
  return claimAbnormalEnd(abnormal, {
    thrown: thrown ?? undefined,
    cancelled: ctx.cancelled || ctx.abortController?.signal.aborted === true,
    starvation: null,
  });
}

/** `https://<deployment>/api/cell/git/<owner>/<repo>.git`, the clone's own URL; null if it would not build. */
function brokerGitUrl(r: CellRunState): string | null {
  try {
    const { input } = r.args;
    const url = cellCloneArgv({
      brokerHost: r.deployment,
      repoFullName: input.repoFullName,
      branch: input.branch,
    })[0]?.[5];
    return url ?? null;
  } catch {
    return null;
  }
}

/**
 * #743 phase 7b: what a run that ended on `timeout` does BEFORE the teardown's
 * first step (the bearer revoke), all inside CELL_TIMEOUT_CAPTURE_BUDGET_MS
 * counted from `startedAt` (the poll loop's return). In order: freeze the agent;
 * stop the capture loop and wait for an in-flight pull (F2: inside the budget);
 * one final pull; the WIP salvage. Each step fails open with one class-only
 * log line; whatever still runs at the deadline is abandoned. The freeze and
 * the salvage run with the capture gate off too (the box's timeout salvage is
 * on by default); WORKER_TIMEOUT_SALVAGE=off turns both off. Never throws.
 */
async function captureOnTimeout(
  r: CellRunState,
  startedAt: number,
): Promise<SalvageResult | null> {
  const { provider, cellId } = r;
  const left = (): number =>
    Math.max(0, CELL_TIMEOUT_CAPTURE_BUDGET_MS - (Date.now() - startedAt));
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), left());
  const expired = new Promise<"expired">((resolve) => {
    if (deadline.signal.aborted) resolve("expired");
    else {
      deadline.signal.addEventListener("abort", () => resolve("expired"), {
        once: true,
      });
    }
  });
  const within = <T>(work: Promise<T>): Promise<T | "expired"> => {
    work.catch(() => {});
    return Promise.race([work, expired]);
  };
  /** Runs one step unless the budget is spent; abandons it when the budget runs out. */
  const guarded = async <T>(
    name: string,
    work: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (deadline.signal.aborted) {
      r.step(`cell: timeout capture: ${name} skipped (budget spent)`);
      return undefined;
    }
    try {
      const out = await within(work());
      if (out === "expired") {
        r.step(`cell: timeout capture: ${name} abandoned (budget spent)`);
        return undefined;
      }
      return out;
    } catch (error) {
      r.step(`cell: timeout capture: ${name} failed (${causeClass(error)})`);
      return undefined;
    }
  };

  let salvage: SalvageResult | null = null;
  try {
    if (provider === null || cellId === null) return null;
    const salvageOn = r.args.config.timeoutSalvage !== "off";

    // 1. Freeze: the agent stops writing before anything is read.
    if (salvageOn) {
      const frozen = await guarded("freeze", () =>
        freezeCellAgent({
          provider,
          cellId,
          budgetMs: Math.min(CELL_FREEZE_BUDGET_MS, left()),
        }),
      );
      if (frozen !== undefined) {
        r.step(`cell: timeout capture: freeze ${frozen ? "ok" : "failed"}`);
      }
    }

    // 2 and 3. Stop the loop (already stopped by the finally), wait for an
    // in-flight pull inside the budget, then one final pull.
    const capture = r.capture;
    if (capture !== null) {
      await guarded("pull wait", async () => {
        const pending = capture.inflight();
        if (pending === null) return;
        const bound = new Promise<"late">((resolve) => {
          setTimeout(
            () => resolve("late"),
            Math.min(CELL_CAPTURE_POLL_BUDGET_MS, left()),
          ).unref?.();
        });
        if ((await Promise.race([pending, bound])) === "late") {
          r.step("cell: timeout capture: in-flight pull abandoned");
          r.captureAbort.abort();
          await Promise.race([
            pending,
            new Promise<void>((resolve) => {
              setTimeout(resolve, 500).unref?.();
            }),
          ]);
        }
      });
      await guarded("final pull", async () => {
        await capture.final(
          withTimeout(
            Math.min(CELL_TIMEOUT_FINAL_FLUSH_MS, left()),
            deadline.signal,
          ),
        );
      });
    }

    // 4. The WIP salvage gets what is left.
    if (salvageOn) {
      const url = brokerGitUrl(r);
      if (url === null) {
        r.step("cell: timeout capture: salvage skipped (no broker url)");
      } else {
        const out = await guarded("salvage", () =>
          salvageCellWorkBranch({
            provider,
            cellId,
            workBranch: r.args.input.workBranch,
            brokerGitUrl: url,
            botLogin: r.args.config.botLogin,
            runExecutionTimeoutMs: r.args.abnormal.runExecutionTimeoutMs,
            log: r.step,
            budgetMs: left(),
          }),
        );
        salvage = out ?? null;
      }
    }
  } catch (error) {
    r.step(`cell: timeout capture failed (${causeClass(error)})`);
  } finally {
    clearTimeout(timer);
    r.captureAbort.abort();
  }
  return salvage;
}

/** R -> T -> B -> A -> P (cell-teardown.ts), for an end already claimed. Never throws. */
async function tearDown(
  r: CellRunState,
  end: AbnormalEnd | null,
  salvage: SalvageResult | null,
): Promise<void> {
  const { st, provider, deps } = r;
  const { wwwOpts, abnormal } = r.args;
  let vaultRevoked = false;
  if (st.fenced) {
    // The fence is a database fact: the vault goes FIRST, before anything
    // else is stopped or any www call is made, to shut the window in which
    // this cell's daemon can still post daemon-events (R9).
    if (provider !== null && r.cellId !== null) {
      try {
        await provider.revoke(r.cellId);
        vaultRevoked = true;
      } catch {
        vaultRevoked = false;
      }
    }
    abnormal.claimed = true; // no end: the outer catch posts nothing
  }
  if (st.conflict) deps.marks.mark(r.runId, "tokenGone");
  const finalEnd = end;
  await teardownCellRun(
    {
      stepKey: r.stepKey,
      attempt: r.attempt,
      deployment: r.deployment,
      cellId: r.cellId,
      skipWww: st.conflict,
      vaultRevoked,
    },
    {
      // Each www call has its OWN signal: the run's may already be aborted.
      revoke: async (a, signal) => {
        const out = await deps.www.revoke(r.cellOpts, a, signal);
        return {
          result: out.result === "unauthorized" ? "failed" : out.result,
        };
      },
      report: (a, outcome, signal) =>
        deps.www.report(r.cellOpts, a, outcome, signal, {
          retired: st.retired,
        }),
      provider: provider ?? NO_PROVIDER,
      postAbnormal: async () => {
        if (finalEnd) {
          await deps.www.postAbnormal(abnormal, finalEnd, {
            wwwOpts,
            log: r.step,
            ...(salvage ? { salvage } : {}),
          });
        }
      },
      now: deps.now,
      log: r.step,
    },
  );
}

/** Best effort, in the adapter's order and stopping at the first failure: the vault, quarantine, delete. */
async function removeCell(
  provider: ICellProvider,
  cellId: string,
): Promise<void> {
  await provider.revoke(cellId);
  await provider.quarantine(cellId);
  await provider.delete(cellId);
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
      await removeCell(provider, entry.cellId);
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
    await removeCell(provider, cellId);
  } catch {
    log("cell.late_create_cleanup_failed");
  }
}
