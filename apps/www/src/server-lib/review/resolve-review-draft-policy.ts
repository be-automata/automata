import type { DB } from "@terragon/shared/db";
import { getRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";

/**
 * Whether Automata should engage a DRAFT pull request for this repo, resolved at
 * webhook intake. Precedence:
 *
 *   per-repo dashboard setting (explicit)  >  automation trigger config  >  default TRUE
 *
 * The system default is TRUE — Automata works on draft PRs by default; an
 * operator opts a repo OUT via the dashboard (or, legacy, an automation's
 * `includeDraftPRs` filter). Read live from Neon, so a dashboard change applies
 * to the next webhook with no restart.
 */
export async function resolveReviewDraftPolicy({
  db,
  organizationId,
  repoFullName,
  automationIncludeDraftPrs,
}: {
  db: DB;
  organizationId: string | null | undefined;
  repoFullName: string;
  /** The automation's own `filter.includeDraftPRs` (legacy per-automation opt-in). */
  automationIncludeDraftPrs?: boolean;
}): Promise<boolean> {
  if (organizationId) {
    const setting = await getRepoReviewSetting({
      db,
      organizationId,
      repoFullName,
    });
    if (setting) return setting.reviewDraftPrs;
  }
  return automationIncludeDraftPrs ?? true;
}
