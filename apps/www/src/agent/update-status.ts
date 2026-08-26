import { db } from "@/lib/db";
import {
  getThreadChat,
  updateThread,
  updateThreadChat,
  updateThreadChatStatusAtomic,
} from "@terragon/shared/model/threads";
import { ThreadError } from "./error";
import { handleTransition, ThreadEvent } from "./machine";
import { ThreadChatInsert, ThreadInsert, ThreadStatus } from "@terragon/shared";
import { markThreadChatAsUnread } from "@terragon/shared/model/thread-read-status";

export async function updateThreadChatWithTransition({
  userId,
  threadId,
  threadChatId,
  eventType,
  markAsUnread,
  rateLimitResetTime,
  updates,
  chatUpdates,
}: {
  threadId: string;
  userId: string;
  threadChatId: string;
  eventType: ThreadEvent;
  markAsUnread?: boolean;
  rateLimitResetTime?: number;
  updates?: Partial<ThreadInsert>;
  chatUpdates?: Omit<
    ThreadChatInsert,
    "threadChatId" | "status" | "reattemptQueueAt"
  >;
}): Promise<{
  didUpdateStatus: boolean;
  updatedStatus: ThreadStatus | undefined;
}> {
  const threadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId,
  });
  if (!threadChat) {
    throw new ThreadError("unknown-error", "Thread not found", null);
  }
  let didUpdateStatus = false;
  const updatedStatus = handleTransition(threadChat.status, eventType);
  if (updatedStatus) {
    let reattemptQueueAt: Date | null | undefined = undefined;
    // Handle reattemptQueueAt based on status transition
    if (
      updatedStatus === "queued-sandbox-creation-rate-limit" ||
      updatedStatus === "queued-agent-rate-limit"
    ) {
      // Set reattempt time based on rate limit reset time
      if (rateLimitResetTime !== undefined) {
        reattemptQueueAt = new Date(rateLimitResetTime);
      } else if (!threadChat.reattemptQueueAt) {
        // Fallback to 1 hour if no reset time provided
        reattemptQueueAt = new Date(Date.now() + 60 * 60 * 1000);
      }
    }
    // Take the CAS RESULT, not the truthiness of the wrapper. This used to be
    // `if (!!updatedThreadOrUndefined)` against a value that once was a
    // row-or-undefined; updateThreadChatStatusAtomic now returns
    // `{ didUpdateStatus: boolean }` — an object, so ALWAYS truthy. Every
    // caller that treats `didUpdateStatus` as "I won the race" was therefore
    // told it won even when the `eq(status, fromStatus)` guard matched zero
    // rows, which is the entire point of the compare-and-set.
    ({ didUpdateStatus } = await updateThreadChatStatusAtomic({
      db,
      userId,
      threadId,
      threadChatId,
      fromStatus: threadChat.status,
      toStatus: updatedStatus,
      reattemptQueueAt,
    }));
  }
  if (updates) {
    await updateThread({
      db,
      userId,
      threadId,
      updates,
    });
  }
  if (chatUpdates) {
    await updateThreadChat({
      db,
      userId,
      threadId,
      threadChatId,
      updates: chatUpdates,
    });
  }
  if (didUpdateStatus && (updates || chatUpdates)) {
    if (markAsUnread) {
      await markThreadChatAsUnread({
        db,
        userId,
        threadId,
        threadChatIdOrNull: threadChatId,
        shouldPublishRealtimeEvent: true,
      });
    }
  }
  return {
    didUpdateStatus,
    updatedStatus: updatedStatus ?? undefined,
  };
}
