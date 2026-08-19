import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import type { DBMessage } from "@terragon/shared/db/db-message";
import {
  getThreadChat,
  getThreadMinimal,
} from "@terragon/shared/model/threads";
import { getAutomation } from "@terragon/shared/model/automations";
import { promoteLastKnownGood } from "@terragon/shared/model/repo-skills";
import type { ThreadSourceMetadata } from "@terragon/shared";
import { getPostHogServer } from "@/lib/posthog-server";
import { getOctokitForApp } from "@/lib/github";
import { reconcilePrReviews } from "@/server-lib/reconcile-pr-reviews";
import {
  createOctokitReviewClient,
  getPrHeadState,
} from "./octokit-review-client";
import { executeReviewFromIntent } from "./execute-review-from-intent";
import { resolveApproveFloor } from "./resolve-approve-floor";

/**
 * Review-effect dispatch at thread-finish (ADR-036). One entry the daemon-event
 * finish hook calls for a terminal PR thread:
 *   - a review thread (pull_request automation) → the control-plane executor posts
 *     exactly once from the agent's emitted intent (the agent has no gh-write
 *     outlet), with the per-repo tolerance floor applied — unconditional
 *     single-writer (the retired REVIEW_SINGLE_WRITER flag no longer gates this),
 *   - any PR thread → the post-run reconciler runs at the end as the backstop.
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

/**
 * Promote the skill version a thread ran with to `lastKnownGoodVersionId` —
 * but ONLY after a demonstrably healthy run: outcome "posted" (a clean review
 * from a parsed intent). This is what keeps the resolver's fallback tier
 * (issue #54) pointing at a body that has actually worked in production.
 * Stale/degraded/skipped outcomes prove nothing about the skill body, so they
 * promote nothing. Best-effort by design: a promotion failure must never
 * disturb the finish hook (the review already posted), so errors are logged
 * and swallowed.
 */
export async function maybePromoteSkillLastKnownGood({
  db,
  organizationId,
  repoFullName,
  sourceMetadata,
  outcome,
}: {
  db: DB;
  organizationId: string | null | undefined;
  repoFullName: string;
  sourceMetadata: ThreadSourceMetadata | null | undefined;
  outcome: string;
}): Promise<void> {
  if (outcome !== "posted") return;
  if (sourceMetadata?.type !== "automation-skill") return;
  // Every resolver tier now serves a version row, but legacy stamps (and
  // org-less threads) may lack one — nothing to promote then.
  if (!sourceMetadata.versionId || !organizationId) return;
  try {
    await promoteLastKnownGood({
      db,
      organizationId,
      repoFullName,
      skillName: sourceMetadata.skillName,
      versionId: sourceMetadata.versionId,
    });
  } catch (err) {
    console.error(
      "[review-single-writer] promoteLastKnownGood failed (non-fatal)",
      {
        repoFullName,
        skillName: sourceMetadata.skillName,
        versionId: sourceMetadata.versionId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
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

  // The review channel is UNCONDITIONALLY single-writer (ADR-036): the review
  // agent emits its verdict as a fenced-JSON intent (the deployed skill is
  // emit-only in every mode) and the control plane posts it here, exactly once,
  // with the per-repo tolerance floor applied. The old REVIEW_SINGLE_WRITER=false
  // path (agent posts directly via gh + reconciler dedup) is retired: it was
  // unwired once the skill went emit-only — the agent emitted but nothing parsed
  // or posted the intent, so no review landed. Making this unconditional is a
  // no-op in prod (already single-writer) and makes the tolerance reach GitHub
  // regardless of the vestigial flag. The reconciler still runs at the end as the
  // straddle-backstop (and the converging fallback for a non-review thread or a
  // mid-fetch throw).
  //
  // The ENTIRE path — thread lookups + review determination + intent parse + post
  // — is wrapped so ANY unexpected throw (db/octokit/HEAD) degrades to the
  // reconciler rather than propagating.
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
      const { headSha: currentHeadSha, isDraft } = await getPrHeadState(
        octokit,
        repoFullName,
        prNumber,
      );
      const terminalText = extractTerminalAgentText(
        threadChat?.messages ?? null,
      );

      // Resolve ONE approve-floor snapshot for this run, fenced to the thread's
      // org (ADR-036 review floor). Read live from Neon — a dashboard change
      // takes effect on the next review with no restart.
      const approveFloorPolicy = await resolveApproveFloor({
        db,
        organizationId: thread?.organizationId ?? null,
        repoFullName,
      });

      const outcome = await executeReviewFromIntent({
        github,
        repoFullName,
        prNumber,
        botLogin: resolveBotLogin(),
        currentHeadSha,
        terminalText,
        approveFloorPolicy,
        isDraft,
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
        properties: {
          threadId,
          repoFullName,
          prNumber,
          outcome: outcome.outcome,
        },
      });
      // A clean post is THE health signal for the skill body the thread ran
      // with (issue #54): promote it to last-known-good so the resolver's
      // fallback tier only ever serves text that has worked in production.
      await maybePromoteSkillLastKnownGood({
        db,
        organizationId: thread?.organizationId ?? null,
        repoFullName,
        sourceMetadata: thread?.sourceMetadata ?? null,
        outcome: outcome.outcome,
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
