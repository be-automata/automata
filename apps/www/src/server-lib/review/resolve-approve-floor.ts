import type { DB } from "@terragon/shared/db";
import { getRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";
import { getOrganizationReviewSetting } from "@terragon/shared/model/organization-review-settings";
import { resolveComposedFloorPolicy } from "@terragon/review/settings/review-floor-resolver";
import type { ApproveSeverityPolicy } from "@terragon/review/severity-policy";

/**
 * Resolve the ONE approve-severity-floor policy snapshot for a single review
 * run (ADR-036 review floor, composed with the ADR-005 org floor). Called once
 * per dispatch in the finish hook and threaded into the executor, so schema
 * and gate can never diverge mid-run. This is the ONE chokepoint both external-PR
 * enforcement points (`computeReviewToleranceDirective` and the finish-hook
 * backstop) call, so the org floor composed here structurally covers both and
 * they can never disagree (epic #70 / issue #73).
 *
 * Precedence (via `resolveComposedFloorPolicy`): org floor tightens the result
 * of — stored per-repo row for this org > env-derived policy > locked default.
 * An absent or invalid org row leaves the repo-tier result unchanged (identity
 * edge). Both the org row and the repo row are read LIVE on every call — no
 * caching or memoization — so a dashboard change takes effect on the next
 * dispatched review without a restart.
 *
 * A thread with no organization (a pre-tenant-fence legacy thread) cannot carry
 * a per-repo OR org override — it resolves to the locked default, exactly
 * today's behavior, never another org's setting, and never touches the DB.
 */
export async function resolveApproveFloor({
  db,
  organizationId,
  repoFullName,
}: {
  db: DB;
  organizationId: string | null | undefined;
  repoFullName: string;
}): Promise<ApproveSeverityPolicy> {
  if (!organizationId) {
    return resolveComposedFloorPolicy(undefined, undefined);
  }
  const [orgSetting, repoSetting] = await Promise.all([
    getOrganizationReviewSetting({ db, organizationId }),
    getRepoReviewSetting({ db, organizationId, repoFullName }),
  ]);
  return resolveComposedFloorPolicy(
    orgSetting?.blockTolerance
      ? { blockTolerance: orgSetting.blockTolerance }
      : undefined,
    repoSetting ? { blockTolerance: repoSetting.blockTolerance } : undefined,
  );
}
