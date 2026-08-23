import { toDBMessage } from "@/agent/msg/toDBMessage";
import { getPendingToolCallErrorMessages } from "@/lib/db-message-helpers";
import { db } from "@/lib/db";
import { ClaudeMessage } from "@terragon/daemon/shared";
import {
  DBMessage,
  DBSystemMessage,
  DBUserMessage,
  ThreadChatInsert,
  ThreadStatus,
} from "@terragon/shared";
import {
  getThreadChat,
  getThreadMinimal,
} from "@terragon/shared/model/threads";
import { waitUntil } from "@/lib/wait-until";
import { setActiveThreadChat } from "@/agent/sandbox-resource";
import { extendSandboxLife } from "@terragon/sandbox";
import { getGitHubTokenForBackground } from "@/lib/github";
import { resolveBrokerRefreshForConnect } from "@/server-lib/credential-broker/resolve-credential-broker";
import { checkpointThread } from "@/server-lib/checkpoint-thread";
import { isAnthropicDownPOST } from "@/server-lib/internal-request";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { getPostHogServer } from "@/lib/posthog-server";
import { maybeProcessFollowUpQueue } from "@/server-lib/process-follow-up-queue";
import {
  parseClaudeOverloadedMessage,
  parseClaudePromptTooLongMessage,
  parseClaudeRateLimitMessage,
  parseClaudeRateLimitMessageStr,
  parseCodexErrorMessage,
  parseCodexRateLimitMessage,
  parseClaudeOAuthTokenRevokedMessage,
} from "@/agent/msg/helpers";
import { maybeStartQueuedThreadChat } from "./process-queued-thread";
import { handleReviewEffectAtFinish } from "./review/review-single-writer-finish";
import { trackUsageEvents } from "./usage-events";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { compactThreadChat } from "./compact";

