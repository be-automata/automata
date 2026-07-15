"use server";

import {
  markThreadAsRead,
  markThreadChatAsRead,
} from "@terragon/shared/model/thread-read-status";
import { db } from "@/lib/db";
import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { getThread } from "@terragon/shared/model/threads";

export const readThread = userOnlyAction(
  async function readThread(
    userId: string,
    {
      threadId,
      threadChatIdOrNull,
    }: {
      threadId: string;
      threadChatIdOrNull: string | null;
    },
  ) {
    console.log("readThread", { threadId, threadChatIdOrNull });
    const tenant = await getTenantContextOrNull();
    const thread = await getThread({
      db,
      userId,
      threadId,
      organizationId: tenant?.organizationId ?? null,
    });
    if (!thread) {
      throw new Error("Thread not found");
    }
    if (threadChatIdOrNull) {
      await markThreadChatAsRead({
        db,
        userId,
        threadId,
        threadChatId: threadChatIdOrNull,
        shouldPublishRealtimeEvent: true,
      });
    } else {
      await markThreadAsRead({
        db,
        userId,
        threadId,
        shouldPublishRealtimeEvent: true,
      });
    }
  },
  { defaultErrorMessage: "An unexpected error occurred" },
);
