"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { ThreadError } from "@/agent/error";
import { openPullRequestForThread } from "@/agent/pull-request";
import { withThreadSandboxSession } from "@/agent/thread-resource";
import { UserFacingError } from "@/lib/server-actions";
import { getThreadMinimal } from "@terragon/shared/model/threads";
import { db } from "@/lib/db";

export const openPullRequest = userOnlyAction(
  async function openPullRequest(
    userId: string,
    {
      threadId,
      prType = "draft",
    }: {
      threadId: string;
      prType?: "draft" | "ready";
    },
  ) {
    console.log("openPullRequest", threadId);
    // ADR-003 remote-plane threads have no control-plane sandbox by design:
    // the agent commits, pushes, and opens PRs itself in the worker workdir.
    // Guard BEFORE withThreadSandboxSession — its error handler swallows
    // errors when threadChatId is null, so a throw inside execOrThrow would
    // never reach the user.
    const thread = await getThreadMinimal({ db, threadId, userId });
    if (!thread) {
      throw new UserFacingError("Task not found");
    }
    if (!thread.codesandboxId) {
      if (thread.githubPRNumber) {
        return; // PR already exists — nothing to do.
      }
      throw new UserFacingError(
        "This task ran on remote infrastructure and its branch is pushed automatically. Open the PR from GitHub, or ask the agent to open it.",
      );
    }
    await withThreadSandboxSession({
      label: "openPullRequest",
      threadId,
      userId,
      threadChatId: null,
      execOrThrow: async ({ session }) => {
        if (!session) {
          throw new ThreadError("sandbox-not-found", "", null);
        }
        return await openPullRequestForThread({
          threadId,
          userId,
          prType,
          skipCommitAndPush: false,
          session,
        });
      },
    });
  },
  { defaultErrorMessage: "Failed to open pull request" },
);
