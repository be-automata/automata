import {
  DBUserMessage,
  DBUserMessageWithModel,
  Thread,
} from "@terragon/shared";
import { DB } from "@terragon/shared/db";
import {
  getActiveThreadCount,
  activeThreadStatuses,
  getQueuedThreadCounts,
  updateThread,
  updateThreadChat,
  getThreadChat,
  getThread,
} from "@terragon/shared/model/threads";
import {
  createSandboxForThread,
  getSandboxForThreadOrNull,
} from "@/agent/sandbox";
import { withSandboxResource } from "@/agent/sandbox-resource";
import { sendDaemonMessage } from "@/agent/daemon";
import { ThreadError } from "@/agent/error";
import { withThreadChat } from "@/agent/thread-resource";
import { getSandboxCreationRemaining } from "@/lib/rate-limit";
import { getMaxConcurrentTaskCountForUser } from "@/lib/subscription-tiers";
import {
  getUserMessageToSend,
  convertToPrompt,
} from "@/lib/db-message-helpers";
import { uploadUserMessageImages } from "@/lib/r2-file-upload-server";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { gitPullUpstream } from "@terragon/sandbox/commands";
import { getPostHogServer } from "@/lib/posthog-server";
import { CreateSandboxOptions } from "@terragon/sandbox/types";
import { formatThreadToMsg } from "@/lib/thread-to-msg-formatter";
import { ISandboxSession } from "@terragon/sandbox/types";
import { AIAgent, AIModel } from "@terragon/agent/types";
import {
  modelToAgent,
  getDefaultModelForAgent,
  normalizedModelForDaemon,
  isConnectedCredentialsSupported,
  modelRequiresChatGptOAuth,
} from "@terragon/agent/utils";
import { handleSlashCommand } from "@/agent/slash-command-handler";
import { tryAutoCompactThread } from "@/server-lib/compact";
import { waitUntil } from "@vercel/functions";
import { maybeProcessFollowUpQueue } from "@/server-lib/process-follow-up-queue";
import { getUserCredentials } from "@/server-lib/user-credentials";
import { getAccessInfoForUser } from "@/lib/subscription";
import { SUBSCRIPTION_MESSAGES } from "@/lib/subscription-msgs";
import {
  getThreadContextMessageToGenerate,
  generateThreadContextResult,
} from "@/server-lib/thread-context";

async function checkTaskQueueLimit({ db, userId }: { db: DB; userId: string }) {
  // Task queue limiting is always enabled
  const queuedCounts = await getQueuedThreadCounts({ db, userId });
  console.log(
    `Task queue limit check - Current queued tasks: ${queuedCounts.queuedTotal}`,
  );
  if (queuedCounts.queuedTotal >= 25) {
    throw new ThreadError(
      "queue-limit-exceeded",
      "You have reached the maximum limit of 25 queued tasks. Please wait for some tasks to complete before adding more.",
      null,
    );
  }
}

