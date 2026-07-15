import { db } from "@/lib/db";
import { startAgentMessage } from "@/agent/msg/startAgentMessage";
import { getPostHogServer } from "@/lib/posthog-server";
import { getSandboxCreationRemaining } from "@/lib/rate-limit";
import { getMaxConcurrentTaskCountForUser } from "@/lib/subscription-tiers";
import {
  atomicDequeueThreadChats,
  getThreadChat,
  getActiveThreadCount,
  getEligibleQueuedThreadChats as getEligibleQueuedThreadChatsModel,
  getQueuedThreadCounts,
  getThreadMinimal,
} from "@terragon/shared/model/threads";
import { ensureThreadChatHasUserMessage } from "@/server-lib/retry-thread";

export async function getEligibleQueuedThreadChats({
  userId,
}: {
  userId: string;
}) {
  const [
    sandboxCreationRateLimitRemaining,
    activeThreadCount,
    maxConcurrentTasks,
  ] = await Promise.all([
    getSandboxCreationRemaining(userId),
    getActiveThreadCount({ db, userId }),
    getMaxConcurrentTaskCountForUser(userId),
  ]);
  return await getEligibleQueuedThreadChatsModel({
    db,
    userId,
    concurrencyLimitReached: activeThreadCount >= maxConcurrentTasks,
    sandboxCreationRateLimitReached:
      sandboxCreationRateLimitRemaining.remaining === 0,
  });
}

export async function maybeStartQueuedThreadChat({
  userId,
}: {
  userId: string;
}) {
  const [eligibleQueuedThreadChats, queuedThreadCounts] = await Promise.all([
    getEligibleQueuedThreadChats({ userId }),
    getQueuedThreadCounts({ db, userId }),
  ]);
  console.log("Eligible queued thread chats", {
    eligibleThreadChatCount: eligibleQueuedThreadChats.length,
    ...queuedThreadCounts,
  });
  // Log queue status metrics
  if (eligibleQueuedThreadChats.length > 0) {
    getPostHogServer().capture({
      distinctId: userId,
      event: "queue_status",
      properties: {
        eligibleThreadChatCount: eligibleQueuedThreadChats.length,
      },
    });
  }
  if (eligibleQueuedThreadChats.length === 0) {
    return;
  }
  // Atomically dequeue and update a thread
  const result = await atomicDequeueThreadChats({
    db,
    userId,
    eligibleThreadChats: eligibleQueuedThreadChats,
  });
  if (!result) {
    console.log(
      "No eligible queued thread dequeued (likely claimed by another process)",
    );
    return;
  }
  const { threadId, threadChatId, oldStatus } = result;
  const threadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId,
  });
  if (!threadChat) {
    console.error("Thread chat not found", { threadId, threadChatId });
    return;
  }
  await ensureThreadChatHasUserMessage({ threadChat });
  console.log(`Starting queued thread`, {
    threadId,
    threadChatId: threadChat.id,
    previousStatus: oldStatus,
  });
  // Calculate queuing delay using updatedAt (when the thread last transitioned to queued status)
  // This is more accurate than createdAt since threads can be queued after initial creation
  const queuedDurationMs = threadChat.updatedAt
    ? Date.now() - new Date(threadChat.updatedAt).getTime()
    : 0;
  // Log queue processing metrics
  getPostHogServer().capture({
    distinctId: userId,
    event: "thread_dequeued",
    properties: {
      threadId,
      threadChatId,
      previousStatus: oldStatus,
      queuedDurationMs,
    },
  });
  const thread = await getThreadMinimal({
    db,
    threadId,
    userId,
  });
  await startAgentMessage({
    db,
    userId,
    threadId,
    threadChatId,
    isNewThread: !thread?.codesandboxId,
  });
}
