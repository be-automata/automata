import type { ReviewLogger } from "@terragon/review/state/review-github-client";
import type { ReviewThreadClient } from "./octokit-review-client";

/**
 * The terminal writer's thread resolutions (the legacy `emit_resolve_thread`
 * effect, ported). The agent names, in its final intent, each prior review
 * thread it verified addressed; the control plane replies once and resolves
 * the thread. The agent itself never touches GitHub.
 *
 * Exactly once, by two layers:
 *   - a claim per (thread, commit) — two executions racing for the same
 *     verdict resolve once;
 *   - a hidden marker on each reply — a later execution that won a fresh claim
 *     (the lease expired) sees the reply already there and skips it.
 * Best effort: a failure is logged per id and never changes the review
 * outcome. A resolution lost here heals on the next push: that review's
 * `<review_threads>` still lists the thread, and the agent resolves it again.
 */

export interface ThreadResolution {
  inlineCommentId: number;
  reply: string;
}

/** The most resolutions one intent may carry (the schema enforces it too). */
export const MAX_THREAD_RESOLUTIONS = 50;

/** Each GitHub call gets this long; 50 × (lookup + reply + resolve) fits the lease. */
export const THREAD_RESOLUTION_CALL_TIMEOUT_MS = 10_000;

/** The claim lease: longer than the worst case of 50 resolutions. */
export const THREAD_RESOLUTION_CLAIM_TTL_SECONDS = 1800;

export function threadResolutionMarker(
  commit: string,
  commentId: number,
): string {
  return `<!-- automata:resolve sha=${commit} comment=${commentId} -->`;
}

export function threadResolutionClaimKey(
  threadId: string,
  commit: string,
): string {
  return `review-resolve:${threadId}:${commit}`;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ThreadResolutionTally {
  claimed: boolean;
  replied: number;
  resolved: number;
  skipped: number;
  failed: number;
}

export async function applyThreadResolutions({
  client,
  claim,
  prNumber,
  commit,
  resolutions,
  logger,
  callTimeoutMs = THREAD_RESOLUTION_CALL_TIMEOUT_MS,
}: {
  client: ReviewThreadClient;
  /** Take the (thread, commit) claim; false = another execution holds it. */
  claim: () => Promise<boolean>;
  prNumber: number;
  /** The commit the review was posted at (the intent's `commit`). */
  commit: string;
  resolutions: readonly ThreadResolution[];
  logger?: ReviewLogger;
  callTimeoutMs?: number;
}): Promise<ThreadResolutionTally> {
  const tally: ThreadResolutionTally = {
    claimed: false,
    replied: 0,
    resolved: 0,
    skipped: 0,
    failed: 0,
  };
  if (resolutions.length === 0) return tally;
  if (!(await claim())) {
    logger?.info("thread-resolutions: claim held elsewhere; skipping", {
      prNumber,
      commit,
    });
    return tally;
  }
  tally.claimed = true;

  for (const entry of resolutions.slice(0, MAX_THREAD_RESOLUTIONS)) {
    const commentId = entry.inlineCommentId;
    try {
      const thread = await withTimeout(
        client.findThreadByCommentId(prNumber, commentId),
        callTimeoutMs,
      );
      if (!thread) {
        tally.skipped++;
        logger?.warn(
          "thread-resolutions: no thread on this PR has that comment",
          {
            prNumber,
            commentId,
          },
        );
        continue;
      }
      if (thread.isResolved) {
        tally.skipped++;
        continue;
      }
      const marker = threadResolutionMarker(commit, commentId);
      if (thread.commentBodies.some((body) => body.includes(marker))) {
        tally.skipped++;
      } else {
        await withTimeout(
          client.replyToReviewComment(
            prNumber,
            commentId,
            `${entry.reply.trim()}\n\n${marker}`,
          ),
          callTimeoutMs,
        );
        tally.replied++;
      }
      await withTimeout(client.resolveThread(thread.threadId), callTimeoutMs);
      tally.resolved++;
    } catch (err) {
      tally.failed++;
      logger?.warn("thread-resolutions: resolution failed (best-effort)", {
        prNumber,
        commentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger?.info("thread-resolutions: done", { prNumber, commit, ...tally });
  return tally;
}
