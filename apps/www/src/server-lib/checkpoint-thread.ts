import { db } from "@/lib/db";
import {
  getThread,
  getThreadChat,
  getThreadMinimal,
  updateThread,
} from "@terragon/shared/model/threads";
import { getUserSettings, getUser } from "@terragon/shared/model/user";
import { withThreadSandboxSession } from "@/agent/thread-resource";
import { ThreadError, wrapError } from "@/agent/error";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { maybeProcessFollowUpQueue } from "@/server-lib/process-follow-up-queue";
import { getAutomation } from "@terragon/shared/model/automations";
import { PullRequestTriggerConfig } from "@terragon/shared/automations";
import { checkpointThreadAndPush } from "./checkpoint-thread-internal";
import { maybeSaveClaudeSessionToR2 } from "./claude-session";
import { maybeUpdateGitHubCheckRunForThreadChat } from "./github";
import { sendLoopsTransactionalEmail } from "@/lib/loops";
import { publicAppUrl } from "@terragon/env/next-public";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";

export async function checkpointThread({
  userId,
  threadId,
  threadChatId,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
}) {
  await withThreadSandboxSession({
    label: "checkpoint-thread",
    threadId,
    userId,
    threadChatId,
    onBeforeExec: async () => {
      const { didUpdateStatus } = await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId,
        eventType: "system.checkpoint",
      });
      return didUpdateStatus;
    },
    execOrThrow: async ({ threadChat, session, thread }) => {
      if (!session) {
        if (thread && !thread.codesandboxId) {
          // ADR-003 remote-plane thread: nothing to checkpoint on the control
          // plane (the worker already committed and pushed). Finish the
          // transition instead of stamping a false "sandbox-not-found" —
          // reachable via the retry-git-checkpoint action even though the
          // daemon-event path skips checkpointing for these threads.
          await updateThreadChatWithTransition({
            userId,
            threadId,
            threadChatId,
            eventType: "system.checkpoint-done",
          });
          return;
        }
        throw new ThreadError("sandbox-not-found", "", null);
      }
      try {
        const userSettings = await getUserSettings({ db, userId });
        await checkpointThreadAndPush({
          userId,
          threadId,
          threadChatId,
          session,
          createPR: userSettings.autoCreatePRs,
          prType: userSettings.prType,
        });
      } catch (e) {
        throw wrapError("git-checkpoint-push-failed", e);
      }
      await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId,
        eventType: "system.checkpoint-done",
      });
      // Send task completion transactional email via Loops (if feature flag enabled)
      const isEmailNotifsEnabled = await getFeatureFlagForUser({
        db,
        userId,
        flagName: "enableEmailNotifs",
      });
      if (isEmailNotifsEnabled) {
        const [user, thread] = await Promise.all([
          getUser({ db, userId }),
          getThreadMinimal({ db, threadId, userId }),
        ]);
        if (user?.email && thread) {
          const taskUrl = `${publicAppUrl()}/task/${threadId}`;
          await sendLoopsTransactionalEmail({
            email: user.email,
            transactionalId: "cmggdi0rhd5ns0c0i5wn9wu29", // Task completion template
            dataVariables: {
              threadName: thread.name ?? "Task",
              taskUrl,
              repoFullName: thread.githubRepoFullName,
              model: threadChat!.agent,
              threadId,
            },
          });
        }
      }
      if (threadChat?.agent === "claudeCode") {
        await maybeSaveClaudeSessionToR2({
          userId,
          threadId,
          threadChatId,
          session,
        });
      }
      await maybeAutoArchiveThread({ userId, threadId, threadChatId });
      await maybeUpdateGitHubCheckRunForThreadChat({
        userId,
        threadId,
        threadChatId,
        status: "completed",
        conclusion: "success",
        summary: `Task completed: ${threadId}`,
      });
      await maybeProcessFollowUpQueue({
        threadId,
        userId,
        threadChatId,
      });
    },
    onError: (error) => {
      console.error("Error in post-processing:", error);
    },
  });
}

async function maybeAutoArchiveThread({
  userId,
  threadId,
  threadChatId,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
}) {
  try {
    // Get the thread to check if it's associated with an automation
    const [thread, threadChat] = await Promise.all([
      getThread({ db, threadId, userId }),
      getThreadChat({ db, threadId, threadChatId, userId }),
    ]);
    if (!thread || !threadChat) {
      return;
    }
    if (!thread.automationId || (threadChat.queuedMessages?.length ?? 0) > 0) {
      return;
    }
    // Get the automation configuration
    const automation = await getAutomation({
      db,
      automationId: thread.automationId,
      userId,
    });
    if (!automation || automation.triggerType !== "pull_request") {
      return;
    }
    // Check if auto-archive is enabled
    const prConfig = automation.triggerConfig as PullRequestTriggerConfig;
    if (prConfig.autoArchiveOnComplete) {
      console.log(
        `Auto-archiving thread ${threadId} for PR automation ${automation.id}`,
      );
      await updateThread({
        db,
        userId,
        threadId: thread.id,
        updates: {
          archived: true,
          updatedAt: new Date(),
        },
      });
    }
  } catch (error) {
    console.error("Error in auto-archive:", error);
    // Don't throw - we don't want to fail the checkpoint if auto-archive fails
  }
}
