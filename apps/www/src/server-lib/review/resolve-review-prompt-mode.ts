import type { DB } from "@terragon/shared/db";
import type { ThreadTrustContext } from "@terragon/shared/db/types";

import { resolveReviewAgentForDispatch } from "./resolve-review-agent";
import type { ReviewPromptMode } from "./review-skill";

const CLASSIC_PROMPT: ReviewPromptMode = { mode: "classic", runTests: false };

/**
 * The review mode a PR-review thread's PROMPT is rendered with (phase 6).
 *
 * Uses the SAME Phase 4 resolver dispatch uses, with the thread's trust
 * snapshot, so `runTests` carries the fork / untrusted-author downgrade and
 * the prompt can never offer test execution the gate would refuse.
 *
 * Not silent degradation: on an invalid stored value only the PROMPT falls
 * back to classic. Dispatch re-resolves the same rows and THROWS (the run
 * fails loudly and its daemon token is revoked), so a corrupt setting never
 * runs quietly. The log is a fixed string plus the org and repo — never the
 * resolver's message, which embeds the stored value.
 *
 * Render time and dispatch time can disagree when the settings flip in
 * between. Both combinations are safe: the classic argv denies `Agent`, so an
 * orchestrated prompt there degrades to a single-agent review, and an
 * orchestrated argv with a classic prompt is a plain review.
 */
export async function resolveReviewPromptMode({
  db,
  organizationId,
  repoFullName,
  trustContext,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  trustContext: ThreadTrustContext | null;
}): Promise<ReviewPromptMode> {
  try {
    const dispatch = await resolveReviewAgentForDispatch({
      db,
      organizationId,
      repoFullName,
      trustContext,
    });
    // Assigning ReviewMode into the local literal union is the compile-time
    // drift check: a third mode fails tsc here.
    const prompt: ReviewPromptMode = {
      mode: dispatch.mode,
      runTests: dispatch.runTests,
    };
    return prompt;
  } catch {
    console.error(
      organizationId,
      repoFullName,
      "invalid review-agent setting; rendering classic prompt",
    );
    return CLASSIC_PROMPT;
  }
}
