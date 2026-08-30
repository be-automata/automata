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
 * Deliberate semantics (no-migration decision, 2026-08-30): `reviewDraftPrs`
 * is NOT NULL DEFAULT true, so a row that exists for ANY family carries an
 * authoritative draft value — implicit true counts as a choice. That is
 * already the shipped behaviour at the repo tier; the org tier matches it.
 * The one observable shift: an org whose sentinel row was created by the
 * supersede UI now beats a legacy `includeDraftPRs: false` filter (dashboard
 * over legacy — the sanctioned direction, self-serviced by the toggle).
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
    if (repo) return repo.reviewDraftPrs;
    if (orgDefault) return orgDefault.reviewDraftPrs;
  }
  return automationIncludeDraftPrs ?? true;
}
