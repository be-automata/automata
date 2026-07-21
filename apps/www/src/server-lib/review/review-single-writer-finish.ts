import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import type { DBMessage } from "@terragon/shared/db/db-message";
import { getThreadChat, getThreadMinimal } from "@terragon/shared/model/threads";
import { getAutomation } from "@terragon/shared/model/automations";
import { getPostHogServer } from "@/lib/posthog-server";
import { getOctokitForApp } from "@/lib/github";
import { reconcilePrReviews } from "@/server-lib/reconcile-pr-reviews";
import {
  createOctokitReviewClient,
  getPrHeadSha,
} from "./octokit-review-client";
import { executeReviewFromIntent } from "./execute-review-from-intent";

/**
 * Review-effect dispatch at thread-finish (ADR-036 phase-2). One entry the
 * daemon-event finish hook calls for a terminal PR thread; it routes:
 *   - REVIEW_SINGLE_WRITER on + a review thread → the control-plane executor
 *     (the agent posted nothing; www posts exactly once from the emitted intent),
 *   - otherwise → the interim post-run reconciler (today's behavior).
 * GITHUB_SIDE_EFFECTS_ENABLED gates all of it (a shadow thread never boots, but
 * this guards the global switch regardless).
 */

/** The App bot's review-author login (mirrors reconcile-pr-reviews.resolveBotLogin). */
function resolveBotLogin(): string {
  const explicit = env.GITHUB_BOT_LOGIN.trim();
  return explicit || `${env.NEXT_PUBLIC_GITHUB_APP_NAME}[bot]`;
}

/**
 * A review thread = one dispatched from a `pull_request`-triggered automation
 * (the PR-review path). Mention threads are `github_mention`; those keep the
 * mention-reply path and must NOT run the review executor.
 */
export async function isReviewThread({
  db,
  userId,
  automationId,
  organizationId,
}: {
  db: DB;
  userId: string;
  automationId: string | null;
  organizationId?: string | null;
}): Promise<boolean> {
  if (!automationId) return false;
  const automation = await getAutomation({
    db,
    userId,
    automationId,
    organizationId,
  });
  return automation?.triggerType === "pull_request";
}

/** Concatenate the LAST agent message's text parts — where the emitted intent lives. */
export function extractTerminalAgentText(messages: DBMessage[] | null): string {
  if (!messages) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type === "agent") {
      return m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    }
  }
  return "";
}

export async function handleReviewEffectAtFinish({
  db,
  userId,
  threadId,
  threadChatId,
  repoFullName,
  prNumber,
}: {
  db: DB;
  userId: string;
  threadId: string;
  threadChatId: string;
  repoFullName: string;
  prNumber: number;
}): Promise<void> {
  if (!env.GITHUB_SIDE_EFFECTS_ENABLED) return;

  // Flag off → interim reconciler (unchanged behavior).
  if (!env.REVIEW_SINGLE_WRITER) {
    await reconcilePrReviews({ repoFullName, prNumber });
    return;
  }

  // Single-writer path (flag on). The ENTIRE path — thread lookups + review
  // determination + intent parse + post — is wrapped so ANY unexpected throw
  // (db/octokit/HEAD) degrades to the interim reconciler rather than propagating.
  // This runs in the finish hook alongside the BUG-EXEC-01 queue-drain — a phase-2
  // bug must never regress it. The reconciler ALWAYS runs at the end: the executor's
  // straddle-backstop audit on success, AND the converging fallback for a non-review
  // thread or a mid-fetch throw (nit: the lookups used to sit OUTSIDE the try, so a
  // db blip there skipped the reconciler too).
  try {
    // automationId/organizationId live on the thread; terminal messages on the chat.
    const thread = await getThreadMinimal({ db, userId, threadId });
    const review = thread
      ? await isReviewThread({
          db,
          userId,
          automationId: thread.automationId ?? null,
          organizationId: thread.organizationId ?? null,
        })
      : false;

    // A PR thread that isn't a review (e.g. a mention) → reconciler only (below).
    if (review) {
      const threadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId,
      });
      const octokit = await getOctokitForApp({
        owner: repoFullName.split("/")[0]!,
        repo: repoFullName.split("/")[1]!,
      });
      const github = createOctokitReviewClient(octokit);
      const currentHeadSha = await getPrHeadSha(octokit, repoFullName, prNumber);
      const terminalText = extractTerminalAgentText(threadChat?.messages ?? null);

      const outcome = await executeReviewFromIntent({
        github,
        repoFullName,
        prNumber,
        botLogin: resolveBotLogin(),
        currentHeadSha,
        terminalText,
        logger: {
          info: (message, meta) =>
            console.log(`[review-single-writer] ${message}`, meta),
          warn: (message, meta) =>
            console.warn(`[review-single-writer] ${message}`, meta),
          error: (message, meta) =>
            console.error(`[review-single-writer] ${message}`, meta),
        },
      });

      // Loud telemetry; WorkFailed (degraded/post_failed) pages so a human doesn't
      // mistake a lost verdict for a clean pass.
      getPostHogServer().capture({
        distinctId: userId,
        event: "review_single_writer_outcome",
        properties: { threadId, repoFullName, prNumber, outcome: outcome.outcome },
      });
      if (
        outcome.outcome === "degraded_comment" ||
        outcome.outcome === "post_failed"
      ) {
        console.error(
          "[review-single-writer] WorkFailed — review not cleanly applied",
          { threadId, repoFullName, prNumber, outcome },
        );
        getPostHogServer().capture({
          distinctId: userId,
          event: "review_single_writer_work_failed",
          properties: { threadId, repoFullName, prNumber, ...outcome },
        });
      }
    }
  } catch (err) {
    console.error(
      "[review-single-writer] path threw — falling back to reconciler",
      {
        threadId,
        repoFullName,
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  // Fail-safe audit BEHIND the executor: converge any residue (e.g. a straddling
  // run that agent-posted during a flag-flip skew, or an executor throw above).
  // Idempotent no-op when clean.
  await reconcilePrReviews({ repoFullName, prNumber });
}
