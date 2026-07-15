"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { waitUntil } from "@/lib/wait-until";
import { db } from "@/lib/db";
import { startAgentMessage } from "@/agent/msg/startAgentMessage";
import { getPostHogServer } from "@/lib/posthog-server";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { ensureThreadChatHasUserMessage } from "@/server-lib/retry-thread";
import { UserFacingError } from "@/lib/server-actions";
import {
  getThreadChat,
  getThreadMinimal,
} from "@terragon/shared/model/threads";

export const retryThread = userOnlyAction(
  async function retryThread(
    userId: string,
    { threadId, threadChatId }: { threadId: string; threadChatId: string },
  ) {
    console.log("retryThread", {
      threadId,
      threadChatId,
    });
    const threadChat = await getThreadChat({
      db,
      threadId,
      threadChatId,
      userId,
    });
    if (!threadChat) {
      throw new UserFacingError("Task not found");
    }
    getPostHogServer().capture({
      distinctId: userId,
      event: "retry_thread",
      properties: {
        threadId,
        threadChatId,
      },
    });
    const { didUpdateStatus } = await updateThreadChatWithTransition({
      userId,
      threadId,
      threadChatId,
      eventType: "user.message",
    });
    if (!didUpdateStatus) {
      // This usually happens when the thread is already in progress or has been retried by another action
      console.warn(
        `[retryThread] Thread status update failed - likely already retrying`,
        {
          threadId,
          threadChatId,
          threadStatus: threadChat.status,
        },
      );
      return;
    }
    await ensureThreadChatHasUserMessage({
      threadChat,
    });

    const thread = await getThreadMinimal({ db, threadId, userId });
    waitUntil(
      startAgentMessage({
        db,
        userId,
        threadId,
        threadChatId,
        isNewThread: !thread?.codesandboxId, // If the thread has a sandbox, it's not a new thread.
      }),
    );
  },
  { defaultErrorMessage: "Failed to retry task" },
);
