import type { DB } from "@terragon/shared/db";
import { getRepoReviewSettingWithOrgDefault } from "@terragon/shared/model/repo-review-settings";

/**
 * Whether Automata should engage a DRAFT pull request for this repo, resolved at
 * webhook intake. Precedence:
 *
 *   per-repo dashboard row  >  org-default sentinel row ('*')  >
 *   automation trigger config (legacy)  >  default TRUE
 *
 * The system default is TRUE — Automata works on draft PRs by default; an
 * operator opts out per repo or org-wide via the dashboard (or, legacy, an
 * automation's `includeDraftPRs` filter). Read live from Neon, so a dashboard
 * change applies to the next webhook with no restart.
 *
 * `reviewDraftPrs` is TRI-STATE: NULL means "no choice at this scope" and the
 * resolution falls through — so a row created by another family (e.g. a
 * supersede-only sentinel) no longer pins drafts. Explicit true/false wins at
 * its tier.
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
    const { repo, orgDefault } = await getRepoReviewSettingWithOrgDefault({
      db,
      organizationId,
      repoFullName,
    });
    if (repo?.reviewDraftPrs != null) return repo.reviewDraftPrs;
    if (orgDefault?.reviewDraftPrs != null) return orgDefault.reviewDraftPrs;
  }
  return automationIncludeDraftPrs ?? true;
}
