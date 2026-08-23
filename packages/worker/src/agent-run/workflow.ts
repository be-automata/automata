import { randomBytes } from "node:crypto";
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
  postEgressEvents,
  postRunFailed,
  pullAgentCredentials,
  pullNextMessage,
  type EgressEventWire,
  type WwwClientOpts,
} from "./www-client";
import {
  startEgressProxy,
  type EgressDecisionEvent,
  type EgressProxy,
} from "./egress-proxy";
import { startGitBroker, type GitBroker } from "./git-broker";
import { startGhBroker, type GhBroker } from "./gh-broker";
import type { BrokerHandoff } from "./daemon-env";
import { getProcessWorkerId, runGhSocketPath } from "./run-namespace";
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

export const agentRunWorkflow = hatchet.workflow<AgentRunInput>({
  name: "agent-run",
  concurrency: [
    {
      expression: "input.orgId",
      maxRuns: PER_ORG_MAX_RUNS,
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    },
    {
      // Renamed from 'agent-run-shared-daemon-socket' (2026-08-19). Two reasons:
      // (1) the cap's real justification is the single-box MEMORY budget — the
      // shared-socket collision it was named for was solved by per-run sockets
      // (Phase 0.2b); (2) the old group's scheduler state deadlocked in
      // hatchet-lite after repeated worker re-registrations (stale
      // GROUP_ROUND_ROBIN strategy rows chain into active ones and the child
      // slot is never granted — tasks sit QUEUED forever with idle workers).
      // A new group name mints fresh strategy state on registration.
      expression: "'agent-run-global-memory-budget'",
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

    // #66 slice 2: per-run egress enforcement, iff the control plane resolved a
    // policy onto this run's input. Absent policy ⇒ nothing starts and nothing
    // is injected — zero behavior change. The proxy must be up BEFORE the
    // daemon env is first built (preflightGhAuth builds it), because the env is
    // memoised. A proxy-start failure must not strand the clone: this sits
    // outside the try/finally that owns cleanup, so it cleans up itself.
    let egressProxy: EgressProxy | null = null;
    let egressEvents: ReturnType<typeof createEgressEventBatcher> | null = null;
    if (input.egressPolicy) {
      try {
        const batcher = createEgressEventBatcher(wwwOpts);
        egressEvents = batcher;
        egressProxy = await startEgressProxy({
          policy: input.egressPolicy,
          onEvent: (e) => batcher.add(e),
        });
      } catch (err) {
        await closeQuietly(egressEvents);
        await materialised.cleanup();
        await cleanupWorkdir(workdir);
        throw err;
      }
      step(
        `egress proxy up: 127.0.0.1:${egressProxy.port} ` +
          `(level=${input.egressPolicy.level}, ${input.egressPolicy.allowlist.length} allowlist entries)`,
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
        await cleanupWorkdir(workdir);
        throw err;
      }
      step(
        `credential brokers up: git=127.0.0.1:${gitBroker.port}, gh=${ghBroker.socketPath}`,
      );
    }

    const daemon = new DaemonProcess(
      config,
      input,
      workdir,
      materialised,
      egressProxy?.url ?? null,
      broker,
    );
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
      // #66: close the egress proxy after the daemon is dead (no more child
      // traffic), then flush the last audit batch. Both are best-effort — an
      // audit/proxy teardown hiccup must never mask the run's real outcome.
      await closeQuietly(egressProxy);
      // #81: close both credential brokers after the daemon is dead (no more
      // child git/gh traffic). Best-effort, like the egress proxy — the token
      // dies with this process either way.
      await closeQuietly(gitBroker);
      await closeQuietly(ghBroker);
      await closeQuietly(egressEvents);
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
