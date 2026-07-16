import { db } from "@/lib/db";
import { DBUserMessage } from "@terragon/shared";
import { waitUntil } from "@/lib/wait-until";
import { startAgentMessage } from "@/agent/msg/startAgentMessage";
import { getPostHogServer } from "@/lib/posthog-server";
import {
  estimateMessageSize,
  getLastUserMessageModel,
  imageCount,
} from "@/lib/db-message-helpers";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import {
  getThreadChat,
  getThreadMinimal,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import { maybeProcessFollowUpQueue } from "./process-follow-up-queue";
import { isAgentWorking } from "@/agent/thread-status";
import { getDefaultModelForAgent, modelToAgent } from "@terragon/agent/utils";
import { uploadUserMessageImages } from "@/lib/r2-file-upload-server";
import { getAccessInfoForUser } from "@/lib/subscription";
import { SUBSCRIPTION_MESSAGES } from "@/lib/subscription-msgs";

export async function followUpInternal({
  userId,
  threadId,
  threadChatId,
  message,
  source,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  message: DBUserMessage;
  source: "www" | "github";
}) {
  const { tier } = await getAccessInfoForUser(userId);
  if (tier === "none") {
    throw new Error(SUBSCRIPTION_MESSAGES.QUEUE_FOLLOW_UP);
  }
  const threadChat = await getThreadChat({
    db,
    threadId,
    userId,
    threadChatId,
  });
  if (!threadChat) {
    throw new Error("Thread chat not found");
  }
  getPostHogServer().capture({
    distinctId: userId,
    event: "follow_up",
    properties: {
      threadId,
      model: message.model,
      agentType: modelToAgent(message.model),
      imageCount: imageCount(message),
      promptTextSize: estimateMessageSize(message),
      source,
    },
  });
  const { didUpdateStatus, updatedStatus } =
    await updateThreadChatWithTransition({
      userId,
      threadId,
      threadChatId: threadChat.id,
      eventType: "user.message",
      chatUpdates: {
        errorMessage: null,
        errorMessageInfo: null,
        permissionMode: message.permissionMode || "allowAll",
      },
    });
  if (!didUpdateStatus) {
    throw new Error("Failed to update thread");
  }
  if (updatedStatus === "scheduled") {
    await updateThreadChat({
      db,
      userId,
      threadId,
      threadChatId: threadChat.id,
      updates: {
        appendMessages: [await uploadUserMessageImages({ userId, message })],
      },
    });
    return;
  }
  const messageWithModel = {
    ...message,
    model:
      message.model ||
      getLastUserMessageModel(threadChat.messages ?? []) ||
      getDefaultModelForAgent({
        agent: threadChat.agent,
        agentVersion: threadChat.agentVersion,
      }),
  };
  const thread = await getThreadMinimal({ db, threadId, userId });
  waitUntil(
    startAgentMessage({
      db,
      message: messageWithModel,
      userId,
      threadId,
      threadChatId: threadChat.id,
      // It is possible that the thread was queued, stopped while it was queued and now the user sends a follow up
      // which means we have a follow up to a thread without a codesandboxId. In this case, we need to pass
      // isNewThread: true.
      isNewThread: !thread?.codesandboxId,
    }),
  );
}

export async function queueFollowUpInternal({
  userId,
  threadId,
  threadChatId,
  messages,
  appendOrReplace,
  source,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  messages: DBUserMessage[];
  appendOrReplace: "append" | "replace";
  source: "www" | "github";
}) {
  const { tier } = await getAccessInfoForUser(userId);
  if (tier === "none") {
    throw new Error(SUBSCRIPTION_MESSAGES.QUEUE_FOLLOW_UP);
  }
  const threadChat = await getThreadChat({
    db,
    threadId,
    userId,
    threadChatId,
  });
  if (!threadChat) {
    throw new Error("Thread chat not found");
  }
  getPostHogServer().capture({
    distinctId: userId,
    event: "queue_follow_up",
    properties: {
      threadId,
      source,
      model: messages[0]?.model ?? null,
      agentType: modelToAgent(messages[0]?.model ?? null),
      imageCount: messages.reduce(
        (acc, message) => acc + imageCount(message),
        0,
      ),
      promptTextSize: messages.reduce(
        (acc, message) => acc + estimateMessageSize(message),
        0,
      ),
    },
  });
  await updateThreadChat({
    db,
    userId,
    threadId,
    threadChatId,
    updates: {
      appendQueuedMessages: appendOrReplace === "append" ? messages : undefined,
      replaceQueuedMessages:
        appendOrReplace === "replace" ? messages : undefined,
    },
  });
  // Shadow mode (pilot): a shadow thread must never boot the agent, on
  // any path. The follow-up message is still queued + dashboard-visible, but we
  // don't drain the queue (which would run the agent → GitHub side effects).
  const thread = await getThreadMinimal({ db, userId, threadId });
  if (thread?.shadow) {
    console.log("[shadow] queued follow-up without booting agent", { threadId });
    return;
  }
  if (!isAgentWorking(threadChat.status)) {
    waitUntil(maybeProcessFollowUpQueue({ userId, threadId, threadChatId }));
  }
}
