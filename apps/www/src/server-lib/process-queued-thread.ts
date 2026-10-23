import { env } from "@terragon/env/apps-www";
import { findAnyBotReviewAtCommit } from "@terragon/review/state/head-review-guard";
import { db } from "@/lib/db";
import {
  failQueuedDispatch,
  startAgentMessage,
} from "@/agent/msg/startAgentMessage";
import { getPostHogServer } from "@/lib/posthog-server";
import { getSandboxCreationRemaining } from "@/lib/rate-limit";
import { getMaxConcurrentTaskCountForUser } from "@/lib/subscription-tiers";
import {
  atomicDequeueThreadChats,
  getThreadChat,
  getActiveThreadCount,
  getEligibleQueuedThreadChats as getEligibleQueuedThreadChatsModel,
  getQueuedThreadCounts,
  getStrandedQueuedThreadChats,
  getThreadMinimal,
  updateThread,
  updateThreadChatStatusAtomic,
} from "@terragon/shared/model/threads";
import { ensureThreadChatHasUserMessage } from "@/server-lib/retry-thread";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import { resolveBotLogin } from "@/server-lib/review/bot-login";
import {
  createOctokitReviewClient,
  getPrHeadState,
} from "@/server-lib/review/octokit-review-client";
import { publishReviewNotice } from "@/server-lib/review/review-notice";
import { isReviewThread } from "@/server-lib/review/review-single-writer-finish";

/** Queued tasks older than this are RETIRED (archived, not run) on promotion. */
const STALE_QUEUED_AGE_MS = 60 * 60 * 1000; // 1h (pilot)
/** Safety bound on the promote loop per call. */
const MAX_PROMOTE_ITERATIONS = 25;

export type StaleQueuedVerdict =
  | { stale: false; kind: null; reason: "" }
  | { stale: true; kind: "age" | "closed"; reason: string };

const NOT_STALE: StaleQueuedVerdict = { stale: false, kind: null, reason: "" };

/**
 * A queued task is stale — RETIRE it (archive + log, do NOT run) rather than
 * suddenly executing arbitrarily-old work when the queue finally drains (e.g. a
 * mention from days ago, or an accumulated UAT backlog). "Retire loudly" is the
 * middle ground between silently dropping and blindly executing (ADR-002
 * §Worker availability lesson).
 *
 * Two rules, both measured from `queuedAt` — when THIS run entered the
 * concurrency queue (#446), not when the thread was created:
 *  - AGE: queued longer than the threshold. A follow-up on a thread created
 *    hours ago is a fresh run, not an old one.
 *  - CLOSED: the source PR/issue closed AFTER the run was queued
 *    (`closed_at > queuedAt`). A run created against an already-closed source
 *    (a post-merge ticket audit on its merged PR, a mention on a closed issue)
 *    is meant to run there; only a source that closed while the run waited
 *    means the work is no longer wanted. GitHub reports a merged PR as closed.
 *    A missing `closed_at` or a failed lookup FAILS OPEN (not stale).
 *
 * `queuedAt: null` = not a concurrency-queue run (the agent / sandbox
 * rate-limit queues): today's rules, unchanged — age from `createdAt`, and any
 * closed source is stale.
 */
