import { randomBytes, randomUUID } from "node:crypto";
import { REGISTERED_EXECUTION_TIMEOUT } from "@terragon/types/cell";
import { FIX_BRANCH_PREFIX } from "@terragon/utils/fix-branch";
import type { RunSecrets } from "@terragon/utils/payload-seal";
import { isBranchRef } from "@terragon/utils/receive-pack-refs";
import { hatchet } from "../hatchet-client";
import {
  AGENT_RUN_VARIANTS,
  buildAgentRunDefinition,
  type AgentRunVariantName,
  type PerPrStrategy,
  DEFAULT_ENGINE_CAPS,
  type EngineCaps,
} from "./definition";
import type { CellConfig } from "./cell-config";
import { loadWorkerConfig } from "./config";
import type { BoxLock } from "./box-lock";
import { admitRunSlot, staleSkip, type RunCtx } from "./run-admission";
import { applyRunBudget } from "./run-budget";
import {
  selectRunExecutor,
  type RunExecutor,
  type RunExecutorDeps,
} from "./run-executor";
import { runAsAgent } from "./agent-command";
import {
  ContainerDaemonProcess,
  settleDaemonTeardown,
  type RunDaemon,
} from "./container-daemon-process";
import { preflightHostGhAuth } from "./gh-preflight";
import {
  runSelfHealChecks,
  type SelfHealCheckResult,
} from "./self-heal-checks";
import {
  emptyFixReport,
  FIX_CHECK_BUDGET_MS,
  pinFixBaseSha,
  remoteBranchHead,
  runFixCheck,
  type FixCheckReport,
} from "./self-heal-fix-check";
import { cleanupWorkdir, provisionWorkdir } from "./provision";
import { planeKeysForRun } from "./payload-seal-keys";
import {
  createTokenRevoker,
  type TokenRevoker,
} from "./revoke-installation-tokens";
import { resolveRunSecrets, type AgentRunWireInput } from "./run-secrets";
import {
  formatRunStartLine,
  ownsAbnormalTerminal,
  resolveRunLane,
} from "./run-lane";
import { reviewAgentForRun, withReviewAgentWire } from "./review-agent-wire";
import { formatBatteriesLine, taskAgentForRun } from "./task-agent";
import {
  classifyNextMessageError,
  nonRetryablePreflight,
} from "./retry-classification";
import type { Reservation } from "./headroom";
import {
  pollUntilTerminal,
  postEgressEvents,
  postRunCredentialSource,
  postRunFailed,
  postRunTerminal,
  postSelfHealAuditChecks,
  postSelfHealFixCheck,
  pullAgentCredentials,
  pullNextMessage,
  type EgressEventWire,
  type WwwClientOpts,
} from "./www-client";
import {
  assertEgressProxyReachable,
  startEgressProxy,
  type EgressDecisionEvent,
  type EgressProxy,
} from "./egress-proxy";
import { startGitBroker, type GitBroker } from "./git-broker";
import { startGhBroker, type GhBroker } from "./gh-broker";
import {
  appendGitConfig,
  buildRunProxyEnv,
  gitProxyAuthConfig,
  type BrokerHandoff,
} from "./daemon-env";
import { runPathsForRepo } from "./run-owned-paths";
import { RUN_END_MARK_MESSAGES, runEndMarks } from "./run-end-marks";
import { guardRunTerminal } from "./run-terminal-ledger";
import {
  claimAbnormalEnd,
  newAbnormalEndState,
  postAbnormalEnd,
  salvageWorkBranch,
  type AbnormalEnd,
  type AbnormalEndState,
  type SalvageResult,
} from "./abnormal-end";
import {
  ensureSlotNamespace,
  getProcessWorkerId,
  runGhSocketPath,
  slotFor,
} from "./run-namespace";
import {
  materialiseAgentCredentials,
  type MaterialisedCredentials,
} from "./agent-credentials";
import {
  describeCredentialSource,
  type AgentRunInput,
  type AgentRunOutput,
  type CredentialSource,
} from "./types";

export type { AgentRunInput, AgentRunOutput } from "./types";

// #656 PR-E: admission moved to run-admission.ts with the module state it owns.
// Outside modules (worker.ts, the tests) still import these names from here.
export {
  _setAdmissionControllerForTests,
  _setAdmissionSleepForTests,
  getAdmissionController,
  headroomBootLine,
  headroomBootWarning,
  sleepAbortable,
} from "./run-admission";

/**
 * The execution-plane agent-run workflow (ADR-002/ADR-003). Triggered from the
 * control plane with REFERENCE-ONLY input (short-lived tokens; the prompt is NOT
 * in the payload). It provisions a clone, spawns the chassis daemon, pulls the
 * DaemonMessage over /api/daemon/next-message, writes it to the daemon socket, and
 * polls /api/daemon/thread-status until the thread is terminal — then tears down.
 *
 * WHY a `hatchet.workflow` (not a standalone `hatchet.task`): the enterprise-
 * hardening plan needs two WORKFLOW-level features — `onFailure` (a terminal
 * www callback when the run fails; Phase 1.2) and stacked per-org concurrency
 * (Phase 2). Both are methods on a workflow declaration, not options on a
 * standalone task. The workflow name stays "agent-run" so the www REST trigger
 * contract (transport.ts `workflowName: "agent-run"`) is unchanged.
 *
 * scheduleTimeout 30m (not Hatchet's 5m default): on a customer box the schedule-
 * timeout window is the grace period for THEIR infra being down; 5m would silently
 * drop queued work during a brief outage (ADR-002 §Worker availability).
 *
 * Concurrency is a STACKED array of two GROUP_ROUND_ROBIN keys (shapes in
 * definition.ts). Both caps come from `EngineCaps` — `WORKER_PER_ORG_MAX_RUNS`
 * and `WORKER_GLOBAL_MAX_RUNS`, validated by loadWorkerConfig (#372; 1/1 by
 * default):
 *   1. per-ORG key (`input.orgId`): bounds runs WITHIN an org. orgId is
 *      guaranteed non-empty by dispatch (the `u:${userId}` fallback) so the CEL
 *      key never dereferences null.
 *   2. global constant key: the per-variant engine cap. At 1 it is a single
 *      group, so ordering across orgs under it is FIFO (observed, #128 E2E —
 *      docs/uat/hatchet-lite-v0.94.10-observed.md §1); the BOX budget is the
 *      worker's slots plus the kernel box lock, never this key.
 * On the LEGACY `agent-run` workflow later runs QUEUE rather than cancel — an
 * in-flight agent turn is never killed by the engine there (flag-off contract,
 * #125 AC7). The three POLICY VARIANTS (#125 C1, `makeAgentRunWorkflow`) stack a
 * THIRD, per-PR key (`input.prKey`, maxRuns 1) ON TOP of these two, and it is the
 * per-PR entry's limitStrategy that encodes the supersede policy:
 *   - agent-run-newest  → CANCEL_IN_PROGRESS  (newest-wins: cancel the live run)
 *   - agent-run-strict  → GROUP_ROUND_ROBIN   (complete-run · queue)
 *   - agent-run-discard → CANCEL_NEWEST       (complete-run · discard)
 * A run the engine cancels under a variant is NOT silent: the run task posts an
 * explicit typed terminal to www (postRunTerminal — `superseded` for a native-policy cancel), fenced by generation.
 * The variants are only ever dispatched with `prKey`/`deliveryId` present (www
 * C2 guarantees it under the flag), so their CEL never dereferences a missing
 * field; the legacy workflow carries no per-PR entry and no idempotency key.
 */

/**
 * The worker's final say on `useCredits` — the invariant that removes the silent
 * third mode: a run either has its own credential on disk, or it goes through
 * the control-plane proxy, or (box-key only) it deliberately uses the box's key.
 *
 * www computes useCredits from "does this user have a connected credential"
 * (remote-daemon-message.ts shouldUseCredits), which is wrong in BOTH directions
 * out here:
 *   - the user can have a credential this box was never given (shared box, or a
 *     control plane too old to serve it) → www sends useCredits ABSENT/false,
 *     and the worker must force it TRUE or the daemon falls through to the
 *     box's own key (the silent third mode);
 *   - under box-key the operator typically has NO connected credential — the
 *     whole premise of the mode — so www sends useCredits TRUE, and the worker
 *     must force it FALSE or daemon-env blanks the box key and routes through
 *     the credits proxy, 402ing on a platform with no credit balance (the exact
 *     pilot failure this mode exists to fix).
 *
 * A delivered credential wins over everything: the run authenticates from its
 * own HOME and useCredits is forced false so the proxy is never consulted.
 */
export function resolveUseCredits({
  boxTrust,
  credentialDelivered,
  incomingUseCredits,
}: {
  boxTrust: "owner" | "shared" | "box-key";
  credentialDelivered: boolean;
  incomingUseCredits: boolean;
}): { useCredits: boolean; log: string | null } {
  if (credentialDelivered) {
    return incomingUseCredits
      ? {
          useCredits: false,
          log: "credential delivered → overriding useCredits=false (run HOME wins)",
        }
      : { useCredits: false, log: null };
  }
  if (boxTrust === "box-key") {
    return incomingUseCredits
      ? {
          useCredits: false,
          log: "box-key → overriding useCredits=false (box ANTHROPIC_API_KEY)",
        }
      : { useCredits: false, log: null };
  }
  return incomingUseCredits
    ? { useCredits: true, log: null }
    : {
        useCredits: true,
        log: "no delivered credential → forcing credits (proxy)",
      };
}

