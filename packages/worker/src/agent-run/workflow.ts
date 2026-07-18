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
 * scheduleTimeout 30m (not Hatchet's 5m default): on a customer box the schedule-
 * timeout window is the grace period for THEIR infra being down; 5m would silently
 * drop queued work during a brief outage (ADR-002 §Worker availability).
 *
 * Concurrency maxRuns 1 (GROUP_ROUND_ROBIN, constant key): the chassis daemon binds
 * a FIXED unix socket with no override, so two daemons on one box collide. Serialise
 * runs until the daemon accepts a socket-path flag (see DaemonProcess doc). Later
 * runs QUEUE rather than cancel — an in-flight agent turn must never be killed.
 */
export const agentRun = hatchet.task({
  name: "agent-run",
  scheduleTimeout: "30m",
  executionTimeout: "30m",
  concurrency: {
    expression: "'agent-run-shared-daemon-socket'",
    maxRuns: 1,
    limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
  },
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

    // Provision: clone into a per-run workdir keyed on threadId. threadId is unique
    // per thread; threadChatId is the shared legacy sentinel when
    // enableThreadChatCreation is off, so it would collide every run onto one dir.
    const workdir = await provisionWorkdir({
      repoFullName: input.repoFullName,
      branch: input.branch,
      installationToken: input.installationToken,
      workdirRoot: config.workdirRoot,
      runId: input.threadId,
    });

    const daemon = new DaemonProcess(config, input, workdir);
    try {
      // Run: bring up the daemon, then pull the message it should execute.
      await daemon.start();
      const message = await pullNextMessage(wwwOpts, signal);
      if (!message) {
        // Nothing to run (no pending user message / empty prompt).
        return {
          threadId: input.threadId,
          threadChatId: input.threadChatId,
          outcome: "nothing-to-run",
        };
      }
      // H2: `message` carries the prompt — never logged here.
      await daemon.sendMessage(message);

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
