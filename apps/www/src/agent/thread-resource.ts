import { ThreadErrorType, ThreadChat } from "@terragon/shared";
import {
  getThreadChat,
  getThreadMinimal,
  type ThreadMinimal,
} from "@terragon/shared/model/threads";
import { ThreadError } from "./error";
import { getSandboxForThreadOrNull, maybeHibernateSandbox } from "./sandbox";
import { ISandboxSession } from "@terragon/sandbox/types";
import { withSandboxResource } from "./sandbox-resource";
import { updateThreadChatWithTransition } from "./update-status";
import { db } from "@/lib/db";
import { getPostHogServer } from "@/lib/posthog-server";
import { waitUntil } from "@/lib/wait-until";
import { extendSandboxLife } from "@terragon/sandbox";
import { getGitHubTokenForBackground } from "@/lib/github";
import { resolveBrokerRefreshForConnect } from "@/server-lib/credential-broker/resolve-credential-broker";
import { trackUsageEvents } from "@/server-lib/usage-events";
import { onThreadChatError } from "@/server-lib/thread-status-change";

export async function withThreadChat<T>({
  userId,
  threadId,
  threadChatId,
  execOrThrow,
  onExit,
  onError,
}: {
  threadId: string;
  threadChatId: string | null;
  userId: string;
  execOrThrow: (threadChat: ThreadChat | null) => Promise<T>;
  onExit?: (threadChat: ThreadChat | null) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}): Promise<T | undefined> {
  const threadChat = threadChatId
    ? await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId,
      })
    : null;
  if (threadChatId && !threadChat) {
    throw new ThreadError("unknown-error", "Thread chat not found", null);
  }
  let result: T | undefined;
  try {
    result = await execOrThrow(threadChat ?? null);
  } catch (error) {
    let errorType: ThreadErrorType;
    let errorInfo: string;
    if (error instanceof ThreadError) {
      errorType = error.type;
      errorInfo = error.info;
    } else {
      errorType = "unknown-error";
      errorInfo = error instanceof Error ? error.message : "Unknown error";
    }
    console.error("Thread error", error);
    getPostHogServer().capture({
      distinctId: userId,
      event: "thread_error",
      properties: {
        threadId,
        threadChatId,
        errorType,
        errorInfo,
      },
    });
    if (threadChatId) {
      await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId,
        eventType: "system.error",
        chatUpdates: {
          errorMessage: errorType,
          errorMessageInfo: errorInfo,
          appendMessages: [
            {
              type: "error",
              error_type: errorType,
              error_info: errorInfo,
              timestamp: new Date().toISOString(),
            },
          ],
        },
        markAsUnread: true,
      });
      await onThreadChatError({ userId, threadId, threadChatId });
      await onError?.(error instanceof Error ? error : new Error(errorInfo));
    }
  } finally {
    try {
      await onExit?.(threadChat ?? null);
    } catch (error) {
      console.error("Error in onExit:", error);
    }
  }
  return result;
}

export async function withThreadSandboxSession<T>({
  threadId,
  threadChatId,
  userId,
  label,
  onBeforeExec,
  execOrThrow,
  onExit,
  onError,
  fastResume = true,
}: {
  threadId: string;
  threadChatId: string | null;
  userId: string;
  label: string;
  onBeforeExec?: ({
    threadChat,
  }: {
    threadChat: ThreadChat | null;
  }) => Promise<boolean>;
  execOrThrow: ({
    threadChat,
    session,
    thread,
  }: {
    threadChat: ThreadChat | null;
    session: ISandboxSession | null;
    // The thread as loaded for sandbox resolution. Lets callers tell "no
    // sandbox by design" (ADR-003 remote plane: codesandboxId null) apart
    // from a failed sandbox lookup — both arrive as session: null.
    thread: ThreadMinimal | null;
  }) => Promise<T>;
  onExit?: ({
    threadChat,
  }: {
    threadChat: ThreadChat | null;
  }) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
  fastResume?: boolean;
}): Promise<T | undefined> {
  let sandboxSessionOrNull: ISandboxSession | null = null;
  let sandboxUsageStartTime: number | null = null;
  // Captured when the thread loads (exec callback) and reused in onExit to stamp
  // usage events with the thread's org (WI-5 batch 3a).
  let threadOrganizationId: string | null = null;
  return withThreadChat({
    threadId,
    userId,
    threadChatId,
    execOrThrow: async (threadChat) => {
      if (typeof onBeforeExec === "function") {
        const shouldContinue = await onBeforeExec({ threadChat });
        if (!shouldContinue) {
          return undefined;
        }
      }

      const thread = await getThreadMinimal({ db, threadId, userId });
      threadOrganizationId = thread?.organizationId ?? null;
      if (!thread?.codesandboxId) {
        return await execOrThrow({ threadChat, session: null, thread });
      }
      return await withSandboxResource({
        label,
        sandboxId: thread.codesandboxId,
        callback: async () => {
          sandboxSessionOrNull = await getSandboxForThreadOrNull({
            db,
            threadId,
            threadChatIdOrNull: threadChatId ?? null,
            userId,
            fastResume,
            onStatusUpdate: async () => {}, // No-op callback as thread-resource doesn't track status
          });
          if (sandboxSessionOrNull) {
            sandboxUsageStartTime = Date.now();
            // #114 §7a: keepalive connect auto-resumes a brokered E2B guest, so
            // thread a LAZY, throttled vault-secret refresh through it. undefined
            // for Docker / non-brokered threads (today's behavior).
            await extendSandboxLife({
              sandboxProvider: sandboxSessionOrNull.sandboxProvider,
              sandboxId: sandboxSessionOrNull.sandboxId,
              refresh: resolveBrokerRefreshForConnect({
                sandboxProvider: sandboxSessionOrNull.sandboxProvider,
                persistedBrokerMode: thread.credentialBrokerMode ?? undefined,
                mintToken: () =>
                  getGitHubTokenForBackground({
                    userId,
                    repoFullName: thread.githubRepoFullName,
                  }),
              }),
            });
          }
          return await execOrThrow({
            threadChat,
            session: sandboxSessionOrNull,
            thread,
          });
        },
      });
    },
    onExit: async (threadChat) => {
      try {
        await onExit?.({ threadChat: threadChat ?? null });
      } finally {
        if (sandboxSessionOrNull) {
          try {
            // Log sandbox usage duration
            if (sandboxUsageStartTime) {
              const usageDuration = Date.now() - sandboxUsageStartTime;
              getPostHogServer().capture({
                distinctId: userId,
                event: "sandbox_usage_duration",
                properties: {
                  threadId,
                  label,
                  sandboxId: sandboxSessionOrNull.sandboxId,
                  sandboxProvider: sandboxSessionOrNull.sandboxProvider,
                  durationMs: usageDuration,
                },
              });
              waitUntil(
                trackUsageEvents({
                  userId,
                  organizationId: threadOrganizationId,
                  applicationDurationMs: usageDuration,
                }),
              );
            }
            waitUntil(
              maybeHibernateSandbox({
                threadId,
                userId,
                session: sandboxSessionOrNull,
              }),
            );
          } catch (e) {
            console.error("Failed to hibernate sandbox:", e);
          }
        }
      }
    },
    onError,
  });
}