/**
 * The ONE place the execution plane names which credential a run actually took
 * (#209 item 1). Called exactly once, at the branch that already decides it,
 * and never re-derived at read time: a value recomputed from WORKER_BOX_TRUST
 * somewhere downstream would be a second source of truth and would go stale
 * the way the admin credentials page did.
 *
 * It is the attribution twin of `resolveUseCredits` above and must agree with
 * it across the whole input space: delivered ⇒ "user-credential";
 * not delivered + box-key ⇒ "box-key"; otherwise ⇒ "built-in-credits" (the
 * arm `resolveUseCredits` serves by forcing the credits proxy).
 */
export function resolveCredentialSource({
  boxTrust,
  credentialDelivered,
}: {
  boxTrust: "owner" | "shared" | "box-key";
  credentialDelivered: boolean;
}): CredentialSource {
  if (credentialDelivered) {
    return "user-credential";
  }
  if (boxTrust === "box-key") {
    return "box-key";
  }
  return "built-in-credits";
}

/**
 * Best-effort close for per-run loopback servers (egress proxy, brokers,
 * batcher): a teardown hiccup must never mask the run's real outcome.
 */
async function closeQuietly(
  closable: { close(): Promise<void> } | null | undefined,
): Promise<void> {
  try {
    await closable?.close();
  } catch {
    // socket already gone
  }
}

/** Flush the egress audit batch at this size (well under the route's 100 cap). */
const EGRESS_BATCH_MAX = 20;
/** …or after this long, whichever comes first. */
const EGRESS_BATCH_FLUSH_MS = 2_000;

/**
 * Tiny audit batcher for the egress proxy (#66 §3.3 worker half): the proxy's
 * sync onEvent callback lands events here; the batch is POSTed to
 * /api/daemon/egress-event every 2s or 20 events, with a final flush on
 * close(). postEgressEvents never throws (and neither does add()), so audit
 * delivery can NEVER fail the run — lost audit rows are logged, not fatal.
 *
 * #473: flush() resolves only once every post started so far has settled, so
 * the run can deliver its audit trail before the terminal status read revokes
 * the daemon token (pollUntilTerminal's beforeStatusRead). Given a signal, it
 * stops waiting when that aborts; the posts themselves carry on, and close()
 * still awaits them.
 *
 * #503: markTerminal() records that www served terminal=true, which revoked
 * the daemon token. From then on nothing is POSTed (a post would only spend
 * three 401s and two 2 s sleeps, then lose the rows anyway): the leftover
 * buffer and any later event are counted, and close() logs the count once as
 * an expected drop. Only a `completed` run marks it; a cancelled or failed run
 * keeps the live token (onFailure still needs it), so its batch still posts.
 */
