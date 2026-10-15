"use server";

import {
  requireExpectedActiveMembership,
  userOnlyAction,
} from "@/lib/auth-server";
import { SelectedAIModels } from "@terragon/agent/types";
import { DBUserMessage, ThreadSource } from "@terragon/shared";
import { createNewThread } from "../server-lib/new-thread-shared";
import { getAccessInfoForUser } from "@/lib/subscription";
import { SUBSCRIPTION_MESSAGES } from "@/lib/subscription-msgs";
import { newThreadsMultiModel } from "@/server-lib/new-threads-multi-model";
import { UserFacingError } from "@/lib/server-actions";
import { isRepoInOrganizationScope } from "@/server-lib/user-repos";

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
  /**
   * The org the page showed (useActiveOrganization's expectedOrganizationId):
   * an id, null for "no org", or undefined to skip the check.
   */
  expectedOrganizationId?: string | null;
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
      expectedOrganizationId,
    }: NewThreadArgs,
  ): Promise<{ threadId: string; threadChatId: string }> {
    console.log("newThread", { userId, githubRepoFullName });
    // The creator's active org is stamped onto the thread (WI-5). Nullable
    // during the backfill phase — null = thread created without an org
    // (today's behavior). Refused when another tab switched org after the
    // page rendered, so a task never lands in an org the user was not shown.
    const [{ tier }, membership] = await Promise.all([
      getAccessInfoForUser(userId),
      requireExpectedActiveMembership(userId, { expectedOrganizationId }),
    ]);
    // Gate task creation behind active access
    if (tier === "none") {
      throw new UserFacingError(SUBSCRIPTION_MESSAGES.CREATE_TASK);
    }
    const organizationId = membership?.organizationId ?? null;
    if (
      organizationId &&
      !(await isRepoInOrganizationScope({
        organizationId,
        repoFullName: githubRepoFullName,
      }))
    ) {
      throw new UserFacingError(
        `${githubRepoFullName} is not in this organization's repositories. Bind its GitHub installation to the organization in Settings → Integrations, or switch organization.`,
      );
    }

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