export async function startAgentMessage({
  db,
  userId,
  message,
  threadId,
  threadChatId,
  isNewThread,
  createNewBranch = true,
  branchName,
  delayMs = 0,
}: {
  db: DB;
  userId: string;
  // In some cases, the message we want to send to claude is already in the DB.
  // For example, when retrying a thread, we don't want to upload the message again.
  // See also: getUserMessageToSend.
  message?: DBUserMessageWithModel | null;
  threadId: string;
  threadChatId: string;
  isNewThread: boolean;
  createNewBranch?: boolean;
  branchName?: string;
  delayMs?: number;
}) {
  console.log("Starting agent message", { threadId, threadChatId });
  const userCredentials = await getUserCredentials({ userId });
  if (message) {
    // Check for slash commands
    const slashCommandResult = await handleSlashCommand({
      userId,
      threadId,
      threadChatId,
      message,
    });
    if (slashCommandResult.handled) {
      console.log(`Slash command handled`, {
        threadId,
        threadChatId,
      });
      waitUntil(maybeProcessFollowUpQueue({ threadId, userId, threadChatId }));
      return;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await withThreadChat({
    threadId,
    threadChatId,
    userId,
    execOrThrow: async (threadChat) => {
      // Enforce subscription/access gating (defense-in-depth):
      // If the user lacks active access, surface an error and halt early.
      const { tier } = await getAccessInfoForUser(userId);
      if (tier === "none") {
        throw new Error(SUBSCRIPTION_MESSAGES.RUN_TASK);
      }
      if (!threadChat) {
        throw new ThreadError("unknown-error", "Thread chat not found", null);
      }
      // Images should be uploaded from the client already but just in case we have old clients,
      // we see if we need to upload anything here.
      const uploadedMessage = message
        ? await uploadUserMessageImages({ userId, message })
        : null;

      // Only check rate limits if the thread doesn't have any active thread chats.
      const thread = await getThread({ db, threadId, userId });
      if (
        thread!.threadChats.every(
          (chat) => !activeThreadStatuses.includes(chat.status),
        )
      ) {
        const activeThreadCount = await getActiveThreadCount({ db, userId });
        console.log(`Active thread count: ${activeThreadCount}`);
        const [sandboxCreationRateLimitRemaining, maxConcurrentTasks] =
          await Promise.all([
            getSandboxCreationRemaining(userId),
            getMaxConcurrentTaskCountForUser(userId),
          ]);
        const sandboxCreationRateLimitReached =
          sandboxCreationRateLimitRemaining.remaining === 0;
        console.log(
          `Sandbox creation rate limit remaining: ${sandboxCreationRateLimitRemaining.remaining}, reset: ${sandboxCreationRateLimitRemaining.reset}`,
        );
        if (activeThreadCount >= maxConcurrentTasks) {
          console.log(`Thread ${threadId}: Max concurrent tasks reached`);

          // Check task queue limit right before we queue the task
          await checkTaskQueueLimit({ db, userId });

          // Log queue metrics when a thread is queued due to concurrency
          const queuedThreadCounts = await getQueuedThreadCounts({
            db,
            userId,
          });
          queuedThreadCounts.queuedTotal++;
          queuedThreadCounts.queuedTasksConcurrency++;
          getPostHogServer().capture({
            distinctId: userId,
            event: "thread_queued",
            properties: {
              threadId,
              reason: "concurrency_limit",
              activeThreadCount,
              maxConcurrentTasks,
              ...queuedThreadCounts,
            },
          });
          await updateThreadChatWithTransition({
            userId,
            threadId,
            threadChatId,
            eventType: "system.concurrency-limit",
            chatUpdates: {
              errorMessage: null,
              errorMessageInfo: null,
              appendMessages: uploadedMessage ? [uploadedMessage] : undefined,
            },
          });
          return;
        }
        if (sandboxCreationRateLimitReached) {
          console.log(
            `Thread ${threadId}: Sandbox creation rate limit reached`,
          );

          // Check task queue limit right before we queue the task
          await checkTaskQueueLimit({ db, userId });

          // Log queue metrics when a thread is queued due to rate limit
          const queuedThreadCounts = await getQueuedThreadCounts({
            db,
            userId,
          });
          getPostHogServer().capture({
            distinctId: userId,
            event: "thread_queued",
            properties: {
              threadId,
              reason: "sandbox_creation_rate_limit",
              rateLimitResetMs: sandboxCreationRateLimitRemaining.reset,
              ...queuedThreadCounts,
            },
          });
          await updateThreadChatWithTransition({
            userId,
            threadId,
            threadChatId,
            eventType: "system.sandbox-creation-rate-limit",
            rateLimitResetTime: sandboxCreationRateLimitRemaining.reset,
            chatUpdates: {
              errorMessage: null,
              errorMessageInfo: null,
              appendMessages: uploadedMessage ? [uploadedMessage] : undefined,
            },
          });
          return;
        }
      }

      // If there's a thread-context message without a thread-context-result message, we need to generate it
      let threadContextPromise: Promise<void> | null = null;
      const threadContextMessage = getThreadContextMessageToGenerate({
        threadChat,
      });
      if (threadContextMessage) {
        threadContextPromise = generateThreadContextResult({
          db,
          userId,
          threadId,
          threadChatId,
          threadContextMessage,
        });
      }

      await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId,
        eventType: "system.boot",
        chatUpdates: {
          errorMessage: null,
          errorMessageInfo: null,
          appendMessages: uploadedMessage ? [uploadedMessage] : undefined,
        },
      });
      // Get or create sandbox for the thread
      const startTime = Date.now();
      // We need to provide onStatusUpdate for both new and resumed threads
      // so the UI can show sandbox setup progress (e.g., "Running terragon-setup.sh")
      const onStatusUpdate: CreateSandboxOptions["onStatusUpdate"] = async ({
        sandboxId,
        sandboxStatus,
        bootingStatus,
      }) => {
        await updateThread({
          db,
          userId,
          threadId,
          updates: {
            sandboxStatus,
            bootingSubstatus: bootingStatus,
          },
        });
      };
      await withSandboxResource({
        // If we're creating a new sandbox, just pass the threadId in as a placeholder.
        sandboxId: thread?.codesandboxId ?? threadId,
        label: "start-claude-message",
        callback: async () => {
          const session = isNewThread
            ? await createSandboxForThread({
                db,
                threadId,
                threadChatIdOrNull: threadChatId,
                userId,
                createNewBranch,
                branchName,
                onStatusUpdate,
              })
            : await getSandboxForThreadOrNull({
                db,
                threadId,
                threadChatIdOrNull: threadChatId,
                userId,
                createNewBranch,
                branchName,
                onStatusUpdate,
              });
          if (!session) {
            throw new ThreadError("sandbox-not-found", "", null);
          }
          getPostHogServer().capture({
            distinctId: userId,
            event: "sandbox_usage_duration",
            properties: {
              threadId,
              label: "start-claude-message",
              sandboxId: session.sandboxId,
              sandboxProvider: session.sandboxProvider,
              durationMs: Date.now() - startTime,
            },
          });
          // Pull latest changes from upstream before sending daemon message
          if (!isNewThread) {
            await gitPullUpstream(session);
          }
          await updateThread({
            db,
            userId,
            threadId,
            updates: {
              bootingSubstatus: "booting-done",
            },
          });
          if (threadContextPromise) {
            await threadContextPromise;
          }
          threadChat = (await getThreadChat({
            db,
            threadId,
            threadChatId,
            userId,
          }))!;
          // Check if the thread was stopped while we were waiting for the sandbox to boot.
          const updatedThreadStatus = threadChat.status;
          if (
            updatedThreadStatus === "complete" ||
            updatedThreadStatus === "stopping"
          ) {
            console.log(
              `Thread ${threadId}: Sandbox was stopped while we were waiting for it to boot`,
            );
            if (updatedThreadStatus === "stopping") {
              await updateThreadChatWithTransition({
                userId,
                threadId,
                threadChatId,
                eventType: "system.stop",
              });
            }
            return;
          }

          // Pick up any queued messages that were added while we were waiting for the sandbox to boot.
          if (
            threadChat.queuedMessages &&
            threadChat.queuedMessages.length > 0
          ) {
            await updateThreadChat({
              db,
              userId,
              threadId,
              threadChatId,
              updates: {
                appendAndResetQueuedMessages: true,
              },
            });
            threadChat = (await getThreadChat({
              db,
              threadId,
              threadChatId,
              userId,
            }))!;
          }
          const userMessageToSend = getUserMessageToSend({
            messages: threadChat.messages ?? [],
            currentMessage: message ?? null,
          });
          if (!userMessageToSend) {
            throw new ThreadError("no-user-message", "", null);
          }
          // Update permission mode if it's different from the thread's permission mode
          const newPermissionMode =
            userMessageToSend.permissionMode || "allowAll";
          const currentPermissionMode = threadChat.permissionMode || "allowAll";
          if (newPermissionMode !== currentPermissionMode) {
            await updateThreadChat({
              db,
              userId,
              threadId,
              threadChatId,
              updates: {
                permissionMode: newPermissionMode,
              },
            });
            threadChat = (await getThreadChat({
              db,
              threadId,
              threadChatId,
              userId,
            }))!;
          }
          let sessionId = threadChat.sessionId;
          const { summary, didCompact } = await tryAutoCompactThread({
            userId,
            threadId,
            threadChatId,
          });
          if (didCompact && summary) {
            userMessageToSend.parts.push({
              type: "text",
              text: `\n\n---\n\nThe user has run out of context. This is a summary of what has been done: <summary>\n${summary}\n</summary>\n\n`,
            });
            sessionId = null;
          }
          // Prepare prompt based on model
          const model =
            userMessageToSend.model ??
            getDefaultModelForAgent({
              agent: threadChat.agent,
              agentVersion: threadChat.agentVersion,
            });

          // Check if the model requires ChatGPT OAuth and user doesn't have it
          if (
            modelRequiresChatGptOAuth(model) &&
            !userCredentials.hasOpenAIOAuthCredentials
          ) {
            throw new ThreadError(
              "chatgpt-sub-required",
              "This model requires a connected ChatGPT subscription.",
              null,
            );
          }

          const agentForModel = modelToAgent(model);
          const { prompt: finalPrompt } = await preparePromptForModel({
            model,
            agent: threadChat.agent,
            agentVersion: threadChat.agentVersion,
            userMessageToSend,
            threadMessages: threadChat.messages ?? [],
            session,
          });

          const finalFinalPrompt = finalPrompt.replace(
            /(?:^|\s)\/compact(?=\s|$)/g,
            "",
          );

          if (!finalFinalPrompt.trim()) {
            throw new ThreadError("no-user-message", "", null);
          }

          const shouldUseCredits =
            (agentForModel === "codex" && !userCredentials.hasOpenAI) ||
            (agentForModel === "claudeCode" && !userCredentials.hasClaude) ||
            !isConnectedCredentialsSupported(agentForModel);

          await sendDaemonMessage({
            message: {
              type: "claude",
              model: normalizedModelForDaemon(model),
              agent: threadChat.agent,
              agentVersion: threadChat.agentVersion,
              prompt: finalFinalPrompt,
              sessionId,
              permissionMode: threadChat.permissionMode || "allowAll",
              ...(shouldUseCredits ? { useCredits: true } : {}),
            },
            userId,
            threadId,
            threadChatId,
            sandboxId: session.sandboxId,
            session,
          });
        },
      });
    },
    onError: (error) => {
      console.error("Error starting claude:", error);
    },
  });
}