export function createEgressEventBatcher(wwwOpts: WwwClientOpts): {
  add: (event: EgressDecisionEvent) => void;
  flush: (signal?: AbortSignal) => Promise<void>;
  markTerminal: () => void;
  close: () => Promise<void>;
} {
  let buffer: EgressEventWire[] = [];
  let revoked = false;
  let droppedPostRevoke = 0;
  const inFlight = new Set<Promise<void>>();
  const flush = async (signal?: AbortSignal): Promise<void> => {
    if (buffer.length > 0) {
      const events = buffer;
      buffer = [];
      const post = postEgressEvents(wwwOpts, events);
      inFlight.add(post);
      void post.finally(() => inFlight.delete(post));
    }
    const settled = Promise.all(inFlight);
    if (!signal) {
      await settled;
      return;
    }
    if (signal.aborted) {
      return;
    }
    let onAbort = (): void => {};
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([settled, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
  const timer = setInterval(() => void flush(), EGRESS_BATCH_FLUSH_MS);
  // Never hold the worker process open for an audit flush tick.
  timer.unref?.();
  return {
    add(event) {
      if (revoked) {
        droppedPostRevoke++;
        return;
      }
      buffer.push({
        destinationHost: event.destinationHost,
        // null = port unknown (unparseable target); the route's schema takes
        // optional (not nullable), so unknown travels as absent.
        ...(event.destinationPort !== null
          ? { destinationPort: event.destinationPort }
          : {}),
        action: event.action,
        policyLevel: event.policyLevel,
        mode: event.mode,
        source: "worker",
      });
      if (buffer.length >= EGRESS_BATCH_MAX) {
        void flush();
      }
    },
    flush,
    markTerminal() {
      revoked = true;
      clearInterval(timer);
      droppedPostRevoke += buffer.length;
      buffer = [];
    },
    async close() {
      clearInterval(timer);
      await flush();
      if (droppedPostRevoke > 0) {
        console.info(
          "[agent-run] egress events dropped post-revoke (expected)",
          { threadId: wwwOpts.threadId, count: droppedPostRevoke },
        );
        droppedPostRevoke = 0;
      }
    },
  };
}

/**
 * #437: how long onFailure waits for a task run's own teardown (and its typed
 * terminal) before posting the generic failure: AC1's 90 s plus margin.
 * #743 OQ-4: 150 s, so a cell's 40 s timeout capture, its 80 s teardown and 30 s
 * of slack all fit before the generic post (a test pins the sum).
 */
export const ON_FAILURE_TYPED_TERMINAL_WAIT_MS = 150_000;
/** onFailure's engine timeout: the wait above plus the post (#743: "4m"). */
export const ON_FAILURE_EXECUTION_TIMEOUT = "4m";

/**
 * Register one agent-run workflow from its pure definition with the real run
 * fn + onFailure handler.
 */
export function makeAgentRunWorkflow(
  name: string,
  perPrStrategy: PerPrStrategy,
  caps: EngineCaps = DEFAULT_ENGINE_CAPS,
) {
  const def = buildAgentRunDefinition(name, perPrStrategy, caps);
  const wf = hatchet.workflow<AgentRunWireInput>(def.workflow);
  wf.task({ ...def.task, fn: runAgent });
  // #437: above the default 60 s — a task run's onFailure may wait up to
  // ON_FAILURE_TYPED_TERMINAL_WAIT_MS for the run's own teardown first.
  wf.onFailure({
    fn: onAgentRunFailure,
    executionTimeout: ON_FAILURE_EXECUTION_TIMEOUT,
  });
  return wf;
}

/**
 * The www client options for THIS run: ids + the #7 traceparent header on
 * every call, and (#125 C1) this run's generation as `x-run-external-id` so
 * the control plane's fence can refuse a write from a superseded run.
 */
function wwwOptsFor(
  input: AgentRunInput,
  daemonToken: string,
  ctx: RunCtx,
): WwwClientOpts {
  return {
    baseUrl: input.daemonCallbackUrl,
    daemonToken,
    threadId: input.threadId,
    threadChatId: input.threadChatId,
    traceparent: input.traceparent,
    runExternalId: ctx.workflowRunId?.() || undefined,
  };
}

/** The box executor: today's `runAgentInner`, unchanged. */
const boxExecutor: RunExecutor = {
  kind: "box",
  run: (a) =>
    runAgentInner(
      a.input,
      a.secrets,
      a.revoker,
      a.ctx,
      a.config,
      a.wwwOpts,
      a.runStartedAt,
      a.runKey,
      a.abnormal,
    ),
};

/**
 * The cell executor, loaded on its first marked run: this module imports no
 * cell module at runtime (run-executor.ts's rule), so a box-only worker never
 * loads the sandbox adapter. The wiring is cell-executor-default.ts.
 */
const cellExecutor: RunExecutor = {
  kind: "cell",
  run: async (args) =>
    (await import("./cell-executor-default")).cellExecutor.run(args),
};

/** Test seam: the registry of how cell runs ended, which onFailure consults. */
export const _runEndMarksForTests = runEndMarks;

let executorOverrides:
  | {
      box?: RunExecutor;
      cell?: RunExecutor;
      loadCellConfig?: () => CellConfig | Promise<CellConfig>;
    }
  | undefined;

/**
 * Test seam (in the style of the admission seams): replace the box executor,
 * the cell executor and the cell-config loader; `undefined` restores the
 * defaults.
 */
export function _setRunExecutorsForTests(
  overrides:
    | {
        box?: RunExecutor;
        cell?: RunExecutor;
        loadCellConfig?: () => CellConfig | Promise<CellConfig>;
      }
    | undefined,
): void {
  executorOverrides = overrides;
}

function currentRunExecutors(): RunExecutorDeps {
  return {
    box: executorOverrides?.box ?? boxExecutor,
    cell: executorOverrides?.cell ?? cellExecutor,
    loadCellConfig:
      executorOverrides?.loadCellConfig ??
      (async () =>
        (await import("./cell-executor-default")).loadCellConfigFromEnv()),
  };
}

/**
 * The ONE run task fn shared by every variant: the #386 terminal guard
 * (run-terminal-ledger.ts) around `runAgentAttempt`, which wraps
 * `runAgentInner` with the #125 C4 queue-mode staleness self-check and the
 * #125 C1 cancel hook: when the engine cancels THIS run (in-flight or pre-daemon during provision)
 * under a native policy, an explicit `superseded` terminal is posted to www
 * after teardown — `finally` runs on both return and throw, so exactly once.
 * Legacy runs (no supersedePolicy — non-review lanes) post nothing: the
 * control plane owns that terminal.
 */
async function runAgent(
  wire: AgentRunWireInput,
  ctx: RunCtx,
): Promise<AgentRunOutput> {
  // #386: one terminal per workflow run id on this box. A run that already
  // ended (returned or threw) and is redelivered after a graceful drain is
  // refused here, before admission — never re-executed. A run that never ended
  // (a worker crash mid-run, #152) has no entry and re-executes as before.
  // A refused run whose first attempt RETURNED completes as a no-op, so the
  // engine records COMPLETED and onFailure never re-posts a terminal to www.
  return trackLiveRun(ctx.workflowRunId?.() || "", () =>
    guardRunTerminal<AgentRunOutput>(
      {
        root: loadWorkerConfig().runTerminalRoot,
        runId: ctx.workflowRunId?.() || "",
        log: (msg) => ctx.log(`[agent-run ${wire.threadId}] ${msg}`),
        onAlreadyReturned: () => ({
          threadId: wire.threadId,
          threadChatId: wire.threadChatId,
          outcome: "already-terminal",
        }),
      },
      () => runAgentAttempt(wire, ctx),
    ),
  );
}

/**
 * #437: the run fns executing in THIS process, by workflow run id, each with
 * the promise that settles when it ends. onFailure waits on it so a run's own
 * teardown (and its typed terminal) finishes first; a run that never started
 * here (a scheduleTimeout, another worker) is absent and is never waited for.
 *
 * Assumes ONE worker process per box, which is how every execution box runs
 * today: if a run's onFailure lands on a different process (a second worker,
 * or a restart between the cancel and onFailure) it does not wait, and the
 * generic failure can win the first-terminal race as it did before #437.
 */
const LIVE_RUNS = new Map<string, Promise<void>>();

async function trackLiveRun<T>(
  runId: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!runId) return run();
  const pending = run();
  const ended = pending.then(
    () => undefined,
    () => undefined,
  );
  LIVE_RUNS.set(runId, ended);
  try {
    return await pending;
  } finally {
    if (LIVE_RUNS.get(runId) === ended) LIVE_RUNS.delete(runId);
  }
}

/** Test seam: drive trackLiveRun with a held run fn. */
export const _trackLiveRunForTests = trackLiveRun;

/** True iff the run ended (or was never live here) within `timeoutMs`. */
async function waitForLiveRunEnd(
  runId: string,
  timeoutMs: number,
): Promise<boolean> {
  const ended = LIVE_RUNS.get(runId);
  if (!ended) return true;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([ended.then(() => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function runAgentAttempt(
  wire: AgentRunWireInput,
  ctx: RunCtx,
): Promise<AgentRunOutput> {
  // TMO-01: the engine's execution timeout counts from here; the post-agent
  // fix check must finish inside it (self-heal keeps the registered 30
  // minutes; a task run is extended to 60 right below, #742).
  const runStartedAt = Date.now();
  // Started now, awaited where the abnormal-end state needs it: the bounded,
  // fail-open refresh overlaps the unseal, the config load and the stale check.
  // A refresh that lands after its bound still raised the engine's deadline:
  // the abnormal-end state (built later) follows it.
  const budget: RunBudgetHandle = {
    promise: Promise.resolve(0),
  };
  budget.promise = applyRunBudget(wire, ctx, (ms) => {
    budget.lateMs = ms;
    budget.onLate?.(ms);
  });
  const config = loadWorkerConfig();
  // #380: unseal FIRST — before any www call, the staleness check or
  // provisioning. A failure here throws a PayloadSealError naming only the
  // kid and the failure class; the task fails, nothing is posted (the daemon
  // token is inside the envelope), and www's sweep rule (iii) reconciles.
  const { input, secrets } = await resolveRunSecrets({
    wire,
    keys: planeKeysForRun(config.payloadSealKeyFile),
  });
  ctx.log(
    `[agent-run ${input.threadId}] run secrets: sealed (kid=${input.sealedSecrets?.kid})`,
  );
  // #380: both ghs_ tokens die with the run. runAgentInner revokes them after
  // the fix check and before the box lock release; this outer finally is the
  // safety net for every exit that never gets there (stale-skip, a clone
  // failure, an admission throw). Once-only, never throws.
  const revoker = createTokenRevoker(secrets, (line) =>
    ctx.log(`[agent-run ${input.threadId}] ${line}`),
  );
  try {
    return await runAgentResolved(
      input,
      secrets,
      revoker,
      ctx,
      config,
      runStartedAt,
      budget,
    );
  } finally {
    await revoker.revokeOnce();
  }
}

/**
 * The run's budget as the engine enforces it: the bounded refresh's answer,
 * raised later if a refresh that missed its bound still lands (#742).
 */
interface RunBudgetHandle {
  promise: Promise<number>;
  lateMs?: number;
  onLate?: (ms: number) => void;
}

/** `runAgentAttempt` after the secrets are resolved: the staleness self-check + cancel hook. */
async function runAgentResolved(
  input: AgentRunInput,
  secrets: RunSecrets,
  revoker: TokenRevoker,
  ctx: RunCtx,
  config: ReturnType<typeof loadWorkerConfig>,
  runStartedAt: number,
  budget: RunBudgetHandle,
): Promise<AgentRunOutput> {
  const wwwOpts = wwwOptsFor(input, secrets.daemonToken, ctx);
  const runExternalId = wwwOpts.runExternalId ?? "";
  // #371: the headroom reservation is keyed by the WORKFLOW RUN — distinct for
  // every run of a thread (supersede siblings, re-reviews). Without an id the
  // key is still unique per invocation: two runs of one thread must never share
  // (and silently overwrite) one reservation.
  const runKey = ctx.workflowRunId?.() || `${input.threadId}:${randomUUID()}`;
  // Under complete-run·queue a run may have waited behind an older one while
  // newer commits landed. Ask www FIRST; if a newer run is already recorded,
  // skip with a typed terminal — no clone, no daemon, no credits. Fails open.
  // (Asked AGAIN after a #371 deferral wait, inside runAgentInner.)
  const skipped = await staleSkip(input, ctx, wwwOpts);
  if (skipped) return skipped;
  // #437: a task run's abnormal end is posted once, typed — from the daemon
  // teardown when the run got that far, else from the catch below.
  const abnormal = newAbnormalEndState({
    owns: ownsAbnormalTerminal(input),
    runStartedAt,
    runExecutionTimeoutMs: budget.lateMs ?? (await budget.promise),
  });
  budget.onLate = (ms) => {
    abnormal.runExecutionTimeoutMs = ms;
  };
  // The cancel's own time, not the claim's: a slow teardown must not stretch
  // the timeout tolerance.
  ctx.abortController?.signal.addEventListener(
    "abort",
    () => {
      abnormal.cancelledAt ??= Date.now();
    },
    { once: true },
  );
  try {
    // #656 PR-E: where this run executes, chosen once, here, so a refusal
    // (an unconfigured or wrong-lane marked run) is a pre-daemon throw the catch
    // below posts, with nothing admitted.
    // The cell config is read ONCE per run (for a marked run only) and handed on.
    const executors = currentRunExecutors();
    let cellConfig: CellConfig | undefined;
    const executor = await selectRunExecutor(input, {
      ...executors,
      loadCellConfig: async () =>
        (cellConfig ??= await executors.loadCellConfig()),
    });
    const output = await executor.run({
      cellConfig,
      input,
      secrets,
      revoker,
      ctx,
      config,
      wwwOpts,
      runStartedAt,
      runKey,
      abnormal,
    });
    if (output.outcome === "stopped") {
      // A user Stop put the thread in `stopping`. The daemon never observes
      // that status and www cannot reach a remote-plane daemon, so the
      // WORKER closes the loop: the daemon is already torn down (finally in
      // runAgentInner) — post the typed terminal so the thread completes
      // and this task ends NOW instead of at its step timeout (which held
      // the engine/box lock for 30 minutes in prod, starving every queued
      // review behind it).
      if (runExternalId) {
        const result = await postRunTerminal(wwwOpts, {
          runExternalId,
          cause: "user-cancelled",
          policy: input.supersedePolicy,
        });
        ctx.log(
          `[agent-run ${input.threadId}] thread stopping → user-cancelled terminal: ${result}`,
        );
      } else {
        ctx.log(
          `[agent-run ${input.threadId}] thread stopping but no workflowRunId — terminal not posted (C4 sweep is the backstop)`,
        );
      }
    }
    return output;
  } catch (err) {
    // A throw that never reached the daemon teardown (admission, clone,
    // credential, brokers): nothing to salvage, so the post happens here,
    // after abandon() already cleaned up. A no-op when the teardown settled.
    const end = claimAbnormalEnd(abnormal, {
      thrown: { error: err },
      cancelled: ctx.cancelled || ctx.abortController?.signal.aborted === true,
      starvation: null,
    });
    if (end) {
      await postAbnormalEnd(abnormal, end, {
        wwwOpts,
        log: (line) => ctx.log(`[agent-run ${input.threadId}] ${line}`),
      });
    }
    throw err;
  } finally {
    if (ctx.cancelled || ctx.abortController?.signal.aborted) {
      await postSuperseded(input, ctx, wwwOpts, runStartedAt);
    }
  }
}

/**
 * Structural mirror of the control plane's engine-owned policy set (the
 * planes import nothing from each other — composability invariant; drift is
 * caught by the C3 E2E, same contract as the variant table above).
 */
const ENGINE_OWNED_POLICIES: readonly string[] = [
  "newest-wins",
  "complete-run-queue",
  "complete-run-discard",
];

async function postSuperseded(
  input: AgentRunInput,
  ctx: RunCtx,
  wwwOpts: WwwClientOpts,
  /** When this run's task fn began (TMO-01 clock) — the waste figure's start. */
  runStartedAt: number,
) {
  const policy = input.supersedePolicy;
  // POSITIVE allowlist (#165): only an engine-owned snapshot posts the
  // superseded terminal. The input is a WIRE value — a pre-#165 in-flight run
  // can still carry the retired 'app-side' literal, and a future unknown
  // value must fail toward "post nothing" (the C4 sweep is the backstop),
  // never toward claiming a terminal this plane does not own.
  if (!policy || !ENGINE_OWNED_POLICIES.includes(policy)) {
    return;
  }
  // The generation the fence compares against — Hatchet's run id for THIS run.
  const runExternalId = wwwOpts.runExternalId;
  if (!runExternalId) {
    ctx.log(
      `[agent-run ${input.threadId}] cancelled under ${policy} but no workflowRunId — terminal not posted (C4 sweep is the backstop)`,
    );
    return;
  }
  // #372 supersede-waste decision: ACCEPT the waste of cancelling a running run
  // (newest-wins keeps the verdict current with the latest push) and MEASURE
  // it. Measured BEFORE the terminal post (the figure is the run's execution,
  // not www's latency) and logged whatever the post does. This is the per-run
  // figure; the 7-day fraction (Σ duration of CANCELLED run tasks / Σ all, from
  // the engine's collection route) is #373's trigger, revisited above ~20 %.
  ctx.log(
    `box.supersede_waste ${JSON.stringify({
      runId: runExternalId,
      threadId: input.threadId,
      lane: resolveRunLane(input),
      policy,
      executionMs: Date.now() - runStartedAt,
    })}`,
  );
  const result = await postRunTerminal(wwwOpts, {
    runExternalId,
    cause: "superseded",
    policy,
  });
  ctx.log(
    `[agent-run ${input.threadId}] cancelled under ${policy} → superseded terminal: ${result}`,
  );
}

/**
 * The registered variants, in the table's order, at the given engine caps
 * (#372). `agent-run` (legacy, no per-PR entry) keeps the pre-#125 REST trigger
 * contract byte-identical. `hatchet.workflow()` only stores the declaration —
 * nothing reaches the engine until `hatchet.worker({ workflows })` — so the
 * default-caps set below and the config-caps set the worker registers can
 * coexist; only the set passed to the worker is ever registered.
 */
export function buildAgentRunWorkflows(caps: EngineCaps = DEFAULT_ENGINE_CAPS) {
  return (Object.keys(AGENT_RUN_VARIANTS) as AgentRunVariantName[]).map(
    (name) => makeAgentRunWorkflow(name, AGENT_RUN_VARIANTS[name], caps),
  );
}

/** The default-caps (1/1) registry — the shipped shape for tests and legacy callers. */
export const agentRunWorkflows = buildAgentRunWorkflows();

/** The legacy workflow, exported by name for existing callers/tests. */
export const agentRunWorkflow = agentRunWorkflows.find(
  (w) => w.definition.name === "agent-run",
)!;

export interface SelfHealAuditStepDeps {
  runChecks: typeof runSelfHealChecks;
  postReport: typeof postSelfHealAuditChecks;
}

/**
 * The worker's own shape rule for what follows `automata/fix-`: a conservative
 * character set with no `/`, looser than the generated names
 * (`<issue>-<8 hex>-a<attempt>`) but never wider than before. It is a local
 * shape rule, not a ref-format check; `isBranchRef` owns ref format.
 */
const FIX_SUFFIX_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * FENCE-01: the git-broker ref fence for a self-heal fix run — exactly
 * `refs/heads/<attempt branch>` — or undefined for every other run (no fence,
 * no buffering). Fails closed unless the branch has the `automata/fix-`
 * prefix, a suffix matching the local shape rule, and is a valid
 * `refs/heads/` ref per `isBranchRef`: a fence built from `main` would be no
 * fence at all.
 */
export function selfHealRefFence(
  selfHeal: AgentRunInput["selfHeal"],
): { exactRef: string } | undefined {
  if (selfHeal?.kind !== "fix") return undefined;
  const branch = selfHeal.branch;
  const suffix = branch.startsWith(FIX_BRANCH_PREFIX)
    ? branch.slice(FIX_BRANCH_PREFIX.length)
    : "";
  if (!FIX_SUFFIX_SHAPE.test(suffix) || !isBranchRef(`refs/heads/${branch}`)) {
    throw new Error(
      `self-heal fix run: branch is not a ${FIX_BRANCH_PREFIX}* branch name`,
    );
  }
  return { exactRef: `refs/heads/${branch}` };
}

/**
 * The git-broker ref fence of a mention-lane run (#729): exactly the ref
 * dispatch named in `pushRef`, or undefined for every run without one. Fails
 * closed on a blank value or anything that is not a `refs/heads/` ref (a tag,
 * a bare name): a mention is never run unfenced because its fence was wrong.
 */
export function pushRefFence(
  pushRef: AgentRunInput["pushRef"],
): { exactRef: string } | undefined {
  if (pushRef === undefined) return undefined;
  if (!isBranchRef(pushRef)) {
    throw new Error("mention run: pushRef is not a refs/heads/ branch ref");
  }
  return { exactRef: pushRef };
}

const DEFAULT_SELF_HEAL_DEPS: SelfHealAuditStepDeps = {
  runChecks: runSelfHealChecks,
  postReport: (args) => postSelfHealAuditChecks(args),
};

/**
 * FORGE-01: for an audit-stamped run, run the platform checks on the clean
 * checkout and post ONE sealing report BEFORE the agent exists. Runner failure
 * reports "error" for every requested check. Never throws and never fails the
 * run; the check token is used only for the report header and never logged.
 * A run without `selfHeal` does nothing (no step line, no request).
 */
export async function runSelfHealAuditStep({
  input,
  workdir,
  egressProxyUrl,
  step,
  signal,
  deps = DEFAULT_SELF_HEAL_DEPS,
}: {
  input: Pick<AgentRunInput, "selfHeal" | "threadId" | "daemonCallbackUrl">;
  workdir: string;
  egressProxyUrl: string | null;
  step: (msg: string) => void;
  signal?: AbortSignal;
  deps?: SelfHealAuditStepDeps;
}): Promise<void> {
  const selfHeal = input.selfHeal;
  if (!selfHeal || selfHeal.kind !== "audit") return;
  const requested = selfHeal.checks;
  let results: SelfHealCheckResult[];
  try {
    if (requested.length === 0) {
      results = [];
    } else {
      let env: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "LANG", "LC_ALL"]) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      env.HOME = runPathsForRepo(workdir).home;
      if (egressProxyUrl) {
        env = appendGitConfig(
          buildRunProxyEnv(egressProxyUrl, env),
          gitProxyAuthConfig(egressProxyUrl),
        );
      }
      results = await deps.runChecks({
        checks: requested,
        run: runAsAgent,
        workdir,
        env,
        note: (message) => step(`self-heal checks: ${message}`),
        signal,
      });
    }
  } catch (err) {
    step(
      `self-heal checks: runner failed (${err instanceof Error ? err.name : "unknown"})`,
    );
    results = requested.map((c) => ({
      fingerprint: c.fingerprint,
      outcome: "error" as const,
    }));
  }
  let report: Awaited<ReturnType<typeof postSelfHealAuditChecks>> = "error";
  try {
    report = await deps.postReport({
      baseUrl: input.daemonCallbackUrl,
      checkToken: selfHeal.checkToken,
      threadId: input.threadId,
      results,
    });
  } catch {
    report = "error";
  }
  const count = (o: SelfHealCheckResult["outcome"]) =>
    results.filter((r) => r.outcome === o).length;
  step(
    `self-heal checks: requested=${requested.length} pass=${count("pass")} fail=${count("fail")} error=${count("error")} report=${report}`,
  );
}

/**
 * Mirror of definition.ts `executionTimeout: "30m"` (pinned by a test): the
 * post-agent fix check stops a minute before the engine would cancel the run.
 * Self-heal runs never refresh their timeout, so this stays the REGISTERED 30
 * minutes; a task run's effective budget (run-budget.ts) is separate.
 */
export const RUN_EXECUTION_TIMEOUT_MS = REGISTERED_EXECUTION_TIMEOUT;
const FIX_CHECK_RUN_MARGIN_MS = 60_000;

/** deadlineAt = min(now + 3 min, run start + 30 min − 60 s). */
export function fixCheckDeadline(now: number, runStartedAt: number): number {
  return Math.min(
    now + FIX_CHECK_BUDGET_MS,
    runStartedAt + RUN_EXECUTION_TIMEOUT_MS - FIX_CHECK_RUN_MARGIN_MS,
  );
}

export interface SelfHealFixStepDeps {
  remoteHead: typeof remoteBranchHead;
  runCheck: typeof runFixCheck;
  postReport: typeof postSelfHealFixCheck;
}

const DEFAULT_SELF_HEAL_FIX_DEPS: SelfHealFixStepDeps = {
  remoteHead: (args) => remoteBranchHead(args),
  runCheck: (args) => runFixCheck(args),
  postReport: (args) => postSelfHealFixCheck(args),
};

type FixStepInput = Pick<
  AgentRunInput,
  "selfHeal" | "daemonCallbackUrl" | "repoFullName"
>;

/** `head=` in the step line: the first 8 hex of a full sha, or none. */
function shortHead(sha: string | null): string {
  return sha !== null && /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 8) : "none";
}

/** Post a fix report and journal ONE line; never throws, never logs the token. */
async function reportSelfHealFix({
  input,
  report,
  startedAt,
  step,
  now,
  deps,
}: {
  input: FixStepInput;
  report: FixCheckReport;
  startedAt: number;
  step: (msg: string) => void;
  now: () => number;
  deps: SelfHealFixStepDeps;
}): Promise<void> {
  const selfHeal = input.selfHeal;
  if (selfHeal?.kind !== "fix") return;
  let posted: Awaited<ReturnType<typeof postSelfHealFixCheck>> = "error";
  try {
    posted = await deps.postReport({
      baseUrl: input.daemonCallbackUrl,
      gateToken: selfHeal.gateToken,
      attemptId: selfHeal.attemptId,
      report,
    });
  } catch {
    posted = "error";
  }
  step(
    `self-heal fix-check: status=${report.workerStatus} check=${report.checkOutcome ?? "none"} denied=${report.deniedPaths.length}${report.regressedFingerprints !== undefined ? ` regressed=${report.regressedFingerprints.length}` : ""} head=${shortHead(report.headSha)} ms=${Math.max(0, now() - startedAt)} report=${posted}`,
  );
}

/**
 * Best-effort report for a fix run that did not complete (cancelled, stopped,
 * nothing to run, or threw): workerStatus aborted, nothing checked.
 */
export async function reportSelfHealFixAborted({
  input,
  step,
  now = Date.now,
  deps = DEFAULT_SELF_HEAL_FIX_DEPS,
}: {
  input: FixStepInput;
  step: (msg: string) => void;
  now?: () => number;
  deps?: SelfHealFixStepDeps;
}): Promise<void> {
  await reportSelfHealFix({
    input,
    report: emptyFixReport("aborted"),
    startedAt: now(),
    step,
    now,
    deps,
  });
}

/**
 * GATE-01 (R1 box step): after a fix run's agent finished, kill everything
 * the agent could still be (its container is removed), close the brokers it
 * pushed through, then check exactly the commit that landed on GitHub and
 * report it with the gate token. The finally block's teardown and closes run
 * again afterwards as no-ops. Never throws and never changes the run outcome.
 */
export async function runSelfHealFixStep({
  input,
  workdir,
  egressProxyUrl,
  baseSha,
  lockLost,
  teardown,
  reap,
  gitBroker,
  ghBroker,
  runStartedAt,
  step,
  signal,
  now = Date.now,
  deps = DEFAULT_SELF_HEAL_FIX_DEPS,
  installationToken,
}: {
  input: FixStepInput;
  /** #380: from the unsealed RunSecrets, never from the input. */
  installationToken: string;
  workdir: string;
  egressProxyUrl: string | null;
  /** origin/<base>, pinned before the agent ran (pinFixBaseSha). */
  baseSha: string | null;
  /** The box lock was lost: another run may own the box slot now. */
  lockLost: boolean;
  teardown: () => void;
  /** Resolves once the agent is gone (its container removed). */
  reap: () => Promise<unknown>;
  gitBroker: Pick<GitBroker, "lastPushedSha" | "close"> | null;
  ghBroker: Pick<GhBroker, "close"> | null;
  runStartedAt: number;
  step: (msg: string) => void;
  signal?: AbortSignal;
  now?: () => number;
  deps?: SelfHealFixStepDeps;
}): Promise<void> {
  const selfHeal = input.selfHeal;
  if (selfHeal?.kind !== "fix") return;
  const startedAt = now();
  let report: FixCheckReport;
  try {
    teardown();
    if (!lockLost) await reap();
    const lastPushed = gitBroker?.lastPushedSha() ?? null;
    await Promise.all([closeQuietly(gitBroker), closeQuietly(ghBroker)]);

    const failed = (reason: string): FixCheckReport => {
      step(`self-heal fix-check: ${reason}`);
      return emptyFixReport(
        "error",
        lastPushed !== null && /^[0-9a-f]{40}$/.test(lastPushed)
          ? lastPushed
          : null,
      );
    };

    // A 2xx receive-pack can still carry a per-ref rejection: only a commit
    // GitHub actually holds on the attempt branch is checked.
    let pushedSha: string | null = null;
    let refused: FixCheckReport | null = null;
    if (lockLost) {
      refused = failed("box lock lost; not checking");
    } else if (lastPushed !== null) {
      try {
        const head = await deps.remoteHead({
          repoFullName: input.repoFullName,
          branch: selfHeal.branch,
          installationToken,
        });
        if (head !== null && head !== lastPushed) {
          refused = failed("branch head on GitHub differs from the push");
        } else {
          pushedSha = head;
        }
      } catch (err) {
        refused = failed(
          `branch head lookup failed (${err instanceof Error ? err.name : "unknown"})`,
        );
      }
    }

    if (refused !== null) {
      report = refused;
    } else {
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "LANG", "LC_ALL"]) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      // #205: same proxy-auth entry as the agent's git (one helper, one rule).
      const checkEnv = appendGitConfig(env, gitProxyAuthConfig(egressProxyUrl));
      report = await deps.runCheck({
        fix: selfHeal,
        pushedSha,
        baseSha,
        workdir,
        run: runAsAgent,
        env: egressProxyUrl
          ? buildRunProxyEnv(egressProxyUrl, checkEnv)
          : checkEnv,
        deadlineAt: fixCheckDeadline(now(), runStartedAt),
        signal,
        now,
        note: (message) => step(`self-heal fix-check: ${message}`),
      });
    }
  } catch (err) {
    step(
      `self-heal fix-check: step failed (${err instanceof Error ? err.name : "unknown"})`,
    );
    report = emptyFixReport("error");
  }
  await reportSelfHealFix({ input, report, startedAt, step, now, deps });
}

async function runAgentInner(
  input: AgentRunInput,
  secrets: RunSecrets,
  revoker: TokenRevoker,
  ctx: RunCtx,
  config: ReturnType<typeof loadWorkerConfig>,
  wwwOpts: WwwClientOpts,
  runStartedAt: number,
  /** #371: the workflow run's stable identity (reservation key); see runAgent. */
  runKey: string,
  /** #437: shared with runAgentResolved so one abnormal terminal is posted. */
  abnormal: AbnormalEndState,
): Promise<AgentRunOutput> {
  // Cancellation signal (Hatchet cancel: scheduleTimeout/executionTimeout). Used
  // to abort in-flight pulls/polls so the finally-block daemon teardown runs
  // promptly — no orphan daemon survives a cancelled run.
  const signal: AbortSignal | undefined = ctx.abortController?.signal;
  // Step logging (boot-coder): each boot step is logged so a stalled re-fire
  // pinpoints exactly where the agent fails to launch. Never logs the prompt (H2)
  // — only ids, pids, counts, and thread status. #7: the run's traceparent is
  // stamped on every line (`trace=…`) so worker logs join the end-to-end trace.
  const tracePrefix = input.traceparent ? ` trace=${input.traceparent}` : "";
  const step = (msg: string) =>
    ctx.log(`[agent-run ${input.threadId}${tracePrefix}] ${msg}`);
  const pollCtx = {
    get cancelled() {
      return ctx.cancelled;
    },
    // Prefixed like every other line of this run, so the journal ties the
    // terminal poll to its thread (the box acceptance check orders the fix
    // check after it, per thread).
    log: (message: string) => step(message),
    signal,
    // #204: filled in once the daemon exists (below). Until then there is no agent
    // to have died, and the poll loop has not started either.
    agentFailure: () => daemonForPoll?.agentFailure() ?? null,
    // Any OOM kill in the run's container fails the run, even when only a
    // child died and the agent finished its turn (prod 2026-10-04, e335c83d).
    memoryStarvation: () => daemonForPoll?.memoryStarvation() ?? null,
    // #473: the terminal read revokes the daemon token, so the egress audit
    // batch goes out before every read — the final one included.
    beforeStatusRead: async (signal?: AbortSignal) => {
      await egressEvents?.flush(signal);
    },
  };
  let daemonForPoll: RunDaemon | null = null;
  // #371: this run's headroom reservation (set under the slot, below).
  let reservation: Reservation | null = null;

  // UAT #229 F2: say which lane this run is (and its PR) before anything can
  // fail, so the journal can be matched to a GitHub review without timestamps.
  step(formatRunStartLine(input));

  // FENCE-01: a self-heal fix run may push only its own attempt branch, and a
  // mention run (#729) only the ref dispatch named; that fence lives in the git
  // broker. Decide it before the clone, and refuse a fenced run on a box whose
  // agents would hold the raw token instead.
  const refFence =
    selfHealRefFence(input.selfHeal) ?? pushRefFence(input.pushRef);
  if (refFence && config.credentialBroker !== "on") {
    throw new Error(
      "a fenced run requires the credential broker (WORKER_CREDENTIAL_BROKER=on): the ref fence lives in the git broker",
    );
  }

  let run: Awaited<ReturnType<typeof provisionWorkdir>>;
  // Hoisted above the try so the main finally can log through the same
  // prefix as the admission steps.
  const admissionLog = (m: string) =>
    ctx.log(`[agent-run ${input.threadId}] ${m}`);
  // #183 / #205 / #371: the box slot and the headroom admission, with the
  // deferral waited out in process, live in run-admission.ts (shared with the
  // cell executor, #656 PR-E). It gives back what it holds when it throws or
  // skips; on `admitted` this run owns the slot and the reservation. From here
  // on this run IS slot `boxLock.slot`: every later read of `config` means the
  // slot's.
  const admitted = await admitRunSlot({
    input,
    ctx,
    config,
    wwwOpts,
    runKey,
    signal,
    step,
    admissionLog,
  });
  if (admitted.kind === "skipped") return admitted.output;
  const boxLock: BoxLock | null = admitted.boxLock;
  config = admitted.config;
  reservation = admitted.reservation;
  try {
    if (config.boxSlots > 1) {
      await ensureSlotNamespace({
        root: config.runNamespaceRoot,
        workerId: getProcessWorkerId(),
        slot: boxLock.slot,
      });
      step(`box slot ${boxLock.slot}/${config.boxSlots}`);
    }
    // Provision: clone into a per-run workdir keyed on threadId. threadId is
    // unique per thread; threadChatId is the shared legacy sentinel when
    // enableThreadChatCreation is off, so it would collide every run onto one
    // dir. Under the slot (#205): a failed clone cleans itself up
    // (provisionWorkdir) and the catch below gives the slot straight back.
    run = await provisionWorkdir({
      repoFullName: input.repoFullName,
      branch: input.branch,
      baseBranch: input.baseBranch,
      workBranch: input.workBranch,
      installationToken: secrets.installationToken,
      workdirRoot: config.workdirRoot,
      runId: input.threadId,
      minFreeBytes: config.diskFloorBytes,
      log: admissionLog,
    });
  } catch (err) {
    reservation?.release();
    await boxLock?.release();
    throw err;
  }
  let materialised: MaterialisedCredentials;
  // Every cleanupWorkdir below: a workdir that survives the rm is logged, not
  // swallowed.
  const workdirCleanup = { log: admissionLog };
  // The one unwind for every pre-daemon failure: close what was opened, wipe
  // the credential, remove the workdir, and ONLY THEN give the slot back
  // (ADR-007 I2, the same order as the finally) — at N > 1 a parked waiter
  // takes a freed slot immediately.
  const abandon = async (
    ...closers: Array<{ close(): Promise<void> } | null>
  ) => {
    try {
      for (const c of closers) await closeQuietly(c);
      await materialised?.cleanup();
      await cleanupWorkdir(run.runDir, workdirCleanup);
    } finally {
      // Cleanup BEFORE the release (I2), but the release ALWAYS happens: a
      // cleanup step that threw must not leave the slot held (and occupied)
      // until the worker restarts — the box would quietly run with N − 1.
      // #371: the headroom reservation goes with it (idempotent).
      reservation?.release();
      await boxLock?.release();
    }
  };
  // From here to the daemon's own try/finally the slot is HELD: every exit
  // goes through abandon(), or a throw would leak the slot's helper (and its
  // reservation) for the life of the worker — a wedged box at N = 1, a box
  // quietly running N − 1 slots above. The calls in this stretch do not throw
  // today; the guard is what keeps that from mattering.
  const workdir = run.repo;
  let fixBaseSha: string | null;
  let runReviewAgent: ReturnType<typeof reviewAgentForRun>["reviewAgent"];
  let lane: ReturnType<typeof resolveRunLane>;
  let taskGate: ReturnType<typeof taskAgentForRun>;
  try {
    step(
      `clone complete: ${input.repoFullName}@${input.branch}` +
        (input.baseBranch ? ` (base ${input.baseBranch} fetched)` : "") +
        (input.workBranch ? ` (work branch ${input.workBranch})` : ""),
    );
    // GATE-01: the fix check diffs the pushed commit against the base as it was
    // cloned. Pinned now, by the worker, because the agent can rewrite its own
    // remote-tracking refs. Never throws; null makes the check report error.
    fixBaseSha =
      input.selfHeal?.kind === "fix"
        ? await pinFixBaseSha({
            workdir,
            baseBranch: input.selfHeal.baseBranch,
          })
        : null;
    if (input.selfHeal?.kind === "fix" && fixBaseSha === null) {
      step("self-heal fix-check: base branch not pinned (check will error)");
    }

    // D1: resolve HOW this run authenticates to the model provider, BEFORE the
    // child env is built (the credential fixes HOME, and the env is built once).
    //
    // "shared" box: never pull, never write a provider credential to this disk.
    // "owner" box: pull the run's own credential and materialise it under a
    // per-run HOME, so the run spends the USER's subscription / API key exactly
    // like an in-sandbox run does.
    // A "shared" box never asks for a credential; it still gets a fresh HOME,
    // because an inherited one lets the agent CLI authenticate as the BOX OWNER
    // out of the macOS Keychain — no file, no env var, no trace.
    //
    // These two steps sit BETWEEN the clone and the try/finally that owns
    // cleanupWorkdir, and both can throw: the pull is a fetch (network error, or
    // the run's AbortSignal firing on cancel/scheduleTimeout) and materialise
    // does fs mkdir/writeFile. Without this guard such a throw escapes before
    // the try is ever entered, and the cloned workdir is stranded on the box's
    // disk for good. Cleaning the workdir also removes the per-run HOME beneath
    // it, so a half-written credential cannot survive either.
    // Phase 5: bounds-check the review shape, so a rejected orchestrated run
    // runs classic. Numbers/field names only (H2).
    const reviewAgentGate = reviewAgentForRun(input.reviewAgent);
    runReviewAgent = reviewAgentGate.reviewAgent;
    if (reviewAgentGate.rejected) {
      step(
        `review agent: bounds-rejected (${reviewAgentGate.rejected}) → classic`,
      );
    }
    // Phase 7: task-run packs, shape-gated (reason only, H2). The review lane
    // never takes task packs, whatever the input carries; every battery is
    // in the image (ADR-013), so the gate only reaches the `batteries:` line.
    lane = resolveRunLane(input);
    taskGate = taskAgentForRun(input.taskAgent, lane);
    if (taskGate.kind === "rejected") {
      step(
        taskGate.reason === "review-lane"
          ? "task agent: ignored (review-lane)"
          : `task agent: rejected (${taskGate.reason})`,
      );
    }
  } catch (err) {
    await abandon();
    throw err;
  }

  try {
    const pulled =
      config.boxTrust === "owner"
        ? await pullAgentCredentials(wwwOpts, signal)
        : { agent: "", credentials: { type: "built-in-credits" as const } };
    // EVERY run gets a fresh per-run HOME (a staging dir the container copies
    // into its HOME volume), credential or not, seeded as a trusted
    // workspace for /workspace.
    // Both halves are load-bearing: the fresh HOME keeps a run off the
    // operator's own logins/Keychain, and the trust seed is what lets a
    // review run (--permission-mode default, no skip-permissions) grant its
    // tools in -p mode. An unseeded workspace makes the CLI ignore
    // .claude/settings.json and the review agent exits 1 with zero API calls
    // — verified from captured stderr, and reproduced for owner mode in
    // production before the seed landed. Credits/box-key runs need the seed
    // just as much: review mode does not care where the model credential
    // comes from.
    materialised = await materialiseAgentCredentials({
      credentials: pulled.credentials,
      agent: pulled.agent,
      run,
    });
  } catch (err) {
    await abandon();
    throw err;
  }
  // #209 item 1: capture WHICH credential path this run took, once, here —
  // the branch that already decides it. The log line below is DERIVED from the
  // captured value, so the operator's log and the attribution persisted on the
  // thread cannot disagree.
  const credentialSource = resolveCredentialSource({
    boxTrust: config.boxTrust,
    credentialDelivered: materialised.delivered,
  });
  // H2: log the MODE, never the credential.
  // Name the credential the run will ACTUALLY use. The earlier version said
  // "→ credits" for every undelivered run, which is a lie under box-key and
  // would have sent the next person debugging this down the wrong path — the
  // same way it took two rollbacks to find the last one.
  step(
    `agent credential: ${describeCredentialSource(credentialSource)} (box trust: ${config.boxTrust})`,
  );
  // Exactly one `batteries:` line per run (ADR-013: the image digest).
  step(
    formatBatteriesLine({
      imageDigest: config.containerRuns.image.digest,
      lane,
      taskGate,
    }),
  );
  // Every non-review run's container settings carry the foreground-only
  // guard (containerLanePolicy); reviews log nothing new.
  if (lane !== "review") {
    step("task agent: foreground-only hook installed");
  }

  // #66 slice 2: per-run egress proxy. ADR-013 C3: a `--network none`
  // container's only route out is this proxy, so EVERY run gets one: enforce
  // when the control plane resolved a policy onto the run, else observe —
  // allow everything, audit everything, and mark every row so nothing
  // downstream can read it as enforcement (a repo with no policy must not
  // silently acquire a deny-all fence). A proxy-start failure must not strand
  // the clone: this sits outside the try/finally that owns cleanup, so it
  // cleans up itself.
  let egressProxy: EgressProxy | null = null;
  let egressEvents: ReturnType<typeof createEgressEventBatcher> | null = null;
  const egressMode: "enforce" | "observe" = input.egressPolicy
    ? "enforce"
    : "observe";
  {
    try {
      const batcher = createEgressEventBatcher(wwwOpts);
      egressEvents = batcher;
      egressProxy = await startEgressProxy({
        policy: input.egressPolicy ?? { level: "none", allowlist: [] },
        mode: egressMode,
        onEvent: (e) => batcher.add(e),
        // #205: at N > 1 a sibling slot could otherwise use this run's loopback
        // proxy (its allowlist, its audit trail). N = 1 stays credential-less.
        credential:
          config.boxSlots > 1
            ? { user: "run", secret: randomBytes(24).toString("hex") }
            : undefined,
      });
      // A2, BLOCKING: a proxy that does not answer turns the run into a silent
      // 90s hang with no output that the agent cannot report. Prove the
      // listener before anything is pointed at it.
      await assertEgressProxyReachable({ url: egressProxy.url });
    } catch (err) {
      await abandon(egressProxy, egressEvents);
      throw err;
    }
    step(
      `egress proxy up (${egressMode}): 127.0.0.1:${egressProxy.port} ` +
        (input.egressPolicy
          ? `(level=${input.egressPolicy.level}, ${input.egressPolicy.allowlist.length} allowlist entries)`
          : "(no repo policy — allow-all, every decision audited)"),
    );
  }

  // #81: per-run GitHub credential brokers — the installation token stays in
  // THIS process's heap. A container of a lane that may write gets only a
  // per-run bearer through forwarded sockets; a review container gets no
  // broker socket at all (containerLanePolicy). Both brokers must be up
  // before the host gh preflight. Same self-cleanup rule as the egress block
  // above — and fail-closed: a broker start failure throws.
  let gitBroker: GitBroker | null = null;
  let ghBroker: GhBroker | null = null;
  let broker: BrokerHandoff | null = null;
  if (config.credentialBroker === "on") {
    try {
      // Minted once per run, shared by both brokers; never logged.
      const runBearer = randomBytes(32).toString("hex");
      gitBroker = await startGitBroker({
        installationToken: secrets.installationToken,
        repoFullName: input.repoFullName,
        runBearer,
        // Only fix runs carry the key at all; every other run is unchanged.
        ...(refFence ? { refFence } : {}),
      });
      ghBroker = await startGhBroker({
        installationToken: secrets.installationToken,
        runBearer,
        socketPath: runGhSocketPath(
          config.runNamespaceRoot,
          getProcessWorkerId(),
          input.threadId,
          // #205: in the slot's own subdir, reachable by this slot alone.
          slotFor(config),
        ),
      });
      broker = {
        gitUrl: gitBroker.url,
        ghSocketPath: ghBroker.socketPath,
        bearer: runBearer,
        repoFullName: input.repoFullName,
      };
    } catch (err) {
      await abandon(gitBroker, ghBroker, egressProxy, egressEvents);
      throw err;
    }
    step(
      `credential brokers up: git=127.0.0.1:${gitBroker.port}, gh=${ghBroker.socketPath}` +
        (refFence ? ` (pushes fenced to ${refFence.exactRef})` : ""),
    );
  }

  // ADR-013: every run is a container from the pinned image; everything
  // around the spawn — admission, slot, ledger, brokers, poll, teardown
  // order — is unchanged.
  const containerDaemon = new ContainerDaemonProcess(
    config,
    input,
    run,
    materialised,
    lane,
    {
      secrets: {
        daemonToken: secrets.daemonToken,
        ...(secrets.repoEnv !== undefined ? { repoEnv: secrets.repoEnv } : {}),
      },
      // C3 (#430): the proxy and brokers, reached through forwarded sockets;
      // a review lane gets no broker socket.
      egressProxyUrl: egressProxy?.url ?? null,
      broker,
      // The bot-identity precondition runs on the host against the brokers
      // before the container exists (gh-preflight.ts).
      hostPreflight: () =>
        preflightHostGhAuth({
          workdir,
          installationToken: secrets.installationToken,
          botLogin: config.botLogin,
          broker,
          egressProxyUrl: egressProxy?.url ?? null,
        }),
      log: admissionLog,
    },
  );
  const daemon: RunDaemon = containerDaemon;
  daemonForPoll = daemon;
  // Exactly one fix-check report per fix run: the check's, or "aborted".
  let fixReported = false;
  // #437: what the daemon phase threw, and whether it RETURNED a normal end
  // (completed / nothing-to-run / stopped): a cancel that lands after that is
  // not what ended the run.
  let runThrew: { error: unknown } | null = null;
  let endedNormally = false;
  try {
    // Fail-closed identity precondition (ADR-002): confirm gh authenticates as the
    // bot (installation token + isolated config) in the workdir BEFORE spawning —
    // a misconfigured box must block, never silently post as the wrong identity.
    // #6: an auth-precondition failure is a MISCONFIG (never transient) → mark it
    // NonRetryableError so it routes straight to onFailure, not backoff.
    try {
      await daemon.preflightGhAuth();
    } catch (err) {
      throw nonRetryablePreflight(err);
    }
    step("gh auth precondition ok (bot identity)");

    // FORGE-01: seal the deterministic check outcomes on the clean checkout
    // before the agent exists. Never throws, never fails the run.
    await runSelfHealAuditStep({
      input,
      workdir,
      egressProxyUrl: egressProxy?.url ?? null,
      step,
      signal,
    });

    // Run: bring up the daemon, then pull the message it should execute.
    await daemon.start();
    abnormal.daemonStarted = true;
    step(containerDaemon.spawnedLine());
    // #371 / #574: from here the container's own cgroup says what anonymous
    // memory the kernel already charges this run (what Committed_AS counts);
    // the headroom reservation counts only the remainder. Without this every
    // live run kept its full run commit reserved on top of Committed_AS, and
    // the third slot was refused at any real load.
    reservation?.observe(() => containerDaemon.memoryAnonBytes());
    // #6: a 4xx next-message (PR gone / permission / bad token) is terminal →
    // NonRetryableError; a 5xx/network stays retryable (classifyNextMessageError).
    let message: Awaited<ReturnType<typeof pullNextMessage>>;
    try {
      message = await pullNextMessage(wwwOpts, signal);
    } catch (err) {
      throw classifyNextMessageError(err);
    }
    if (!message) {
      // Nothing to run (no pending user message / empty prompt).
      step("next-message: 204 (nothing to run)");
      if (input.selfHeal?.kind === "fix") {
        // R4: a 204 is typically the DUPLICATE of an ambiguous dispatch whose
        // first run owns the message. Its "aborted" report could win the
        // single-use check CAS ahead of the real run's, so it reports
        // nothing; a fix run that truly never ran is the reconcile's.
        fixReported = true;
        step("self-heal fix-check: not reported (nothing to run)");
      }
      endedNormally = true;
      return {
        threadId: input.threadId,
        threadChatId: input.threadChatId,
        outcome: "nothing-to-run",
      };
    }
    // H2: log only non-sensitive shape, never the prompt.
    step(
      `next-message: got message (agent=${message.agent}, model=${message.model})`,
    );
    // The worker has the final say on useCredits — www's guess is wrong in
    // both directions out here (see resolveUseCredits). In particular,
    // box-key must OVERRIDE an incoming useCredits=true: www sets it exactly
    // when the user has no connected credential, which is the box-key
    // operator's normal state, and an un-overridden true makes daemon-env
    // blank the box key and 402 at the proxy — the pilot failure this mode
    // exists to fix.
    const resolved = resolveUseCredits({
      boxTrust: config.boxTrust,
      credentialDelivered: materialised.delivered,
      incomingUseCredits: message.useCredits === true,
    });
    if (resolved.log) {
      step(resolved.log);
    }
    message.useCredits = resolved.useCredits;
    // #209 item 1: report the attribution decided at the branch above. Posted
    // HERE and not at the branch so a 204 "nothing to run" never puts a
    // credential line on a thread that never ran an agent. The VALUE is still
    // frozen at the branch; only the transport happens here. Never throws —
    // reporting must not fail a run.
    await postRunCredentialSource(wwwOpts, { source: credentialSource });
    // Phase 5: stamp the daemon wire for orchestrated review runs that passed
    // the bounds gate above; anything else sends today's exact message object.
    const stamped = withReviewAgentWire(message, runReviewAgent);
    if (stamped.reviewAgent) {
      step(
        `review agent: orchestrated → daemon (bashTimeoutMs=${stamped.reviewAgent.commandTimeoutMs}, maxTurns=${stamped.reviewAgent.maxTurns ?? "unset"})`,
      );
    }
    const bytes = await daemon.sendMessage(stamped);
    step(`socket write ok: ${bytes} bytes → daemon ACKed`);

    // Poll www for terminal. The daemon streams events to www, which owns the
    // thread status; the worker asks www, not the daemon. Revoke-race ruling and
    // the poll loop live in www-client (pollUntilTerminal).
    const result = await pollUntilTerminal(
      pollCtx,
      wwwOpts,
      config.pollIntervalMs,
    );
    // #503: that terminal read revoked the daemon token, so whatever the
    // batcher holds now can no longer be delivered: teardown logs it as an
    // expected drop instead of retrying a 401. A cancel keeps the live token.
    if (result.outcome === "completed") {
      egressEvents?.markTerminal();
    }
    if (input.selfHeal?.kind === "fix" && result.outcome === "completed") {
      fixReported = true;
      await runSelfHealFixStep({
        input,
        installationToken: secrets.installationToken,
        workdir,
        egressProxyUrl: egressProxy?.url ?? null,
        baseSha: fixBaseSha,
        lockLost: boxLock?.lost === true,
        // A container teardown is a promise: never left unhandled here (an
        // unhandled rejection kills the worker); the finally below awaits
        // the same memoised promise and logs its failure.
        teardown: () => {
          void Promise.resolve(daemon.teardown()).catch(() => {});
        },
        // The "reap" is the container's removal (awaited, idempotent).
        reap: () => containerDaemon.teardown(),
        gitBroker,
        ghBroker,
        runStartedAt,
        step,
        signal,
      });
    }
    endedNormally = result.outcome !== "cancelled";
    return {
      threadId: input.threadId,
      threadChatId: input.threadChatId,
      outcome: result.outcome,
      finalStatus: result.finalStatus,
    };
  } catch (err) {
    runThrew = { error: err };
    throw err;
  } finally {
    // #380: the teardown sequence below is wrapped so a throw in any step can
    // never skip the token revoke, the credential wipe or the lock release.
    try {
      // #437 Part A2: claim the typed terminal of an abnormal end (posted
      // below, BEFORE the brokers close and the checkout goes). A normal end,
      // or a run this plane does not own, claims null. A normal end is
      // settled too, so a later teardown throw cannot be claimed by the
      // outer catch as `daemon-failed`.
      const claimEnd = (): AbnormalEnd | null => {
        const cancelled =
          !endedNormally && (ctx.cancelled || signal?.aborted === true);
        const abnormalExit = runThrew !== null || cancelled;
        if (!abnormalExit) {
          abnormal.claimed = true;
          return null;
        }
        return abnormal.owns
          ? claimAbnormalEnd(abnormal, {
              ...(runThrew ? { thrown: runThrew } : {}),
              cancelled,
              starvation: readMemoryStarvation(daemon),
            })
          : null;
      };
      // #437 Part B: a timeout's work is pushed while the broker is open, and
      // the post names the branch.
      // ADR-013: the salvage runs git INSIDE the container (never host git on
      // the container-written .git), so the end is claimed and a timeout
      // salvaged BEFORE the removal below. The salvage first freezes the
      // container's whole tree (SIGSTOP, init aside: prepareSalvage), so the
      // agent is stopped, not dead, until the removal kills it. The OOM flag
      // is re-read first, as the removal would have.
      await containerDaemon.refresh();
      const end = claimEnd();
      let salvage: SalvageResult | null = null;
      if (end) {
        salvage = await salvageWorkBranch({
          cause: end.cause,
          workBranch: input.workBranch,
          lockLost: boxLock?.lost === true,
          enabled: config.timeoutSalvage !== "off",
          container: containerDaemon,
          broker,
          repoFullName: input.repoFullName,
          botLogin: config.botLogin,
          runExecutionTimeoutMs: abnormal.runExecutionTimeoutMs,
          log: step,
        });
      }
      // Terminal OR cancel (incl. scheduleTimeout): remove the container
      // (`docker rm -f -v`: SIGKILL to its whole pid namespace, so no orphan
      // survives), then the workdir. Runs on normal return, throw, and
      // cancellation (pollUntilTerminal returns promptly on cancel). It
      // resolves once the container is gone (retried with backoff while this
      // run still holds the slot); a removal that kept failing is logged,
      // never thrown (see settleDaemonTeardown for why the slot still goes).
      await settleDaemonTeardown(daemon, input.threadId, admissionLog);
      // #371: idempotent — a run that never reached its first progress poll still
      // frees its headroom reservation here.
      reservation?.release();
      if (end) {
        await postAbnormalEnd(abnormal, end, {
          wwwOpts,
          log: step,
          salvage,
        });
      }
      // #66: close the egress proxy after the daemon is dead (no more child
      // traffic), then flush the last audit batch. Both are best-effort — an
      // audit/proxy teardown hiccup must never mask the run's real outcome.
      // #205: the proxy-auth audit is capped; the total lands in the step log.
      const refused = egressProxy?.unauthenticatedRequests() ?? 0;
      if (refused > 0) {
        step(
          `egress proxy: ${refused} request(s) answered 407 (proxy-auth) — a client authenticating after the challenge (Chromium via gstack browse does), or a caller without the run credential`,
        );
      }
      await closeQuietly(egressProxy);
      // #81: close both credential brokers after the daemon is dead (no more
      // child git/gh traffic). Best-effort, like the egress proxy — the token
      // dies with this process either way.
      await closeQuietly(gitBroker);
      await closeQuietly(ghBroker);
      // GATE-01: a fix run that did not reach its check still reports, once.
      if (input.selfHeal?.kind === "fix" && !fixReported) {
        fixReported = true;
        await reportSelfHealFixAborted({ input, step });
      }
    } finally {
      // #380: both ghs_ tokens are revoked HERE — after the container is
      // gone, the brokers/proxy closed and the fix check
      // reported (it still needed the token), and BEFORE the box lock goes.
      // Best effort, never throws, one `token.revoke` line per token.
      await revoker.revokeOnce();
      await closeQuietly(egressEvents);
      try {
        // Wipe the delivered credential before the workdir goes, so a cleanup
        // failure on the workdir can never leave a live token behind.
        await materialised.cleanup();
        await cleanupWorkdir(run.runDir, workdirCleanup);
      } finally {
        // The box lock goes last (ADR-007 I2, ADR-013 I6): the next run may
        // start only once this one's container is gone and its disk footprint
        // is gone — and it
        // goes whatever the cleanup did, or the slot stays held until a restart.
        await boxLock?.release();
      }
    }
  }
}

/**
 * #437: the daemon's OOM signal (the error it would fail the run with), or
 * null. Never throws: a failed read is "no signal", and a thrown
 * MemoryStarvationError (when the poll loop raised it) still classifies.
 */
function readMemoryStarvation(daemon: RunDaemon): unknown {
  try {
    return daemon.memoryStarvation();
  } catch {
    return null;
  }
}

/**
 * #2 on-failure handler. Fires ONLY when the workflow FAILED (Hatchet guarantees
 * this), so it can never post a false failure on a successful run. It POSTs a
 * synthetic terminal `custom-error` to www (postRunFailed) so the thread flips to a
 * surfaced error + runs the finish pipeline, instead of hanging as a silent
 * "working…". The www transition is terminal-idempotent, so a race with a real
 * terminal event is absorbed (CAS no-op). No `name` option — CreateOnFailureTaskOpts
 * omits it (SDK amendment 3).
 *
 * BACKSTOP CAVEAT (amendment 4): this auths with the run's daemon token. For the
 * revoked-token failure class (S12 family) that token is ALREADY dead, so the POST
 * 401s and this cannot mark the thread failed — the www-side stalled-thread watchdog
 * (raised to 75m in cron.ts) is the ONLY backstop there.
 *
 * #380: the token is INSIDE the sealed envelope, so this handler unseals too.
 * When the run failed BECAUSE the envelope could not be unsealed (unknown kid,
 * bad tag), nothing can be posted: the failure is logged by class only and
 * www's sweep rule (iii) marks the thread `run-failed-unreported` and revokes
 * its daemon token. No revoke of the ghs_ tokens here — the run fn's finally
 * already did that.
 *
 * H2: the reason is built ONLY from Hatchet's own error summary (ctx.errors()),
 * never agent output or the prompt. Wrapped so onFailure never throws uncaught.
 */
async function onAgentRunFailure(
  wire: AgentRunWireInput,
  ctx: { errors?: () => Record<string, string>; workflowRunId?: () => string },
): Promise<void> {
  let input: AgentRunInput;
  let secrets: RunSecrets;
  try {
    ({ input, secrets } = await resolveRunSecrets({
      wire,
      keys: planeKeysForRun(loadWorkerConfig().payloadSealKeyFile),
    }));
  } catch (err) {
    // The message is a PayloadSealError's (kid + reason) or a shape error —
    // never a secret byte.
    console.error(
      `[agent-run ${wire.threadId}] onFailure: run secrets unavailable (${err instanceof Error ? err.message : String(err)}) — run-failed not posted; the control plane's sweep rule (iii) reconciles`,
    );
    return;
  }
  // #437: a task run posts its own typed terminal from its teardown. On an
  // executionTimeout the SDK rejects the task's future at once, so this
  // handler is scheduled while that teardown still runs, and www keeps the
  // FIRST terminal — so wait (bounded) for a run still live in this process
  // to end before the generic post, which is then absorbed as a no-op.
  const runId = ctx.workflowRunId?.() || "";
  if (runId && ownsAbnormalTerminal(input)) {
    const ended = await waitForLiveRunEnd(
      runId,
      ON_FAILURE_TYPED_TERMINAL_WAIT_MS,
    );
    if (!ended) {
      console.error(
        `[agent-run ${input.threadId}] onFailure: the run's teardown did not finish within ${ON_FAILURE_TYPED_TERMINAL_WAIT_MS / 1000}s — posting the generic failure`,
      );
    }
  }
  // #656: a cell run that ended with a retired token (H7), a token www deleted
  // on a step conflict, or a newer attempt owning the thread cannot, or must
  // not, post: that is expected, so it is neither attempted nor escalated.
  const endMark = runId ? runEndMarks.take(runId) : undefined;
  if (endMark !== undefined) {
    console.info(
      `[agent-run ${input.threadId}] ${RUN_END_MARK_MESSAGES[endMark]}`,
    );
    return;
  }
  try {
    await postRunFailed(
      {
        baseUrl: input.daemonCallbackUrl,
        daemonToken: secrets.daemonToken,
        threadId: input.threadId,
        threadChatId: input.threadChatId,
        runExternalId: ctx.workflowRunId?.() || undefined,
      },
      { reason: summarizeHatchetErrors(ctx) },
    );
  } catch (err) {
    // postRunFailed already swallows its own errors; this is defense-in-depth so
    // a summarise/build throw can't escape the on-failure task.
    console.error(
      `[agent-run ${input.threadId}] onFailure handler threw (swallowed)`,
      err,
    );
  }
}

/**
 * Build the failure reason from Hatchet's per-task error map (ctx.errors()): the
 * error class/message the run task threw — NOT agent output (H2). `ctx.errors()`
 * logs a warning when empty, so it's guarded.
 */
function summarizeHatchetErrors(ctx: {
  errors?: () => Record<string, string>;
}): string {
  try {
    const errs = ctx.errors?.() ?? {};
    const summary = Object.entries(errs)
      .map(([task, message]) => `${task}: ${message}`)
      .join("; ");
    return summary || "agent-run failed (no error detail from Hatchet)";
  } catch {
    return "agent-run failed";
  }
}