export async function isStaleQueuedThread(
  thread: {
    createdAt: Date | string | null;
    queuedAt: Date | null;
    githubRepoFullName: string | null;
    githubPRNumber: number | null;
    githubIssueNumber: number | null;
  },
  now: number = Date.now(),
): Promise<StaleQueuedVerdict> {
  const ageFrom = thread.queuedAt ?? thread.createdAt;
  const ageMs = ageFrom ? now - new Date(ageFrom).getTime() : 0;
  if (ageMs > STALE_QUEUED_AGE_MS) {
    return {
      stale: true,
      kind: "age",
      reason: `queued-age ${Math.round(ageMs / 60000)}m > 60m`,
    };
  }
  // Best-effort closed-source check (App octokit; failure → treat as not-closed).
  const number = thread.githubPRNumber ?? thread.githubIssueNumber ?? null;
  if (!number || !thread.githubRepoFullName) return NOT_STALE;
  try {
    const [owner, repo] = parseRepoFullName(thread.githubRepoFullName);
    const octokit = await getOctokitForApp({ owner, repo });
    const { data } = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: number,
    });
    if (data.state !== "closed") return NOT_STALE;
    if (!thread.queuedAt) {
      return {
        stale: true,
        kind: "closed",
        reason: `source #${number} is closed`,
      };
    }
    const closedAtMs = data.closed_at ? Date.parse(data.closed_at) : NaN;
    // Strictly after: a source closed at (or before) the queue instant was
    // already closed when this run was asked for.
    if (Number.isFinite(closedAtMs) && closedAtMs > thread.queuedAt.getTime()) {
      return {
        stale: true,
        kind: "closed",
        reason: `source #${number} closed at ${data.closed_at} after the run was queued at ${thread.queuedAt.toISOString()}`,
      };
    }
  } catch (err) {
    // can't confirm → don't retire on this signal
    console.warn("[queue] closed-source check failed; not retiring on it", {
      repoFullName: thread.githubRepoFullName,
      number,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return NOT_STALE;
}

/** Why a queued run was retired: a stale-queue rule, or #471's stranded sweep. */
type QueueRetiredKind = "age" | "closed" | "stranded";

/** The ADR-009 notice text for a retired queued review, per retirement rule. */
export function queueRetiredNoticeReason(kind: QueueRetiredKind): string {
  switch (kind) {
    case "closed":
      return "the PR was closed while this review waited in the queue.";
    case "stranded":
      return "this review never started: its dispatch failed before a run was created; push a new commit to re-run.";
    case "age":
      return "this review waited longer than an hour in the queue; push a new commit to re-run.";
  }
}

/**
 * A retired queued REVIEW leaves the PR with no verdict, so it gets the
 * ADR-009 no-verdict notice (cause `queue_retired`) at the head the queued run
 * was dispatched for. Withheld when that head has moved on (a newer run owns
 * HEAD) or a bot review already sits at that commit. Never throws: a failed
 * notice is logged and never blocks the retirement.
 */
async function postQueueRetiredReviewNotice({
  userId,
  threadId,
  thread,
  kind,
}: {
  userId: string;
  threadId: string;
  thread: {
    automationId?: string | null;
    organizationId?: string | null;
    githubRepoFullName?: string | null;
    githubPRNumber?: number | null;
    reviewedSha?: string | null;
  };
  kind: QueueRetiredKind;
}): Promise<void> {
  if (!env.GITHUB_SIDE_EFFECTS_ENABLED) return;
  const repoFullName = thread.githubRepoFullName ?? null;
  const prNumber = thread.githubPRNumber ?? null;
  if (!repoFullName || !prNumber) return;
  const logContext = { threadId, repoFullName, prNumber, kind };
  try {
    const review = await isReviewThread({
      db,
      userId,
      automationId: thread.automationId ?? null,
      organizationId: thread.organizationId ?? null,
    });
    if (!review) return;
    const sha = thread.reviewedSha ?? null;
    if (!sha) {
      console.warn(
        "[queue] retired review has no dispatched sha; notice withheld",
        logContext,
      );
      return;
    }
    const [owner, repo] = parseRepoFullName(repoFullName);
    const octokit = await getOctokitForApp({ owner, repo });
    const { headSha, isClosed } = await getPrHeadState(
      octokit,
      repoFullName,
      prNumber,
    );
    if (kind === "stranded" && isClosed) {
      // A stranded run is found late (it can sit for days); by then its PR
      // may have merged, and a "push to re-run" notice there helps nobody.
      console.warn(
        "[queue] retired review: PR already closed; notice withheld",
        logContext,
      );
      return;
    }
    if (headSha !== sha) {
      console.warn("[queue] retired review: head moved on; notice withheld", {
        ...logContext,
        sha,
        headSha,
      });
      return;
    }
    const github = createOctokitReviewClient(octokit);
    const botLogin = resolveBotLogin();
    const existing = await findAnyBotReviewAtCommit({
      github,
      repo: repoFullName,
      prNumber,
      headSha: sha,
      botLogin,
    });
    if (existing) {
      console.warn(
        "[queue] retired review: a bot review already exists at this commit; notice withheld",
        { ...logContext, sha, reviewId: existing.id },
      );
      return;
    }
    const published = await publishReviewNotice({
      github,
      repoFullName,
      prNumber,
      botLogin,
      sha,
      cause: "queue_retired",
      reason: queueRetiredNoticeReason(kind),
      logger: {
        info: (message, meta) => console.log(`[queue] ${message}`, meta),
        warn: (message, meta) => console.warn(`[queue] ${message}`, meta),
        error: (message, meta) => console.error(`[queue] ${message}`, meta),
      },
    });
    if (published.result === "post_failed") {
      console.error("[queue] retired review: notice post failed", {
        ...logContext,
        sha,
        error: published.failureReason,
      });
      return;
    }
    console.warn("[queue] retired review: no-verdict notice", {
      ...logContext,
      sha,
      result: published.result,
    });
  } catch (err) {
    console.error("[queue] retired review: notice path threw", {
      ...logContext,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The tail every queue retirement shares, once its status and error are
 * written: archive, record the event, and for a review post the ADR-009
 * notice (which never throws).
 */
async function finishQueueRetirement({
  userId,
  threadId,
  threadChatId,
  thread,
  reason,
  kind,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  thread: Parameters<typeof postQueueRetiredReviewNotice>[0]["thread"];
  reason: string;
  kind: QueueRetiredKind;
}): Promise<void> {
  await updateThread({ db, userId, threadId, updates: { archived: true } });
  getPostHogServer().capture({
    distinctId: userId,
    event: "queued_thread_retired",
    properties: { threadId, threadChatId, reason, kind },
  });
  await postQueueRetiredReviewNotice({ userId, threadId, thread, kind });
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

    // #446: a concurrency-queue run ages from when it entered the queue
    // (`queued_at` of whichever row carries the status: the chat row, or the
    // thread row for a legacy thread). A row queued before the column existed
    // falls back to its updated_at as read BEFORE the dequeue bumped it.
    // Other queues keep today's rules (queuedAt null).
    const queuedAt =
      oldStatus === "queued-tasks-concurrency"
        ? (result.queuedAt ??
          result.updatedAt ??
          (thread.createdAt ? new Date(thread.createdAt) : null))
        : null;

    // STALE RETIREMENT: never suddenly execute arbitrarily-old queued work.
    const verdict = await isStaleQueuedThread({
      createdAt: thread.createdAt ?? null,
      queuedAt,
      githubRepoFullName: thread.githubRepoFullName ?? null,
      githubPRNumber: thread.githubPRNumber ?? null,
      githubIssueNumber: thread.githubIssueNumber ?? null,
    });
    if (verdict.stale) {
      const { reason, kind } = verdict;
      console.warn("[queue] RETIRING stale queued thread (archived, not run)", {
        threadId,
        threadChatId,
        reason,
        kind,
      });
      // queued --user.stop--> complete (a valid terminal transition), then
      // archive. The error makes the retirement visible on the task (#446).
      await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId,
        eventType: "user.stop",
        chatUpdates: {
          errorMessage: "queue-retired",
          errorMessageInfo: reason,
        },
      });
      await finishQueueRetirement({
        userId,
        threadId,
        threadChatId,
        thread,
        reason,
        kind,
      });
      continue; // retiring frees no slot — keep draining
    }
    try {
      await ensureThreadChatHasUserMessage({ threadChat });
    } catch (error) {
      // #471: the dequeue already moved the chat to plain `queued`, which no
      // drain reads; end it rather than strand it there.
      await failQueuedDispatch({ db, userId, threadId, threadChatId, error });
      throw error;
    }
    console.log(`Starting queued thread`, {
      threadId,
      threadChatId: threadChat.id,
      previousStatus: oldStatus,
    });
    const queuedFrom = queuedAt ?? thread.createdAt;
    const queuedDurationMs = queuedFrom
      ? Date.now() - new Date(queuedFrom).getTime()
      : 0;
    getPostHogServer().capture({
      distinctId: userId,
      event: "thread_dequeued",
      properties: {
        threadId,
        threadChatId,
        previousStatus: oldStatus,
        queuedDurationMs,
      },
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

/**
 * #471: a chat this long in plain `queued` with no write since is stranded.
 * The state is transient (startAgentMessage leaves it within seconds: the
 * longest built-in pre-boot wait is the multi-model stagger, a few seconds,
 * and a Workers waitUntil does not outlive a few minutes), and both the
 * queue instant AND the row's last write must be this old, so a dispatch in
 * progress is never retired. 30 minutes is far past any of that and well
 * inside the hour after which a queued review is retired anyway.
 */
export const STRANDED_QUEUED_AGE_MS = 30 * 60 * 1000;
/** Bound on the rows one sweep tick retires; the next tick takes the rest. */
const MAX_STRANDED_PER_SWEEP = 50;

/**
 * #471 backstop: retire chats stranded in plain `queued` (see
 * getStrandedQueuedThreadChats). Same visible retirement as a stale queued
 * run: complete + `queue-retired` + archived, and for a review the ADR-009
 * notice at its dispatched head.
 *
 * Retire, never re-dispatch: a re-dispatch from here would start a review
 * outside its webhook admission and the engine's supersession (one review per
 * push), and "at most once" would need a new column to remember the attempt.
 * The notice asks for a push, which re-runs the review through the normal
 * path. Each row is moved by a compare-and-set from `queued`, so a chat that
 * started meanwhile is left alone. One row's failure never stops the sweep.
 */
export async function retireStrandedQueuedThreads({
  now = Date.now(),
}: { now?: number } = {}): Promise<{ retired: number; failed: number }> {
  const stranded = await getStrandedQueuedThreadChats({
    db,
    olderThan: new Date(now - STRANDED_QUEUED_AGE_MS),
    limit: MAX_STRANDED_PER_SWEEP,
  });
  let retired = 0;
  let failed = 0;
  for (const { userId, threadId, threadChatId } of stranded) {
    try {
      const reason = `stranded in queued > ${STRANDED_QUEUED_AGE_MS / 60000}m with no run`;
      // Status and error in one compare-and-set from `queued`.
      const { didUpdateStatus } = await updateThreadChatStatusAtomic({
        db,
        userId,
        threadId,
        threadChatId,
        fromStatus: "queued",
        toStatus: "complete",
        error: { errorMessage: "queue-retired", errorMessageInfo: reason },
      });
      if (!didUpdateStatus) continue;
      console.warn("[queue] RETIRING stranded queued thread (archived)", {
        threadId,
        threadChatId,
        reason,
      });
      const thread = await getThreadMinimal({ db, threadId, userId });
      await finishQueueRetirement({
        userId,
        threadId,
        threadChatId,
        thread: thread ?? {},
        reason,
        kind: "stranded",
      });
      retired++;
    } catch (error) {
      failed++;
      console.error("[queue] stranded queued thread: retirement failed", {
        threadId,
        threadChatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { retired, failed };
}
