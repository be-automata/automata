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
 * `reviewDraftPrs` is NOT NULL DEFAULT true, so a row created by ANY family
 * (e.g. supersede-only) carries an authoritative draft value — it beats a
 * legacy `includeDraftPRs: false`. Decision narrative + rewrite instruction
 * live in the PINS test in resolve-review-draft-policy.test.ts.
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