export async function handleDaemonEvent({
  messages,
  threadId,
  threadChatId,
  userId,
  timezone,
  contextUsage,
  traceparent,
}: {
  messages: ClaudeMessage[];
  threadId: string;
  threadChatId: string;
  userId: string;
  timezone: string;
  contextUsage: number | null;
  /**
   * W3C `traceparent` from the inbound daemon-event request (#7 trace join). The
   * remote worker forwards the run's traceparent header so this handler — and the
   * GitHub review post it triggers — log inside the dispatch-minted trace. Optional:
   * absent for in-sandbox daemons and pre-#7 runs.
   */
  traceparent?: string;
}) {
  console.log(
    "Daemon event",
    "threadId",
    threadId,
    "threadChatId",
    threadChatId,
    "timezone",
    timezone,
    "traceparent",
    traceparent ?? "(none)",
    "messages",
    JSON.stringify(messages, null, 2),
  );
  const [threadChat, thread] = await Promise.all([
    getThreadChat({
      db,
      userId,
      threadId,
      threadChatId,
    }),
    getThreadMinimal({ db, threadId, userId }),
  ]);
  if (!threadChat || !thread) {
    return { success: false, error: "Thread chat not found", status: 404 };
  }
  console.log("Thread chat status: ", threadChat.status);

  let isStop = false;
  let isDone = false;
  let isError = false;
  let sessionId: string | null = null;
  let durationMs = 0;
  let costUsd = 0;
  let isRateLimited = false;
  let isOverloaded = false;
  let rateLimitResetTime: number | undefined;
  let isPromptTooLong = false;
  let customErrorMessage: string | null = null;
  let isOAuthTokenRevoked = false;
  for (const message of messages) {
    if (message.type === "custom-stop") {
      isStop = true;
      durationMs = message.duration_ms ?? 0;
    }
    if (message.type === "custom-error") {
      isError = true;
      customErrorMessage = message.error_info ?? null;
      durationMs = message.duration_ms ?? 0;
    }
    if (message.type === "result") {
      isDone = true;
      durationMs = message.duration_ms ?? 0;
      costUsd = "total_cost_usd" in message ? message.total_cost_usd : 0;
      if (message.is_error) {
        isError = true;
        customErrorMessage = "error" in message ? message.error : null;
      }
      if (threadChat.agent === "claudeCode") {
        const rateLimitResult = parseClaudeRateLimitMessage({
          message,
          timezone,
        });
        if (rateLimitResult) {
          isRateLimited = rateLimitResult.isRateLimited;
          rateLimitResetTime = rateLimitResult.rateLimitResetTime ?? undefined;
        }
        const overloadedResult = parseClaudeOverloadedMessage(message);
        if (overloadedResult) {
          isOverloaded = true;
        }

        const promptTooLongResult = parseClaudePromptTooLongMessage(message);
        if (promptTooLongResult) {
          isPromptTooLong = true;
          isError = true;
        }

        const oauthTokenRevokedResult =
          parseClaudeOAuthTokenRevokedMessage(message);
        if (oauthTokenRevokedResult) {
          isOAuthTokenRevoked = true;
          isError = true;
        }
      }
      if (threadChat.agent === "codex") {
        // Check for Codex rate limits
        const codexRateLimitResult = parseCodexRateLimitMessage(message);
        if (codexRateLimitResult) {
          isRateLimited = codexRateLimitResult.isRateLimited;
          rateLimitResetTime =
            codexRateLimitResult.rateLimitResetTime ?? undefined;
        }
        const maybeCodexErrorMessage = parseCodexErrorMessage(message);
        if (maybeCodexErrorMessage) {
          isError = true;
          customErrorMessage = maybeCodexErrorMessage;
        }
      }
    }
    if (message.type === "assistant") {
      if (threadChat.agent === "claudeCode") {
        const content = message.message.content;
        if (typeof content === "string") {
          const rateLimitResult = parseClaudeRateLimitMessageStr({
            result: content,
            timezone,
          });
          if (rateLimitResult?.timezoneIsAmbiguous) {
            message.message.content += ` (${timezone})`;
          }
        } else if (content.length === 1) {
          const messageStr =
            (content[0]!.type === "text" && content[0]!.text) || "";
          const rateLimitResult = parseClaudeRateLimitMessageStr({
            result: messageStr,
            timezone,
          });
          if (rateLimitResult?.timezoneIsAmbiguous) {
            message.message.content = [
              { type: "text", text: `${messageStr} (${timezone})` },
            ];
          }
        }
      }
    }

    if (!sessionId) {
      // For the sessionId, only look at assistant and user messages.
      // since these are the messages that actually get persisted by claude
      // into the <session_id>.jsonl files. Other messages like "system" or "result"
      // don't get persisted and don't guarantee a valid session_id. (eg. claude
      // sends a system init message with a session_id, but gets killed before it
      // can respond to the user message, so the session_id is never persisted)
      if (message.type === "assistant" || message.type === "user") {
        if (message.session_id) {
          sessionId = message.session_id;
        }
      }
    }
  }
  waitUntil(
    trackUsageEvents({
      userId,
      organizationId: thread?.organizationId ?? null,
      costUsd,
      agentDurationMs: durationMs,
    }),
  );
  const isThreadFinished = isStop || isDone || isError;
  const statusBeforeUpdate = threadChat.status;
  if (isThreadFinished) {
    getPostHogServer().capture({
      distinctId: userId,
      event: "daemon_event",
      properties: {
        threadId,
        statusBeforeUpdate,
        isStop,
        isDone,
        isError,
        durationMs,
        costUsd,
        isRateLimited,
        rateLimitResetTime,
        isPromptTooLong,
      },
    });
  }
  // Extend the life of the sandbox. Remote-plane threads (ADR-003) never have
  // a control-plane sandbox to extend.
  if (thread.codesandboxId && thread.sandboxProvider) {
    // #114 §7a: on a brokered E2B thread the keepalive connect auto-resumes the
    // guest, so thread a LAZY, throttled vault-secret refresh through it — the
    // provider mints a fresh installation token only when the vaulted one is
    // near expiry. undefined for Docker / non-brokered (today's behavior).
    waitUntil(
      extendSandboxLife({
        sandboxId: thread.codesandboxId,
        sandboxProvider: thread.sandboxProvider,
        refresh: resolveBrokerRefreshForConnect({
          sandboxProvider: thread.sandboxProvider,
          persistedBrokerMode: thread.credentialBrokerMode ?? undefined,
          mintToken: () =>
            getGitHubTokenForBackground({
              userId,
              repoFullName: thread.githubRepoFullName,
            }),
          // Stable id for the Daytona org-Secret name (#114); ignored by E2B.
          threadId,
        }),
      }),
    );
  }
  if (isOverloaded) {
    waitUntil(isAnthropicDownPOST());
  }
  const dbMessages: DBMessage[] = [];
  const mcpToolCalls: { serverName: string; toolName: string }[] = [];

  for (const message of messages) {
    const dbMessage = toDBMessage(message);
    dbMessages.push(...dbMessage);

    // Track MCP tool calls
    for (const dbMsg of dbMessage) {
      if (dbMsg.type === "tool-call" && dbMsg.name.startsWith("mcp__")) {
        // Parse MCP tool name format: mcp__<server>__<tool>
        const parts = dbMsg.name.split("__");
        if (parts.length >= 3) {
          const serverName = parts[1]!;
          const toolName = parts.slice(2).join("__"); // Handle tool names with "__" in them
          mcpToolCalls.push({ serverName, toolName });
        }
      }
    }
  }

  // Track MCP tool calls
  if (mcpToolCalls.length > 0) {
    for (const toolCall of mcpToolCalls) {
      getPostHogServer().capture({
        distinctId: userId,
        event: "mcp_tool_call",
        properties: {
          threadId,
          mcpServerName: toolCall.serverName,
          mcpToolName: toolCall.toolName,
        },
      });
    }
  }

  // If it's a stop or error message, we need to append messages that update pending
  // tool calls to the error state.
  const messagesToAppend =
    isStop || isError
      ? getPendingToolCallErrorMessages({
          messages: [...(threadChat.messages ?? []), ...dbMessages],
          interruptionReason: isError ? "error" : "user",
        })
      : [];

  const threadChatUpdates: ThreadChatInsert = {
    appendMessages: [...dbMessages, ...messagesToAppend],
    sessionId: sessionId ?? threadChat.sessionId ?? null,
    errorMessage: null,
    errorMessageInfo: null,
    contextLength: contextUsage ?? undefined,
  };
  if (isError) {
    if (isPromptTooLong) {
      threadChatUpdates.errorMessage = "prompt-too-long";
      threadChatUpdates.errorMessageInfo = null;
    } else if (customErrorMessage) {
      threadChatUpdates.errorMessage = "agent-generic-error";
      threadChatUpdates.errorMessageInfo = customErrorMessage;
    } else {
      threadChatUpdates.errorMessage = "agent-generic-error";
      // TODO: We could have the daemon send this.
      threadChatUpdates.errorMessageInfo = "";
    }
    getPostHogServer().capture({
      distinctId: userId,
      event: "thread_error",
      properties: {
        threadId,
        errorType: threadChatUpdates.errorMessage,
      },
    });
  }

  // Check if we should auto-compact when we get a prompt-too-long error
  if (isPromptTooLong) {
    const shouldAutoCompact = await getFeatureFlagForUser({
      db,
      userId,
      flagName: "autoCompactOnContextError",
    });

    if (shouldAutoCompact) {
      console.log("Auto-compacting due to prompt-too-long error", {
        threadId,
        threadChatId: threadChat.id,
      });
      getPostHogServer().capture({
        distinctId: userId,
        event: "auto_compact_on_context_error",
        properties: {
          threadId,
          threadChatId: threadChat.id,
          errorType: "prompt-too-long",
        },
      });

      // Attempt to compact the thread
      const compactResult = await compactThreadChat({
        userId,
        threadId,
        threadChatId: threadChat.id,
      });

      if (compactResult && compactResult.summary) {
        console.log(`Successfully compacted after prompt-too-long error`, {
          threadId,
          threadChatId: threadChat.id,
        });
        // Add a system message about the auto-compact
        const compactMessage: DBMessage = {
          type: "system",
          message_type: "compact-result",
          parts: [
            {
              type: "text",
              text: `Thread was automatically compacted due to context length limit. Summary:\n\n${compactResult.summary}`,
            },
          ],
          timestamp: new Date().toISOString(),
        };

        // Create a "Continue" message to restart the agent
        const continueMessage: DBUserMessage = {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "Continue" }],
          timestamp: new Date().toISOString(),
        };

        // Ensure appendMessages is an array before pushing
        if (!threadChatUpdates.appendMessages) {
          threadChatUpdates.appendMessages = [];
        }
        // Only append the compact message to the thread history
        threadChatUpdates.appendMessages.push(compactMessage);

        // Queue the Continue message to be processed after the thread update
        threadChatUpdates.appendQueuedMessages = [continueMessage];

        // Clear the error since we've handled it with compacting
        threadChatUpdates.errorMessage = null;
        threadChatUpdates.errorMessageInfo = null;
        threadChatUpdates.contextLength = null;
        threadChatUpdates.sessionId = null;

        // Mark that we've recovered from the error and the thread is done
        // This ensures the thread transitions properly and processes queued messages
        isError = false;
        isPromptTooLong = false;
        isDone = true; // Mark as done so the thread completes normally
      } else {
        console.log(`Failed to compact after prompt-too-long error`, {
          threadId,
          threadChatId: threadChat.id,
        });
      }
    }
  }

  // Handle OAuth token revoked error with automatic retry
  if (isOAuthTokenRevoked) {
    console.log(`OAuth token revoked error detected, checking for retry`, {
      threadId,
      threadChatId: threadChat.id,
    });

    // Check if the previous non-agent message is already an invalid-token-retry system message
    const allMessages = [...(threadChat.messages ?? []), ...dbMessages];
    let shouldRetry = true;
    // Look backwards through messages see if we've already retried.
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const msg = allMessages[i];
      if (msg?.type === "user") {
        const msgBefore = allMessages[i - 1];
        const isRetryAndContinue =
          msg.parts.length === 1 &&
          msg.parts[0]?.type === "text" &&
          msg.parts[0]?.text.toLowerCase().includes("continue") &&
          msgBefore?.type === "system" &&
          msgBefore?.message_type === "invalid-token-retry";
        if (isRetryAndContinue) {
          shouldRetry = false;
          console.log(
            "Skipping retry because previous message is already an invalid-token-retry",
            {
              threadId,
              threadChatId: threadChat.id,
            },
          );
          break;
        }
        break;
      }
    }
    if (shouldRetry) {
      console.log("Adding invalid-token-retry and queueing retry");
      // Add a system message about the retry
      const invalidTokenRetryMessage: DBSystemMessage = {
        type: "system",
        message_type: "invalid-token-retry",
        parts: [],
        timestamp: new Date().toISOString(),
      };

      // Ensure appendMessages is an array before pushing
      if (!threadChatUpdates.appendMessages) {
        threadChatUpdates.appendMessages = [];
      }
      threadChatUpdates.appendMessages.push(invalidTokenRetryMessage);

      // Create a "Continue" message to restart the agent
      const continueMessage: DBUserMessage = {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Continue" }],
        timestamp: new Date().toISOString(),
      };

      // Queue the Continue message to be processed after the thread update
      threadChatUpdates.appendQueuedMessages = [continueMessage];

      // Clear the error since we've handled it with retry
      threadChatUpdates.errorMessage = null;
      threadChatUpdates.errorMessageInfo = null;

      // Mark that we've recovered from the error and the thread is done
      isError = false;
      isOAuthTokenRevoked = false;
      isDone = true; // Mark as done so the thread completes normally

      getPostHogServer().capture({
        distinctId: userId,
        event: "oauth_token_revoked_retry",
        properties: {
          threadId,
        },
      });
    }
  }

  // Check if we should skip checkpoint when done
  let shouldSkipCheckpoint = false;
  if (isDone && !isError) {
    // Source of truth is the thread setting. Threads without a control-plane
    // sandbox (ADR-003 remote plane — the worker commits and pushes in its own
    // workdir) can never checkpoint here; running it would only stamp a false
    // "sandbox-not-found" error on a completed thread. The isError path still
    // schedules checkpointThread — that relies on checkpointThread's own
    // remote-plane early-complete branch; keep the two in sync.
    shouldSkipCheckpoint =
      isStop || !!thread.disableGitCheckpointing || !thread.codesandboxId;
  }

  const { didUpdateStatus } = await updateThreadChatWithTransition({
    userId,
    threadId,
    threadChatId: threadChat.id,
    markAsUnread: isDone || isError,
    updates: { bootingSubstatus: null },
    chatUpdates: threadChatUpdates,
    eventType: isStop
      ? "assistant.message_stop"
      : isRateLimited && rateLimitResetTime
        ? "system.agent-rate-limit"
        : isError
          ? "assistant.message_error"
          : isDone && shouldSkipCheckpoint
            ? "assistant.message_done_skip_checkpoint"
            : isDone
              ? "assistant.message_done"
              : "assistant.message",
    rateLimitResetTime,
  });
  if (isThreadFinished && didUpdateStatus) {
    // TODO this should block queueing up new threads.
    waitUntil(
      handleThreadFinish({
        userId,
        threadId,
        threadChatId: threadChat.id,
        sandboxId: thread.codesandboxId,
        statusBeforeUpdate: threadChat.status,
        isRateLimited,
        shouldSkipCheckpoint,
        repoFullName: thread.githubRepoFullName ?? null,
        prNumber: thread.githubPRNumber ?? null,
      }),
    );
  }
  return { success: true };
}

