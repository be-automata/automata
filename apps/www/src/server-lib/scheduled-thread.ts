import { db } from "@/lib/db";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { getThreadChat } from "@terragon/shared/model/threads";
import { waitUntil } from "@/lib/wait-until";
import { startAgentMessage } from "@/agent/msg/startAgentMessage";

export async function runScheduledThread({
  threadId,
  threadChatId,
  userId,
}: {
  threadId: string;
  threadChatId: string;
  userId: string;
}) {
  const threadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId,
  });
  if (!threadChat) {
    throw new Error("Thread chat not found");
  }
  const { didUpdateStatus } = await updateThreadChatWithTransition({
    userId,
    threadId,
    threadChatId,
    eventType: "system.resume",
    chatUpdates: {
      scheduleAt: null,
      errorMessage: null,
      errorMessageInfo: null,
    },
  });
  if (!didUpdateStatus) {
    throw new Error("Failed to update thread");
  }
  waitUntil(
    startAgentMessage({
      db,
      userId,
      threadId,
      threadChatId,
      isNewThread: true,
    }),
  );
}
