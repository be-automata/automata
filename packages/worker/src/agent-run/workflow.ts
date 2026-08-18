import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk";
import { hatchet } from "../hatchet-client";
import { loadWorkerConfig } from "./config";
import { DaemonProcess } from "./daemon-process";
import { cleanupWorkdir, provisionWorkdir } from "./provision";
import {
  classifyNextMessageError,
  nonRetryablePreflight,
} from "./retry-classification";
import {
  pollUntilTerminal,
  postRunFailed,
  pullAgentCredentials,
  pullNextMessage,
} from "./www-client";
import {
  materialiseAgentCredentials,
  type MaterialisedCredentials,
} from "./agent-credentials";
import type { AgentRunInput, AgentRunOutput } from "./types";

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
 * Concurrency is a STACKED array of two GROUP_ROUND_ROBIN keys (Phase 2, #3a
 * per-org fair ordering). Both cap at 1 today; the ordering, not the throughput,
 * is what changes:
 *   1. per-ORG key (`input.orgId`): GROUP_ROUND_ROBIN makes the scheduler pick the
 *      next waiting ORG fairly when the slot frees, so one org's backlog can never
 *      head-of-line-block another (the direct "one org can't starve another"
 *      answer at pilot volume). orgId is guaranteed non-empty by dispatch (the
 *      `u:${userId}` fallback) so the CEL key never dereferences null.
 *   2. global constant key: the single-box daemon memory budget — only ONE
 *      agent-run executes at a time across ALL orgs and BOTH workers.
 * Later runs QUEUE rather than cancel — an in-flight agent turn must never be killed.
 *
 * FAIRNESS IS ONLY PROVEN LIVE (plan amendment 11): this config type-checks and
 * locks the shape, but round-robin-across-orgs is scheduler-side behaviour — it is
 * "delivered" only when the 2-org interleave UAT is observed, not on merge.
 */

/**
 * Per-org concurrency cap. GROUP_ROUND_ROBIN on `input.orgId` gives fair ORDERING
 * across orgs; the cap itself is 1 and MUST stay ≤ the global cap so no single org
 * can ever hold every slot. Raising this is gated on #3b (real per-org parallelism).
 */
const PER_ORG_MAX_RUNS = 1;

/**
 * Global concurrency cap = the single-box daemon memory budget. Held at 1: N
 * concurrent agents each spawn a full `claude` process, and the orch-agents ENOMEM
 * wall (4+ SDK sessions tripped fork/posix_spawn on a 7.6GB box, safe only after an
 * 8GiB swap file) is the precedent. Raise ONLY after per-agent RSS × N + headroom is
 * validated on the pilot box (plan's "Concurrency > 1 is gated on memory"), and set
 * `slotCost` to reflect the weight at the same time. Per-run daemon isolation (the
 * `--socket-path` flag) removes the socket-collision blocker but NOT the memory one.
 */
const GLOBAL_MAX_RUNS = 1;

export const agentRunWorkflow = hatchet.workflow<AgentRunInput>({
  name: "agent-run",
  concurrency: [
    {
      expression: "input.orgId",
      maxRuns: PER_ORG_MAX_RUNS,
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    },
    {
      expression: "'agent-run-shared-daemon-socket'",
      maxRuns: GLOBAL_MAX_RUNS,
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    },
  ],
});

