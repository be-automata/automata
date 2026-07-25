import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk";
import { hatchet } from "../hatchet-client";
import { loadWorkerConfig } from "./config";
import { DaemonProcess } from "./daemon-process";
import { cleanupWorkdir, provisionWorkdir } from "./provision";
import { pollUntilTerminal, pullNextMessage } from "./www-client";
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
 * Concurrency maxRuns 1 (GROUP_ROUND_ROBIN, constant key): protects the box while
 * the global cap stays at 1 (per-run daemon isolation is enabled by the daemon
 * `--socket-path` flag, but raising the cap above 1 is gated on a memory-headroom
 * check — see the plan's "Concurrency > 1 is gated on memory"). Later runs QUEUE
 * rather than cancel — an in-flight agent turn must never be killed.
 */
export const agentRunWorkflow = hatchet.workflow<AgentRunInput>({
  name: "agent-run",
  concurrency: {
    expression: "'agent-run-shared-daemon-socket'",
    maxRuns: 1,
    limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
  },
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
  fn: async (input: AgentRunInput, ctx): Promise<AgentRunOutput> => {
    const config = loadWorkerConfig();
    const wwwOpts = {
      baseUrl: input.daemonCallbackUrl,
      daemonToken: input.daemonToken,
      threadId: input.threadId,
      threadChatId: input.threadChatId,
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
    // — only ids, pids, counts, and thread status.
    const step = (msg: string) =>
      ctx.log(`[agent-run ${input.threadId}] ${msg}`);

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

    const daemon = new DaemonProcess(config, input, workdir);
    try {
      // Fail-closed identity precondition (ADR-002): confirm gh authenticates as the
      // bot (installation token + isolated config) in the workdir BEFORE spawning —
      // a misconfigured box must block, never silently post as the wrong identity.
      await daemon.preflightGhAuth();
      step("gh auth precondition ok (bot identity)");

      // Run: bring up the daemon, then pull the message it should execute.
      await daemon.start();
      step(`daemon spawned: pid=${daemon.pid ?? "unknown"}`);
      const message = await pullNextMessage(wwwOpts, signal);
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
      step(`next-message: got message (agent=${message.agent}, model=${message.model})`);
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
      await cleanupWorkdir(workdir);
    }
  },
});
