import { db } from "@/lib/db";
import { startAgentMessage } from "@/agent/msg/startAgentMessage";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { getPostHogServer } from "@/lib/posthog-server";
import { DBSystemMessage } from "@terragon/shared";
import { waitUntil } from "@/lib/wait-until";

export async function sendSystemMessage({
  userId,
  threadId,
  threadChatId,
  message,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  message: DBSystemMessage;
}) {
  console.log("sendSystemMessage", threadId, message);
  getPostHogServer().capture({
    distinctId: userId,
    event: "system_message",
    properties: {
      threadId,
      messageType: message.message_type,
    },
  });
  const { didUpdateStatus, updatedStatus } =
    await updateThreadChatWithTransition({
      userId,
      threadId,
      threadChatId,
      eventType: "system.message",
      chatUpdates: {
        errorMessage: null,
        errorMessageInfo: null,
        appendMessages: [message],
      },
    });
  if (!didUpdateStatus) {
    throw new Error("Failed to update thread");
  }
  if (updatedStatus === "working" || updatedStatus === "queued") {
    waitUntil(
      startAgentMessage({
        db,
        message: null,
        userId,
        threadId,
        threadChatId,
        isNewThread: false,
      }),
    );
  }
}