agentRunWorkflow.task({
  name: "run",
  scheduleTimeout: "30m",
  executionTimeout: "30m",
  // EXPLICIT retries: 0 (the SDK default is already 0). A single agent-run is a
  // minutes-long, NON-idempotent side-effecting operation (it clones, runs the
  // agent, and posts a GitHub review) — auto-retrying it would re-execute the
  // agent and risk a double side-effect. Keep this explicit so a future edit
  // can't silently enable retries. This is Phase 1.4 mechanism #1 (exactly-once):
  // at retries:0 + workflow maxRuns:1 the only at-least-once window is engine
  // redelivery, which the www single-writer (HEAD+verdict idempotency) absorbs.
  retries: 0,
  // slotCost DEFERRED (#8): meaningless at GLOBAL_MAX_RUNS=1 (one run at a time), so
  // it stays unset until #3b raises the global cap — at which point set slotCost to
  // model each agent-run's memory weight so a worker's physical slots reflect real
  // capacity. Wiring it now would have no effect. See workflow-level concurrency doc.
  fn: async (input: AgentRunInput, ctx): Promise<AgentRunOutput> => {
    const config = loadWorkerConfig();
    const wwwOpts = {
      baseUrl: input.daemonCallbackUrl,
      daemonToken: input.daemonToken,
      threadId: input.threadId,
      threadChatId: input.threadChatId,
      // #7 trace join: forwarded as a `traceparent` header on every www call so the
      // daemon-event → GitHub-post continues the dispatch-minted trace. Dispatch sets
      // it on every remote run; if ever absent the header is simply omitted (no-op).
      traceparent: input.traceparent,
    };

    // Cancellation signal (Hatchet cancel: scheduleTimeout/executionTimeout). Used
    // to abort in-flight pulls/polls so the finally-block daemon teardown runs
    // promptly — no orphan daemon survives a cancelled run.
    const signal: AbortSignal | undefined = ctx.abortController?.signal;
    const pollCtx = {
      get cancelled() {
        return ctx.cancelled;
      },
      log: (message: string) => ctx.log(message),
      signal,
    };

    // Step logging (boot-coder): each boot step is logged so a stalled re-fire
    // pinpoints exactly where the agent fails to launch. Never logs the prompt (H2)
    // — only ids, pids, counts, and thread status. #7: the run's traceparent is
    // stamped on every line (`trace=…`) so worker logs join the end-to-end trace.
    const tracePrefix = input.traceparent ? ` trace=${input.traceparent}` : "";
    const step = (msg: string) =>
      ctx.log(`[agent-run ${input.threadId}${tracePrefix}] ${msg}`);

    // Provision: clone into a per-run workdir keyed on threadId. threadId is unique
    // per thread; threadChatId is the shared legacy sentinel when
    // enableThreadChatCreation is off, so it would collide every run onto one dir.
    const workdir = await provisionWorkdir({
      repoFullName: input.repoFullName,
      branch: input.branch,
      baseBranch: input.baseBranch,
      installationToken: input.installationToken,
      workdirRoot: config.workdirRoot,
      runId: input.threadId,
    });
    step(
      `clone complete: ${input.repoFullName}@${input.branch}` +
        (input.baseBranch ? ` (base ${input.baseBranch} fetched)` : ""),
    );

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
    let materialised: MaterialisedCredentials;
    try {
      const pulled =
        config.boxTrust === "owner"
          ? await pullAgentCredentials(wwwOpts, signal)
          : { agent: "", credentials: { type: "built-in-credits" as const } };
      materialised = await materialiseAgentCredentials({
        credentials: pulled.credentials,
        agent: pulled.agent,
        runRoot: workdir,
      });
    } catch (err) {
      await cleanupWorkdir(workdir);
      throw err;
    }
    // H2: log the MODE, never the credential.
    // Name the credential the run will ACTUALLY use. The earlier version said
    // "→ credits" for every undelivered run, which is a lie under box-key and
    // would have sent the next person debugging this down the wrong path — the
    // same way it took two rollbacks to find the last one.
    step(
      `agent credential: ${
        materialised.delivered
          ? "delivered (run HOME)"
          : config.boxTrust === "box-key"
            ? "none → box ANTHROPIC_API_KEY (box trust: box-key)"
            : `none → credits proxy (box trust: ${config.boxTrust})`
      }`,
    );

    const daemon = new DaemonProcess(config, input, workdir, materialised);
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
      // The invariant that removes the silent third mode: a run either has its
      // own credential on disk, or it goes through the control-plane proxy. It
      // never falls through to whatever key the BOX happens to carry.
      //
      // www computes useCredits from "does this user have a credential", which is
      // true-but-insufficient out here: the user can have one that this box was
      // never given (shared box, or a control plane too old to serve it). The
      // worker knows which actually happened, so it has the final say.
      // "box-key": the operator declared this box's own ANTHROPIC_API_KEY to be
      // the credential, so leave the message alone — daemon-env injects that key
      // whenever nothing was delivered. Forcing credits here is what broke the
      // pilot: its platform has no credit balance, so every run 402'd at the
      // proxy and died with no output, on a box whose key worked fine.
      if (
        config.boxTrust !== "box-key" &&
        !materialised.delivered &&
        !message.useCredits
      ) {
        step("no delivered credential → forcing credits (proxy)");
        message.useCredits = true;
      }
      const bytes = await daemon.sendMessage(message);
      step(`socket write ok: ${bytes} bytes → daemon ACKed`);

      // Poll www for terminal. The daemon streams events to www, which owns the
      // thread status; the worker asks www, not the daemon. Revoke-race ruling and
      // the poll loop live in www-client (pollUntilTerminal).
      const result = await pollUntilTerminal(
        pollCtx,
        wwwOpts,
        config.pollIntervalMs,
      );
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
      // Wipe the delivered credential before the workdir goes, so a cleanup
      // failure on the workdir can never leave a live token behind.
      await materialised.cleanup();
      await cleanupWorkdir(workdir);
    }
  },
});

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
agentRunWorkflow.onFailure({
  fn: async (input: AgentRunInput, ctx): Promise<void> => {
    try {
      await postRunFailed(
        {
          baseUrl: input.daemonCallbackUrl,
          daemonToken: input.daemonToken,
          threadId: input.threadId,
          threadChatId: input.threadChatId,
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
  },
});

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
