"use server";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { SelectedAIModels } from "@terragon/agent/types";
import { DBUserMessage, ThreadSource } from "@terragon/shared";
import { createNewThread } from "../server-lib/new-thread-shared";
import { getAccessInfoForUser } from "@/lib/subscription";
import { SUBSCRIPTION_MESSAGES } from "@/lib/subscription-msgs";
import { newThreadsMultiModel } from "@/server-lib/new-threads-multi-model";
import { UserFacingError } from "@/lib/server-actions";

export type NewThreadArgs = {
  message: DBUserMessage;
  githubRepoFullName: string;
  branchName: string;
  createNewBranch?: boolean;
  parentThreadId?: string;
  parentToolId?: string;
  saveAsDraft?: boolean;
  disableGitCheckpointing?: boolean;
  skipSetup?: boolean;
  scheduleAt?: number | null;
  selectedModels?: SelectedAIModels;
  sourceType?: ThreadSource;
};

export const newThread = userOnlyAction(
  async function newThread(
    userId: string,
    {
      message,
      selectedModels,
      githubRepoFullName,
      branchName,
      parentThreadId,
      parentToolId,
      saveAsDraft,
      disableGitCheckpointing,
      skipSetup,
      createNewBranch = true,
      scheduleAt,
      sourceType = "www",
    }: NewThreadArgs,
  ): Promise<{ threadId: string; threadChatId: string }> {
    console.log("newThread", { userId, githubRepoFullName });
    // Gate task creation behind active access
    const { tier } = await getAccessInfoForUser(userId);
    if (tier === "none") {
      throw new UserFacingError(SUBSCRIPTION_MESSAGES.CREATE_TASK);
    }

    // Stamp the creator's active org onto the thread (WI-5). Nullable during the
    // backfill phase — null = thread created without an org (today's behavior).
    const tenant = await getTenantContextOrNull();
    const organizationId = tenant?.organizationId ?? null;

    const baseBranchName = createNewBranch ? branchName : null;
    const headBranchName = createNewBranch ? null : branchName;
    const { threadId, threadChatId } = await createNewThread({
      userId,
      organizationId,
      message,
      githubRepoFullName,
      baseBranchName,
      headBranchName,
      parentThreadId,
      parentToolId,
      generateName: true,
      saveAsDraft,
      scheduleAt,
      sourceType,
      disableGitCheckpointing,
      skipSetup,
    });
    if (selectedModels && !saveAsDraft) {
      await newThreadsMultiModel({
        userId,
        organizationId,
        message,
        selectedModels,
        parentThreadId,
        parentToolId,
        githubRepoFullName,
        baseBranchName,
        headBranchName,
        scheduleAt,
        disableGitCheckpointing,
        skipSetup,
      });
    }
    return { threadId, threadChatId };
  },
  { defaultErrorMessage: "Failed to create task" },
);
