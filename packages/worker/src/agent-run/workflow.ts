import { randomBytes } from "node:crypto";
import { hatchet } from "../hatchet-client";
import {
  AGENT_RUN_VARIANTS,
  buildAgentRunDefinition,
  type AgentRunVariantName,
  type PerPrStrategy,
} from "./definition";
import { loadWorkerConfig } from "./config";
import { acquireBoxLock, type BoxLock } from "./box-lock";
import { reapOwnThreadAttempts, reclaimDeadWorkerRuns } from "./reclaim";
import { reapAgentUidEscapees } from "./uid-reaper";
import { runAsAgent } from "./agent-command";
import { DaemonProcess } from "./daemon-process";
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
import { formatRunStartLine, resolveRunLane } from "./run-lane";
import { reviewAgentForRun, withReviewAgentWire } from "./review-agent-wire";
import {
  batterySeedForRun,
  foregroundOnlyForRun,
  taskAgentForRun,
  taskRunOutcome,
} from "./task-agent";
import {
  classifyNextMessageError,
  nonRetryablePreflight,
} from "./retry-classification";
import {
  pollUntilTerminal,
  postEgressEvents,
  postRunCredentialSource,
  postRunFailed,
  postRunTerminal,
  postSelfHealAuditChecks,
  postSelfHealFixCheck,
  checkRunStaleness,
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
import { buildRunProxyEnv, type BrokerHandoff } from "./daemon-env";
import { runPathsForRepo } from "./run-owned-paths";
import {
  ensureRunNamespace,
  getProcessWorkerId,
  runGhSocketPath,
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
 * definition.ts). Both cap at 1 today:
 *   1. per-ORG key (`input.orgId`): serializes runs WITHIN an org. orgId is
 *      guaranteed non-empty by dispatch (the `u:${userId}` fallback) so the CEL
 *      key never dereferences null.
 *   2. global constant key: the single-box daemon memory budget — only ONE
 *      agent-run executes at a time across ALL orgs and BOTH workers. It is a
 *      single group, so ordering across orgs under it is FIFO (observed, #128
 *      E2E — docs/uat/hatchet-lite-v0.94.10-observed.md §1); cross-org fairness
 *      needs global>1 (#3b, memory-gated).
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
 */
export function createEgressEventBatcher(wwwOpts: WwwClientOpts): {
  add: (event: EgressDecisionEvent) => void;
  close: () => Promise<void>;
} {
  let buffer: EgressEventWire[] = [];
  const flush = (): Promise<void> => {
    if (buffer.length === 0) {
      return Promise.resolve();
    }
    const events = buffer;
    buffer = [];
    return postEgressEvents(wwwOpts, events);
  };
  const timer = setInterval(() => void flush(), EGRESS_BATCH_FLUSH_MS);
  // Never hold the worker process open for an audit flush tick.
  timer.unref?.();
  return {
    add(event) {
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
    async close() {
      clearInterval(timer);
      await flush();
    },
  };
}

/**
 * Register one agent-run workflow from its pure definition with the real run
 * fn + onFailure handler.
 */
export function makeAgentRunWorkflow(
  name: string,
  perPrStrategy: PerPrStrategy,
) {
  const def = buildAgentRunDefinition(name, perPrStrategy);
  const wf = hatchet.workflow<AgentRunInput>(def.workflow);
  wf.task({ ...def.task, fn: runAgent });
  wf.onFailure({ fn: onAgentRunFailure });
  return wf;
}

/** The slice of Hatchet's task context the run fn consumes. */
type RunCtx = {
  abortController?: AbortController;
  cancelled: boolean;
  log: (message: string) => void;
  workflowRunId?: () => string;
};

/**
 * The www client options for THIS run: ids + the #7 traceparent header on
 * every call, and (#125 C1) this run's generation as `x-run-external-id` so
 * the control plane's fence can refuse a write from a superseded run.
 */
function wwwOptsFor(input: AgentRunInput, ctx: RunCtx): WwwClientOpts {
  return {
    baseUrl: input.daemonCallbackUrl,
    daemonToken: input.daemonToken,
    threadId: input.threadId,
    threadChatId: input.threadChatId,
    traceparent: input.traceparent,
    runExternalId: ctx.workflowRunId?.() || undefined,
  };
}

/**
 * The ONE run task fn shared by every variant. Wraps `runAgentInner` with the
 * #125 C4 queue-mode staleness self-check and the #125 C1 cancel hook: when
 * the engine cancels THIS run (in-flight or pre-daemon during provision)
 * under a native policy, an explicit `superseded` terminal is posted to www
 * after teardown — `finally` runs on both return and throw, so exactly once.
 * Legacy runs (no supersedePolicy — non-review lanes) post nothing: the
 * control plane owns that terminal.
 */
async function runAgent(
  input: AgentRunInput,
  ctx: RunCtx,
): Promise<AgentRunOutput> {
  // TMO-01: the 30-minute execution timeout counts from here; the post-agent
  // fix check must finish inside it.
  const runStartedAt = Date.now();
  const config = loadWorkerConfig();
  const wwwOpts = wwwOptsFor(input, ctx);
  const runExternalId = wwwOpts.runExternalId ?? "";
  // Under complete-run·queue a run may have waited behind an older one while
  // newer commits landed. Ask www FIRST; if a newer run is already recorded,
  // skip with a typed terminal — no clone, no daemon, no credits. Fails open.
  if (input.supersedePolicy === "complete-run-queue" && runExternalId) {
    const stale = await checkRunStaleness(
      wwwOpts,
      { runExternalId },
      ctx.abortController?.signal,
    );
    if (stale) {
      const result = await postRunTerminal(wwwOpts, {
        runExternalId,
        cause: "stale-skipped",
        policy: input.supersedePolicy,
      });
      ctx.log(
        `[agent-run ${input.threadId}] stale-skipped (newer run queued for this PR) → terminal: ${result}`,
      );
      return {
        threadId: input.threadId,
        threadChatId: input.threadChatId,
        outcome: "stale-skipped",
      };
    }
  }
  try {
    const output = await runAgentInner(
      input,
      ctx,
      config,
      wwwOpts,
      runStartedAt,
    );
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
  } finally {
    if (ctx.cancelled || ctx.abortController?.signal.aborted) {
      await postSuperseded(input, ctx, wwwOpts);
    }
  }
}

/**
 * Structural mirror of the control plane's engine-owned policy set (the
 * planes share no imports — composability invariant; drift is caught by the
 * C3 E2E, same contract as the variant table above).
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
 * Registered variants, in the table's order. `agent-run` (legacy, no per-PR
 * entry) keeps the pre-#125 REST trigger contract byte-identical.
 */
export const agentRunWorkflows = (
  Object.keys(AGENT_RUN_VARIANTS) as AgentRunVariantName[]
).map((name) => makeAgentRunWorkflow(name, AGENT_RUN_VARIANTS[name]));

/** The legacy workflow, exported by name for existing callers/tests. */
export const agentRunWorkflow = agentRunWorkflows.find(
  (w) => w.definition.name === "agent-run",
)!;

export interface SelfHealAuditStepDeps {
  runChecks: typeof runSelfHealChecks;
  postReport: typeof postSelfHealAuditChecks;
}

/**
 * Mirror of @terragon/shared `FIX_BRANCH_PREFIX` (the worker does not depend
 * on shared); a drift test in workflow.test.ts pins the two together.
 */
export const WORKER_FIX_BRANCH_PREFIX = "automata/fix-";

/**
 * FENCE-01: the git-broker ref fence for a self-heal fix run — exactly
 * `refs/heads/<attempt branch>` — or undefined for every other run (no fence,
 * no buffering). Fails closed on a branch that is not a plain
 * `automata/fix-*` name: a fence built from `main` would be no fence at all.
 */
export function selfHealRefFence(
  selfHeal: AgentRunInput["selfHeal"],
): { exactRef: string } | undefined {
  if (selfHeal?.kind !== "fix") return undefined;
  const branch = selfHeal.branch;
  const suffix = branch.startsWith(WORKER_FIX_BRANCH_PREFIX)
    ? branch.slice(WORKER_FIX_BRANCH_PREFIX.length)
    : "";
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(suffix) ||
    suffix.includes("..") ||
    suffix.endsWith(".") ||
    suffix.endsWith(".lock")
  ) {
    throw new Error(
      `self-heal fix run: branch is not a ${WORKER_FIX_BRANCH_PREFIX}* branch name`,
    );
  }
  return { exactRef: `refs/heads/${branch}` };
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
  agentUser,
  egressProxyUrl,
  step,
  signal,
  deps = DEFAULT_SELF_HEAL_DEPS,
}: {
  input: Pick<AgentRunInput, "selfHeal" | "threadId" | "daemonCallbackUrl">;
  workdir: string;
  agentUser: string;
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
      const run = runPathsForRepo(workdir);
      env.HOME = run.home;
      if (agentUser) {
        env.USER = agentUser;
        env.LOGNAME = agentUser;
        env.TMPDIR = run.tmp;
        env.GIT_CONFIG_COUNT = "1";
        env.GIT_CONFIG_KEY_0 = "safe.directory";
        env.GIT_CONFIG_VALUE_0 = workdir;
      }
      if (egressProxyUrl) env = buildRunProxyEnv(egressProxyUrl, env);
      results = await deps.runChecks({
        checks: requested,
        run: runAsAgent,
        agentUser,
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
 */
export const RUN_EXECUTION_TIMEOUT_MS = 30 * 60_000;
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
  "selfHeal" | "daemonCallbackUrl" | "repoFullName" | "installationToken"
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
    `self-heal fix-check: status=${report.workerStatus} check=${report.checkOutcome ?? "none"} denied=${report.deniedPaths.length} head=${shortHead(report.headSha)} ms=${Math.max(0, now() - startedAt)} report=${posted}`,
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
 * the agent could still be (daemon group, agent-uid escapees), close the
 * brokers it pushed through, then check exactly the commit that landed on
 * GitHub and report it with the gate token. The finally block's teardown,
 * reap and closes run again afterwards as no-ops. Never throws and never
 * changes the run outcome.
 */
export async function runSelfHealFixStep({
  input,
  workdir,
  agentUser,
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
}: {
  input: FixStepInput;
  workdir: string;
  agentUser: string;
  egressProxyUrl: string | null;
  /** origin/<base>, pinned before the agent ran (pinFixBaseSha). */
  baseSha: string | null;
  /** The box lock was lost: another run may own the agent uid now. */
  lockLost: boolean;
  teardown: () => void;
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
          installationToken: input.installationToken,
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
      if (agentUser) {
        env.USER = agentUser;
        env.LOGNAME = agentUser;
        env.GIT_CONFIG_COUNT = "1";
        env.GIT_CONFIG_KEY_0 = "safe.directory";
        env.GIT_CONFIG_VALUE_0 = workdir;
      }
      report = await deps.runCheck({
        fix: selfHeal,
        pushedSha,
        baseSha,
        workdir,
        agentUser,
        run: runAsAgent,
        env: egressProxyUrl ? buildRunProxyEnv(egressProxyUrl, env) : env,
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
  ctx: RunCtx,
  config: ReturnType<typeof loadWorkerConfig>,
  wwwOpts: WwwClientOpts,
  runStartedAt: number,
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
    // Any OOM kill in the run's cgroup fails the run, even when only a child
    // died and the agent finished its turn (prod 2026-10-04, e335c83d).
    memoryStarvation: () => daemonForPoll?.memoryStarvation() ?? null,
  };
  let daemonForPoll: DaemonProcess | null = null;

  // UAT #229 F2: say which lane this run is (and its PR) before anything can
  // fail, so the journal can be matched to a GitHub review without timestamps.
  step(formatRunStartLine(input));

  // FENCE-01: a self-heal fix run may push only its own attempt branch, and
  // that fence lives in the git broker. Decide it before the clone, and refuse
  // a fix run on a box whose agents would hold the raw token instead.
  const refFence = selfHealRefFence(input.selfHeal);
  if (refFence && config.credentialBroker !== "on") {
    throw new Error(
      "self-heal fix run requires the credential broker (WORKER_CREDENTIAL_BROKER=on): the ref fence lives in the git broker",
    );
  }

  // Provision: clone into a per-run workdir keyed on threadId. threadId is unique
  // per thread; threadChatId is the shared legacy sentinel when
  // enableThreadChatCreation is off, so it would collide every run onto one dir.
  const run = await provisionWorkdir({
    repoFullName: input.repoFullName,
    branch: input.branch,
    baseBranch: input.baseBranch,
    workBranch: input.workBranch,
    installationToken: input.installationToken,
    workdirRoot: config.workdirRoot,
    runId: input.threadId,
    // #108: empty (the default) ⇒ no ACLs are touched at all.
    agentUser: config.agentUser,
  });
  const workdir = run.repo;
  step(
    `clone complete: ${input.repoFullName}@${input.branch}` +
      (input.baseBranch ? ` (base ${input.baseBranch} fetched)` : "") +
      (input.workBranch ? ` (work branch ${input.workBranch})` : ""),
  );
  // GATE-01: the fix check diffs the pushed commit against the base as it was
  // cloned. Pinned now, by the worker, because the agent can rewrite its own
  // remote-tracking refs. Never throws; null makes the check report error.
  const fixBaseSha =
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
  // Phase 5: bounds-check the review shape BEFORE seeding, so a rejected
  // orchestrated run seeds AND runs classic, and its `batteries:` line says
  // what actually runs. Numbers/field names only (H2).
  const reviewAgentGate = reviewAgentForRun(input.reviewAgent);
  const runReviewAgent = reviewAgentGate.reviewAgent;
  if (reviewAgentGate.rejected) {
    step(
      `review agent: bounds-rejected (${reviewAgentGate.rejected}) → classic`,
    );
  }
  // Phase 7: task-run packs, shape-gated BEFORE seeding (reason only, H2).
  // The review lane never takes task packs, whatever the input carries.
  const lane = resolveRunLane(input);
  const taskGate = taskAgentForRun(input.taskAgent, lane);
  if (taskGate.kind === "rejected") {
    step(
      taskGate.reason === "review-lane"
        ? "task agent: ignored (review-lane)"
        : `task agent: rejected (${taskGate.reason})`,
    );
  }
  const batterySeed = batterySeedForRun(runReviewAgent, taskGate);
  const foregroundOnly = foregroundOnlyForRun(lane, batterySeed);

  let boxLock: BoxLock | null = null;
  let materialised: MaterialisedCredentials;
  // Hoisted above the try so the main finally (#184 teardown uid-scan) can
  // log through the same prefix as the admission steps.
  const admissionLog = (m: string) =>
    ctx.log(`[agent-run ${input.threadId}] ${m}`);
  // Every cleanupWorkdir below: agent-uid mode hands the agent's files back
  // before the rm, and a workdir that still survives is logged, not swallowed.
  const workdirCleanup = { agentUser: config.agentUser, log: admissionLog };
  try {
    // #183 (#152 Stage B1): the box's ONE agent-run lock (box-lock.ts) — a
    // kernel flock(2) held by a helper child, so the kernel drops it the
    // instant the holder dies (no staleness threshold, no liveness beat). The
    // engine's "global" key is per workflow, so the budget is enforced here.
    // Taken AFTER the clone (network/disk, not memory) and BEFORE any
    // credential touches disk, so a long wait never widens the on-disk
    // credential window; a cancel while waiting throws into this catch and
    // the clone is cleaned up. Released in the finally below, after teardown.
    // #152 Stage A admission reap, BEFORE the lock: (a) a dead sibling
    // worker's orphans die now, not at the next boot; (b) any prior attempt
    // of THIS run (engine redelivery after a worker death) is SIGKILLed by
    // its recorded process-group pid — the zombie can never share the box
    // with its own redelivery. Both are best-effort and never throw; the
    // safety argument for the no-engine-read own-thread kill lives on
    // reapOwnThreadAttempts.
    // Re-assert the cross-uid namespace grant BEFORE anything writes into the
    // dir or binds a socket in it. The boot-time claim is not enough: the
    // default root lives under /tmp, macOS reaps /tmp entries untouched for
    // three days, and a bare recreated dir kills the run at the daemon's
    // pidfile write with "Permission denied" — which reaches the user as
    // "Review intent could not be parsed". Idempotent; see run-namespace.ts.
    await ensureRunNamespace({
      root: config.runNamespaceRoot,
      workerId: getProcessWorkerId(),
      agentUser: config.agentUser,
    });
    reclaimDeadWorkerRuns({
      root: config.runNamespaceRoot,
      selfWorkerId: getProcessWorkerId(),
      agentUser: config.agentUser,
      log: admissionLog,
    });
    reapOwnThreadAttempts({
      root: config.runNamespaceRoot,
      threadId: input.threadId,
      agentUser: config.agentUser,
      log: admissionLog,
    });
    boxLock = await acquireBoxLock({
      root: config.runNamespaceRoot,
      holder: input.threadId,
      signal,
      log: admissionLog,
    });
    step("box lock acquired");
    // #184 (#152 Stage B2): uid-wide scan UNDER the lock, BEFORE any
    // credential touches disk and BEFORE this run spawns its daemon. ADR-007
    // I2/I4: with the lock held no agent-uid process belongs to a live run, so
    // everything the scan finds is an escapee (a detached `bash -lc | claude`
    // subtree a worker-driven teardown could not reach by pgid) and is killed
    // as one set. Never throws; on a disabled agent uid it is a no-op.
    await reapAgentUidEscapees({
      agentUser: config.agentUser,
      phase: "admission",
      threadId: input.threadId,
      runNamespaceRoot: config.runNamespaceRoot,
      log: admissionLog,
    });
    const pulled =
      config.boxTrust === "owner"
        ? await pullAgentCredentials(wwwOpts, signal)
        : { agent: "", credentials: { type: "built-in-credits" as const } };
    // EVERY run gets a fresh per-run HOME, credential or not, and that HOME is
    // seeded as a trusted workspace (realpath'd — macOS tmpdir is a symlink).
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
      agentUser: config.agentUser,
      seed: batterySeed,
      foregroundOnly,
      batteries: { log: admissionLog },
    });
  } catch (err) {
    await boxLock?.release();
    await cleanupWorkdir(run.runDir, workdirCleanup);
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
  // Phase 5/7: exactly one `batteries:` line per run. A task/pr-lane run that
  // carried packs names its lane: seeded, or why not. Every other run —
  // reviews and runs without taskAgent — keeps today's exact line
  // (`mode=classic` / `mode=orchestrated …`), so unconfigured repos are
  // byte-identical in HOME and in the log. The same call decides the
  // read-only task token (brokered is config-decided: a broker start failure
  // below throws, so the run never reaches the daemon without its brokers);
  // its line is logged after the brokers come up, as before.
  const taskOutcome = taskRunOutcome({
    lane,
    taskGate,
    seeded: materialised.batteries,
    input,
    brokered: config.credentialBroker === "on",
    now: Date.now(),
  });
  step(taskOutcome.batteriesLine);
  // Every non-review run: materialise either wrote the foreground-only guard
  // into the HOME settings or threw, so reaching here means it is installed.
  // Reviews log nothing new.
  if (foregroundOnly) {
    step("task agent: foreground-only hook installed");
  }

  // #66 slice 2: per-run egress enforcement, iff the control plane resolved a
  // policy onto this run's input. Absent policy ⇒ nothing starts and nothing
  // is injected — zero behavior change. The proxy must be up BEFORE the
  // daemon env is first built (preflightGhAuth builds it), because the env is
  // memoised. A proxy-start failure must not strand the clone: this sits
  // outside the try/finally that owns cleanup, so it cleans up itself.
  let egressProxy: EgressProxy | null = null;
  let egressEvents: ReturnType<typeof createEgressEventBatcher> | null = null;
  // #108: agent-uid runs ALWAYS get a proxy. Under the PF anchor the agent has
  // no direct route to 80/443, so without one the agent CLI's own provider call
  // dies; but a repo with no policy must not silently acquire a deny-all fence
  // either. Hence observe: allow everything, audit everything, and mark every
  // row so nothing downstream can read it as enforcement. Absent BOTH a policy
  // and an agent user, nothing starts and nothing is injected — zero change.
  const egressMode: "enforce" | "observe" = input.egressPolicy
    ? "enforce"
    : "observe";
  if (input.egressPolicy || config.agentUser) {
    try {
      const batcher = createEgressEventBatcher(wwwOpts);
      egressEvents = batcher;
      egressProxy = await startEgressProxy({
        policy: input.egressPolicy ?? { level: "none", allowlist: [] },
        mode: egressMode,
        onEvent: (e) => batcher.add(e),
      });
      // A2, BLOCKING: a proxy that does not answer turns the run into a silent
      // 90s hang with no output that the agent cannot report. Prove the
      // listener before anything is pointed at it.
      await assertEgressProxyReachable({ url: egressProxy.url });
    } catch (err) {
      await closeQuietly(egressProxy);
      await closeQuietly(egressEvents);
      await materialised.cleanup();
      await boxLock?.release();
      await cleanupWorkdir(run.runDir, workdirCleanup);
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
  // THIS process's heap; the agent child gets only a per-run bearer, in EVERY
  // lane. permissionMode arrives only with the pulled message — AFTER the env
  // is first built (preflightGhAuth memoises it) — so brokering is not
  // lane-gated: review keeps its daemon-side strip on top, which now removes
  // the bearer + broker git config too (strictly less than today). Both
  // brokers must be up BEFORE the env is built. Same self-cleanup rule as the
  // egress block above — and fail-closed: a broker start failure throws
  // rather than falling back to a raw-token env.
  let gitBroker: GitBroker | null = null;
  let ghBroker: GhBroker | null = null;
  let broker: BrokerHandoff | null = null;
  if (config.credentialBroker === "on") {
    try {
      // Minted once per run, shared by both brokers; never logged.
      const runBearer = randomBytes(32).toString("hex");
      gitBroker = await startGitBroker({
        installationToken: input.installationToken,
        repoFullName: input.repoFullName,
        runBearer,
        // Only fix runs carry the key at all; every other run is unchanged.
        ...(refFence ? { refFence } : {}),
      });
      ghBroker = await startGhBroker({
        installationToken: input.installationToken,
        runBearer,
        socketPath: runGhSocketPath(
          config.runNamespaceRoot,
          getProcessWorkerId(),
          input.threadId,
        ),
      });
      broker = {
        gitUrl: gitBroker.url,
        ghSocketPath: ghBroker.socketPath,
        bearer: runBearer,
        repoFullName: input.repoFullName,
      };
    } catch (err) {
      await closeQuietly(gitBroker);
      await closeQuietly(ghBroker);
      await closeQuietly(egressProxy);
      await closeQuietly(egressEvents);
      await materialised.cleanup();
      await boxLock?.release();
      await cleanupWorkdir(run.runDir, workdirCleanup);
      throw err;
    }
    step(
      `credential brokers up: git=127.0.0.1:${gitBroker.port}, gh=${ghBroker.socketPath}` +
        (refFence ? ` (pushes fenced to ${refFence.exactRef})` : ""),
    );
  }

  // Phase 7: the read-only task token (decided above). Logged by outcome
  // only — never the value; runs without task packs log nothing here.
  if (taskOutcome.readTokenLine !== undefined) {
    step(taskOutcome.readTokenLine);
  }
  const daemon = new DaemonProcess(
    config,
    input,
    workdir,
    materialised,
    egressProxy?.url ?? null,
    broker,
    {
      lane,
      ...(taskOutcome.githubReadToken !== undefined
        ? { githubReadToken: taskOutcome.githubReadToken }
        : {}),
    },
  );
  daemonForPoll = daemon;
  // Exactly one fix-check report per fix run: the check's, or "aborted".
  let fixReported = false;
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
      agentUser: config.agentUser,
      egressProxyUrl: egressProxy?.url ?? null,
      step,
      signal,
    });

    // Run: bring up the daemon, then pull the message it should execute.
    await daemon.start();
    step(`daemon spawned: pid=${daemon.pid ?? "unknown"}`);
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
    if (input.selfHeal?.kind === "fix" && result.outcome === "completed") {
      fixReported = true;
      await runSelfHealFixStep({
        input,
        workdir,
        agentUser: config.agentUser,
        egressProxyUrl: egressProxy?.url ?? null,
        baseSha: fixBaseSha,
        lockLost: boxLock?.lost === true,
        teardown: () => daemon.teardown(),
        reap: () =>
          reapAgentUidEscapees({
            agentUser: config.agentUser,
            phase: "teardown",
            threadId: input.threadId,
            runNamespaceRoot: config.runNamespaceRoot,
            log: admissionLog,
          }),
        gitBroker,
        ghBroker,
        runStartedAt,
        step,
        signal,
      });
    }
    return {
      threadId: input.threadId,
      threadChatId: input.threadChatId,
      outcome: result.outcome,
      finalStatus: result.finalStatus,
    };
  } finally {
    // Terminal OR cancel (incl. scheduleTimeout): SIGKILL the daemon's process
    // group so no orphan survives, then remove the workdir. Runs on normal return,
    // throw, and cancellation (pollUntilTerminal returns promptly on cancel).
    daemon.teardown();
    // #184 (#152 Stage B2): the teardown uid-scan runs right after the
    // daemon's group is SIGKILLed and BEFORE the proxy/brokers close —
    // escapees are child traffic, so they must be dead before those closes
    // and before the credential wipe below (ADR-007 I2/I4). The 250 ms settle
    // lives inside the reaper; it never throws, so it cannot mask the run's
    // real outcome. The box lock still goes last. A LOST lock (the helper
    // died mid-run, so the kernel already freed it) means another run may
    // legitimately own the box now — its live agent would be collateral of
    // a uid-wide kill, so the scan is skipped and logged instead.
    if (boxLock?.lost) {
      admissionLog(
        `box.escapees_scan_skipped ${JSON.stringify({ phase: "teardown", reason: "lock lost" })}`,
      );
    } else {
      await reapAgentUidEscapees({
        agentUser: config.agentUser,
        phase: "teardown",
        threadId: input.threadId,
        runNamespaceRoot: config.runNamespaceRoot,
        log: admissionLog,
      });
    }
    // #66: close the egress proxy after the daemon is dead (no more child
    // traffic), then flush the last audit batch. Both are best-effort — an
    // audit/proxy teardown hiccup must never mask the run's real outcome.
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
    await closeQuietly(egressEvents);
    // Wipe the delivered credential before the workdir goes, so a cleanup
    // failure on the workdir can never leave a live token behind.
    await materialised.cleanup();
    await cleanupWorkdir(run.runDir, workdirCleanup);
    // The box lock goes last (ADR-007 I2): the next run may start only once
    // this one's daemon is dead and its disk footprint is gone.
    await boxLock?.release();
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
 * BACKSTOP CAVEAT (amendment 4): this auths with `input.daemonToken`. For the
 * revoked-token failure class (S12 family) that token is ALREADY dead, so the POST
 * 401s and this cannot mark the thread failed — the www-side stalled-thread watchdog
 * (raised to 75m in cron.ts) is the ONLY backstop there.
 *
 * H2: the reason is built ONLY from Hatchet's own error summary (ctx.errors()),
 * never agent output or the prompt. Wrapped so onFailure never throws uncaught.
 */
async function onAgentRunFailure(
  input: AgentRunInput,
  ctx: { errors?: () => Record<string, string>; workflowRunId?: () => string },
): Promise<void> {
  try {
    await postRunFailed(
      {
        baseUrl: input.daemonCallbackUrl,
        daemonToken: input.daemonToken,
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
