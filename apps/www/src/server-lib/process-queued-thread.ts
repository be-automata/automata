import { db } from "@/lib/db";
import { startAgentMessage } from "@/agent/msg/startAgentMessage";
import { getPostHogServer } from "@/lib/posthog-server";
import { getSandboxCreationRemaining } from "@/lib/rate-limit";
import { getMaxConcurrentTaskCountForUser } from "@/lib/subscription-tiers";
import {
  atomicDequeueThreadChats,
  getThreadChat,
  getActiveThreadCount,
  getEligibleQueuedThreadChats as getEligibleQueuedThreadChatsModel,
  getQueuedThreadCounts,
  getThreadMinimal,
  updateThread,
} from "@terragon/shared/model/threads";
import { ensureThreadChatHasUserMessage } from "@/server-lib/retry-thread";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";

/** Queued tasks older than this are RETIRED (archived, not run) on promotion. */
const STALE_QUEUED_AGE_MS = 60 * 60 * 1000; // 1h (pilot)
/** Safety bound on the promote loop per call. */
const MAX_PROMOTE_ITERATIONS = 25;

/**
 * A queued task is stale — RETIRE it (archive + log, do NOT run) rather than
 * suddenly executing arbitrarily-old work when the queue finally drains (e.g. a
 * mention from days ago, or an accumulated UAT backlog). Stale = queued longer than
 * the threshold OR its source issue/PR is already closed (running would post onto a
 * closed/old thread and burn credits). "Retire loudly" is the middle ground between
 * silently dropping and blindly executing (ADR-002 §Worker availability lesson).
 */
async function isStaleQueuedThread(thread: {
  userId: string;
  createdAt: Date | string | null;
  githubRepoFullName: string | null;
  githubPRNumber: number | null;
  githubIssueNumber: number | null;
}): Promise<{ stale: boolean; reason: string }> {
  const ageMs = thread.createdAt
    ? Date.now() - new Date(thread.createdAt).getTime()
    : 0;
  if (ageMs > STALE_QUEUED_AGE_MS) {
    return { stale: true, reason: `queued-age ${Math.round(ageMs / 60000)}m > 60m` };
  }
  // Best-effort closed-source check (App octokit; failure → treat as not-closed).
  const number = thread.githubPRNumber ?? thread.githubIssueNumber ?? null;
  if (number && thread.githubRepoFullName) {
    try {
      const [owner, repo] = parseRepoFullName(thread.githubRepoFullName);
      const octokit = await getOctokitForApp({ owner, repo });
      const { data } = await octokit.rest.issues.get({
        owner,
        repo,
        issue_number: number,
      });
      if (data.state === "closed") {
        return { stale: true, reason: `source #${number} is closed` };
      }
    } catch {
      // can't confirm → don't retire on this signal
    }
  }
  return { stale: false, reason: "" };
}

export async function getEligibleQueuedThreadChats({
  userId,
}: {
  userId: string;
}) {
  const [
    sandboxCreationRateLimitRemaining,
    activeThreadCount,
    maxConcurrentTasks,
  ] = await Promise.all([
    getSandboxCreationRemaining(userId),
    getActiveThreadCount({ db, userId }),
    getMaxConcurrentTaskCountForUser(userId),
  ]);
  return await getEligibleQueuedThreadChatsModel({
    db,
    userId,
    concurrencyLimitReached: activeThreadCount >= maxConcurrentTasks,
    sandboxCreationRateLimitReached:
      sandboxCreationRateLimitRemaining.remaining === 0,
  });
}

export async function maybeStartQueuedThreadChat({
  userId,
}: {
  userId: string;
}) {
  // Bounded loop: dequeue eligible threads, RETIRE stale ones (archive + log, don't
  // run), and START the first fresh one — then let the re-checked concurrency gate
  // stop the loop (a started thread becomes active). This drains stale backlog AND
  // fills a freed slot in one pass.
  for (let i = 0; i < MAX_PROMOTE_ITERATIONS; i++) {
    const [eligibleQueuedThreadChats, queuedThreadCounts] = await Promise.all([
      getEligibleQueuedThreadChats({ userId }),
      getQueuedThreadCounts({ db, userId }),
    ]);
    if (i === 0) {
      console.log("Eligible queued thread chats", {
        eligibleThreadChatCount: eligibleQueuedThreadChats.length,
        ...queuedThreadCounts,
      });
      if (eligibleQueuedThreadChats.length > 0) {
        getPostHogServer().capture({
          distinctId: userId,
          event: "queue_status",
          properties: {
            eligibleThreadChatCount: eligibleQueuedThreadChats.length,
          },
        });
      }
    }
    if (eligibleQueuedThreadChats.length === 0) {
      return;
    }
    const result = await atomicDequeueThreadChats({
      db,
      userId,
      eligibleThreadChats: eligibleQueuedThreadChats,
    });
    if (!result) {
      console.log(
        "No eligible queued thread dequeued (likely claimed by another process)",
      );
      return;
    }
    const { threadId, threadChatId, oldStatus } = result;
    const [threadChat, thread] = await Promise.all([
      getThreadChat({ db, threadId, threadChatId, userId }),
      getThreadMinimal({ db, threadId, userId }),
    ]);
    if (!threadChat || !thread) {
      console.error("Thread chat not found", { threadId, threadChatId });
      continue;
    }

    // STALE RETIREMENT: never suddenly execute arbitrarily-old queued work.
    const { stale, reason } = await isStaleQueuedThread({
      userId,
      createdAt: thread.createdAt ?? null,
      githubRepoFullName: thread.githubRepoFullName ?? null,
      githubPRNumber: thread.githubPRNumber ?? null,
      githubIssueNumber: thread.githubIssueNumber ?? null,
    });
    if (stale) {
      console.log("[queue] RETIRING stale queued thread (archived, not run)", {
        threadId,
        threadChatId,
        reason,
      });
      // queued --user.stop--> complete (a valid terminal transition), then archive.
      await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId,
        eventType: "user.stop",
      });
      await updateThread({ db, userId, threadId, updates: { archived: true } });
      getPostHogServer().capture({
        distinctId: userId,
        event: "queued_thread_retired",
        properties: { threadId, threadChatId, reason },
      });
      continue; // retiring frees no slot — keep draining
    }
    await ensureThreadChatHasUserMessage({ threadChat });
    console.log(`Starting queued thread`, {
      threadId,
      threadChatId: threadChat.id,
      previousStatus: oldStatus,
    });
    const queuedDurationMs = thread.createdAt
      ? Date.now() - new Date(thread.createdAt).getTime()
      : 0;
    getPostHogServer().capture({
      distinctId: userId,
      event: "thread_dequeued",
      properties: { threadId, threadChatId, previousStatus: oldStatus, queuedDurationMs },
    });
    await startAgentMessage({
      db,
      userId,
      threadId,
      threadChatId,
      isNewThread: !thread?.codesandboxId,
    });
    // A slot is now consumed; loop re-checks eligibility (concurrency gate will
    // stop it once the cap is hit) to fill any remaining free slots.
  }
}