async function handleThreadFinish({
  userId,
  threadId,
  threadChatId,
  sandboxId,
  statusBeforeUpdate,
  isRateLimited,
  shouldSkipCheckpoint,
  repoFullName,
  prNumber,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  sandboxId: string | null;
  statusBeforeUpdate: ThreadStatus;
  isRateLimited: boolean;
  shouldSkipCheckpoint: boolean;
  repoFullName: string | null;
  prNumber: number | null;
}) {
  // ADR-036: dispatch the review effect for a terminal PR thread. For a review
  // thread the control-plane executor posts exactly once from the agent's emitted
  // intent (the agent has no gh-write outlet) — unconditional single-writer; the
  // post-run reconciler still runs as the straddle-backstop, converging GitHub to
  // the no-dup invariant. Both fail-soft (waitUntil + catch) — a review-effect
  // failure must never fail the thread.
  if (prNumber !== null && repoFullName) {
    waitUntil(
      handleReviewEffectAtFinish({
        db,
        userId,
        threadId,
        threadChatId,
        repoFullName,
        prNumber,
      }).catch((error) =>
        console.error("[review-effect] finish-hook failed (non-fatal)", {
          repoFullName,
          prNumber,
          error,
        }),
      ),
    );
  }

  // ADR-003 F3 (S12 fix — DECOUPLED): the daemon token is NO LONGER revoked here.
  // Revoking at thread-finish let the background revoke beat the worker's next
  // thread-status poll, so the worker only ever saw a 401 and laundered it into a
  // silent COMPLETED (S12: burst siblings killed mid-work). Revocation now happens
  // on the worker's terminal-READ (GET-style /api/daemon/thread-status returning
  // terminal=true), which guarantees the worker observes terminal=true once before
  // the token dies. Dead-worker backstop: the 1-day token expiry (plugin minimum).
  let shouldProcessFollowUpQueue = !isRateLimited;
  if (shouldProcessFollowUpQueue) {
    const threadChat = await getThreadChat({
      db,
      threadId,
      threadChatId,
      userId,
    });
    if (!threadChat) {
      throw new Error("Thread chat not found");
    }
    shouldProcessFollowUpQueue = !!(
      threadChat.queuedMessages && threadChat.queuedMessages.length > 0
    );
  }
  if (shouldProcessFollowUpQueue) {
    waitUntil(maybeProcessFollowUpQueue({ threadId, threadChatId, userId }));
  } else {
    // If the thread was booting and was rate limited, skip checkpoint too since we've done nothing.
    const skipCheckpointForRateLimit =
      statusBeforeUpdate === "booting" && isRateLimited;
    const skipCheckpoint = shouldSkipCheckpoint || skipCheckpointForRateLimit;
    if (!skipCheckpoint) {
      waitUntil(checkpointThread({ threadId, threadChatId, userId }));
    }
    if (sandboxId) {
      waitUntil(
        setActiveThreadChat({ sandboxId, threadChatId, isActive: false }),
      );
    }
    // Promote the next eligible queued task IN-PROCESS (S12 fix): the old
    // internalPOST("process-thread-queue/…") fetched this worker's OWN public URL,
    // which 404s on Workers (same-account worker-to-worker limitation, same class as
    // the broadcast self-fetch). So a freed slot never drained the concurrency queue.
    // Call the processor directly. maybeStartQueuedThreadChat re-checks eligibility.
    waitUntil(
      maybeStartQueuedThreadChat({ userId }).catch((error) =>
        console.error("[queue] finish-hook promotion failed", {
          userId,
          error,
        }),
      ),
    );
  }
}
