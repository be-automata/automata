import { and, eq, inArray, isNotNull, gte, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { thread as threadTable } from "@terragon/shared/db/schema";
import type { ThreadStatus } from "@terragon/shared/db/types";
import { getThreadChat } from "@terragon/shared/model/threads";
import { isAbandonedTerminalCause } from "@terragon/shared/model/terminal-cause";
import { getPostHogServer } from "@/lib/posthog-server";
import { getOctokitForApp } from "@/lib/github";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import { findBotReviewAtHead } from "@terragon/review/state/head-review-guard";
import {
  createOctokitReviewClient,
  getPrHeadSha,
} from "./octokit-review-client";
import { executeReviewFromIntent } from "./execute-review-from-intent";
import {
  extractTerminalAgentText,
  isReviewThread,
} from "./review-single-writer-finish";

/**
 * GAP-1 backstop (ADR-036): the finish-hook single-writer only fires if the thread
 * REACHES thread-finish. A review thread that hung and was force-stopped (the S12
 * stalled-tasks cron does a bare status='complete', NOT a finish-hook transition) —
 * or one whose finish event was dropped in transport — would otherwise be terminal
 * with ZERO review, silently. This periodic sweep is the SECOND idempotent entry to
 * the SAME single writer: it finds terminal PR review-threads that never posted a
 * review and runs executeReviewFromIntent from the PERSISTED intent (real verdict;
 * degraded COMMENT only if absent/malformed). HEAD-guarded, so it never double-posts.
 *
 * GRACE window: only threads terminal for longer than REVIEW_SWEEP_GRACE_MS are
 * considered, so the finish-hook (which completes in seconds) owns the normal path
 * and the sweep can't race it for a just-finished thread. Structural claim: single-
 * writer on the finish-hook path; the sweep fires only past grace for genuinely
 * stalled threads; the HEAD-guard + reconciler backstop the rare residual race.
 */

// Grace comfortably exceeds the finish-hook's worst-case completion (seconds).
const REVIEW_SWEEP_GRACE_MS = 10 * 60 * 1000; // 10 min
// Don't reach back indefinitely — only recently-terminal threads are candidates.
const REVIEW_SWEEP_LOOKBACK_MS = 6 * 60 * 60 * 1000; // 6 h
const TERMINAL_STATUSES: ThreadStatus[] = ["complete", "stopped"];

export async function runReviewSweep(): Promise<void> {
  // The single-writer review channel is unconditional (see handleReviewEffectAtFinish),
  // so its grace-period sweep backstop always runs (still gated on the global
  // GitHub-side-effects switch).
  if (!env.GITHUB_SIDE_EFFECTS_ENABLED) return;

  const now = Date.now();
  const candidates = await db
    .select({
      id: threadTable.id,
      userId: threadTable.userId,
      repoFullName: threadTable.githubRepoFullName,
      prNumber: threadTable.githubPRNumber,
      automationId: threadTable.automationId,
      organizationId: threadTable.organizationId,
      terminalCause: threadTable.terminalCause,
      reviewedSha: threadTable.reviewedSha,
      version: threadTable.version,
    })
    .from(threadTable)
    .where(
      and(
        inArray(threadTable.status, TERMINAL_STATUSES),
        isNotNull(threadTable.githubPRNumber),
        eq(threadTable.archived, false),
        lte(threadTable.updatedAt, new Date(now - REVIEW_SWEEP_GRACE_MS)),
        gte(threadTable.updatedAt, new Date(now - REVIEW_SWEEP_LOOKBACK_MS)),
      ),
    );

  if (candidates.length === 0) return;
  console.log(
    `[review-sweep] ${candidates.length} terminal PR threads in window`,
  );

  for (const c of candidates) {
    if (c.prNumber === null) continue;
    try {
      const review = await isReviewThread({
        db,
        userId: c.userId,
        automationId: c.automationId ?? null,
        organizationId: c.organizationId ?? null,
      });
      if (!review) continue;

      // v0 keeps chat state ON the thread row, so LEGACY_THREAD_CHAT_ID is the
      // correct address for the read below. v1 moves it to threadChat row(s),
      // and WHICH chat carries the verdict is undecided (#153) — reading the
      // thread row would find no messages and, since #150 made the degraded
      // warning conditional, withhold SILENTLY instead of posting. A lost
      // verdict is the worst outcome this module has, so refuse to guess and
      // page instead. Placed before the octokit calls so an unservable thread
      // costs no GitHub API quota. `version` is NOT NULL default 0.
      if (c.version > 0) {
        console.error(
          "[review-sweep] cannot address chat state for a v1 thread — skipped",
          {
            threadId: c.id,
            version: c.version,
            repoFullName: c.repoFullName,
            prNumber: c.prNumber,
          },
        );
        continue;
      }

      const octokit = await getOctokitForApp({
        owner: c.repoFullName.split("/")[0]!,
        repo: c.repoFullName.split("/")[1]!,
      });
      const github = createOctokitReviewClient(octokit);
      const currentHeadSha = await getPrHeadSha(
        octokit,
        c.repoFullName,
        c.prNumber,
      );

      // Already has a bot review at HEAD → the finish-hook handled it; skip.
      const existing = await findBotReviewAtHead({
        github,
        repo: c.repoFullName,
        prNumber: c.prNumber,
        headSha: currentHeadSha,
        botLogin: resolveBotLogin(),
      });
      if (existing) continue;

      const threadChat = await getThreadChat({
        db,
        threadId: c.id,
        threadChatId: LEGACY_THREAD_CHAT_ID,
        userId: c.userId,
      });
      const terminalText = extractTerminalAgentText(
        threadChat?.messages ?? null,
      );

      const outcome = await executeReviewFromIntent({
        github,
        repoFullName: c.repoFullName,
        prNumber: c.prNumber,
        botLogin: resolveBotLogin(),
        currentHeadSha,
        terminalText,
        // Both flags gate the DEGRADED warning ONLY — never a verdict. An
        // abandoned run (#125 C4 typed terminal) is deliberately still swept
        // rather than skipped outright: supersession marks a thread terminal
        // concurrently with cancellation, so a run that already persisted a
        // real verdict can be stamped `superseded` before its finish hook
        // posts, and the generation fence then rejects that late write. This
        // sweep is the only thing left that can recover that verdict, so it
        // must still read the run's output — it just won't invent a warning
        // out of the run's silence.
        reviewedSha: c.reviewedSha,
        runAbandoned: isAbandonedTerminalCause(c.terminalCause),
      });
      console.log("[review-sweep] backstopped a terminal review thread", {
        threadId: c.id,
        repoFullName: c.repoFullName,
        prNumber: c.prNumber,
        outcome: outcome.outcome,
      });
      getPostHogServer().capture({
        distinctId: c.userId,
        event: "review_sweep_backstop",
        properties: {
          threadId: c.id,
          repoFullName: c.repoFullName,
          prNumber: c.prNumber,
          outcome: outcome.outcome,
        },
      });
    } catch (err) {
      // Per-thread fail-soft: one bad candidate never aborts the sweep.
      console.error("[review-sweep] candidate failed (continuing)", {
        threadId: c.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function resolveBotLogin(): string {
  const explicit = env.GITHUB_BOT_LOGIN.trim();
  return explicit || `${env.NEXT_PUBLIC_GITHUB_APP_NAME}[bot]`;
}