async function preparePromptForModel({
  model,
  agent,
  agentVersion,
  userMessageToSend,
  threadMessages,
  session,
}: {
  model: AIModel;
  agent: AIAgent;
  agentVersion: number;
  userMessageToSend: DBUserMessage;
  threadMessages: Thread["messages"];
  session: ISandboxSession;
}): Promise<{
  prompt: string;
}> {
  const formatMessageOptions = {
    writeFileBuffer: async ({
      fileName,
      content,
    }: {
      fileName: string;
      content: Buffer;
    }) => {
      await session.writeFile(fileName, content);
      return fileName;
    },
  };

  const promptWithMessageToSendOnly = async () => {
    return convertToPrompt(userMessageToSend, formatMessageOptions);
  };

  const promptWithFullHistory = async () => {
    if (threadMessages && threadMessages.length > 0) {
      return await formatThreadToMsg(threadMessages, formatMessageOptions);
    }
    // No thread history, just format the current message
    return promptWithMessageToSendOnly();
  };

  let prompt: string;
  switch (agent) {
    case "codex": {
      if (agentVersion < 1) {
        prompt = await promptWithFullHistory();
      } else {
        prompt = await promptWithMessageToSendOnly();
      }
      break;
    }
    case "amp":
    case "gemini":
    case "opencode":
    case "claudeCode": {
      prompt = await promptWithMessageToSendOnly();
      break;
    }
    default: {
      const _exhaustiveCheck: never = agent;
      console.warn("Unknown agent", _exhaustiveCheck);
      prompt = await promptWithMessageToSendOnly();
    }
  }
  return { prompt };
}
