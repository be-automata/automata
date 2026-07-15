"use server";

import { db } from "@/lib/db";
import { userOnlyAction } from "@/lib/auth-server";
import { UserFacingError } from "@/lib/server-actions";
import {
  DBUserMessage,
  ThreadChatInsert,
  ThreadInsert,
} from "@terragon/shared";
import { SelectedAIModels } from "@terragon/agent/types";
import { modelToAgent } from "@terragon/agent/utils";
import {
  getThread,
  updateThread,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { waitUntil } from "@/lib/wait-until";
import { startAgentMessage } from "@/agent/msg/startAgentMessage";
import { getUserMessageToSend } from "@/lib/db-message-helpers";
import { generateAndUpdateThreadName } from "@/server-lib/new-thread-shared";
import { uploadUserMessageImages } from "@/lib/r2-file-upload-server";
import { userMessageToPlainText } from "@/components/promptbox/tiptap-to-richtext";
import { newThreadsMultiModel } from "@/server-lib/new-threads-multi-model";
import { getPrimaryThreadChat } from "@terragon/shared/utils/thread-utils";

export type UpdateDraftThreadUpdates = Partial<{
  userMessage: DBUserMessage;
  repoFullName: string;
  branchName: string;
  disableGitCheckpointing: boolean;
  skipSetup: boolean;
}>;

export const updateDraftThread = userOnlyAction(
  async function updateDraftThread(
    userId: string,
    {
      threadId,
      updates,
    }: {
      threadId: string;
      updates: UpdateDraftThreadUpdates;
    },
  ) {
    console.log("updateDraftThread", threadId);
    const thread = await getThread({ db, threadId, userId });
    if (!thread) {
      throw new UserFacingError("Task not found");
    }
    if (!thread.draftMessage) {
      throw new UserFacingError("Task is not a draft");
    }
    const updatesToApply: Partial<ThreadInsert> = {};
    const chatUpdatesToApply: Omit<ThreadChatInsert, "threadChatId"> = {};
    if (updates.userMessage) {
      updatesToApply.name = userMessageToPlainText(updates.userMessage);
      updatesToApply.draftMessage = updates.userMessage;
      chatUpdatesToApply.agent = modelToAgent(updates.userMessage.model);
    }
    if (updates.repoFullName) {
      updatesToApply.githubRepoFullName = updates.repoFullName;
    }
    if (updates.branchName) {
      updatesToApply.repoBaseBranchName = updates.branchName;
    }
    if (typeof updates.disableGitCheckpointing === "boolean") {
      updatesToApply.disableGitCheckpointing = updates.disableGitCheckpointing;
    }
    if (typeof updates.skipSetup === "boolean") {
      updatesToApply.skipSetup = updates.skipSetup;
    }
    const threadChat = getPrimaryThreadChat(thread);
    if (Object.keys(updatesToApply).length > 0) {
      await updateThread({
        db,
        userId,
        threadId,
        updates: updatesToApply,
      });
    }
    if (Object.keys(chatUpdatesToApply).length > 0) {
      await updateThreadChat({
        db,
        userId,
        threadId,
        threadChatId: threadChat.id,
        updates: chatUpdatesToApply,
      });
    }
  },
  {
    defaultErrorMessage:
      "Failed to update draft task. Your changes were not saved.",
  },
);

export const submitDraftThread = userOnlyAction(
  async function submitDraftThread(
    userId: string,
    {
      threadId,
      userMessage,
      selectedModels,
      scheduleAt,
    }: {
      threadId: string;
      userMessage: DBUserMessage;
      selectedModels: SelectedAIModels;
      scheduleAt?: number | null;
    },
  ) {
    const thread = await getThread({ db, threadId, userId });
    if (!thread) {
      throw new UserFacingError("Task not found");
    }
    if (!thread.draftMessage) {
      throw new UserFacingError("Task is not a draft");
    }
    // Otherwise, submit immediately (existing logic)
    const messagesToAppend = [
      await uploadUserMessageImages({ userId, message: userMessage }),
    ];
    const threadChat = getPrimaryThreadChat(thread);

    const updateThreadName = () => {
      // Generate a name for the thread.
      waitUntil(
        (async () => {
          const userMessage = getUserMessageToSend({
            messages: messagesToAppend,
            currentMessage: null,
          });
          if (userMessage) {
            await generateAndUpdateThreadName({
              userId,
              threadId: thread.id,
              message: userMessage,
            });
          }
        })(),
      );
    };

    // If scheduleAt is provided, validate it and schedule the task
    if (scheduleAt) {
      if (scheduleAt < Date.now()) {
        throw new UserFacingError("Schedule time must be in the future");
      }
      const { didUpdateStatus } = await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId: threadChat.id,
        eventType: "user.schedule",
        updates: {
          archived: false,
          draftMessage: null,
        },
        chatUpdates: {
          agent: modelToAgent(userMessage.model),
          appendMessages: messagesToAppend,
          scheduleAt: new Date(scheduleAt),
        },
      });
      if (!didUpdateStatus) {
        throw new UserFacingError("Failed to schedule draft task");
      }
    } else {
      const { didUpdateStatus } = await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId: threadChat.id,
        eventType: "user.queue",
        updates: {
          archived: false,
          draftMessage: null,
        },
        chatUpdates: {
          agent: modelToAgent(userMessage.model),
          appendMessages: messagesToAppend,
        },
      });
      if (!didUpdateStatus) {
        throw new UserFacingError("Failed to submit draft task");
      }
      waitUntil(
        startAgentMessage({
          db,
          userId,
          threadId,
          threadChatId: threadChat.id,
          isNewThread: true,
        }),
      );
    }
    updateThreadName();
    if (selectedModels) {
      await newThreadsMultiModel({
        userId,
        message: userMessage,
        selectedModels,
        githubRepoFullName: thread.githubRepoFullName,
        baseBranchName: thread.repoBaseBranchName,
        headBranchName: null,
        disableGitCheckpointing: thread.disableGitCheckpointing,
        skipSetup: thread.skipSetup,
        scheduleAt,
      });
    }
  },
  {
    defaultErrorMessage: "Failed to submit draft task",
  },
);
