import type { DB } from "@terragon/shared/db";
import { getRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";
import { resolveApproveFloorPolicy } from "@terragon/review/settings/review-floor-resolver";
import type { ApproveSeverityPolicy } from "@terragon/review/severity-policy";

/**
 * Resolve the ONE approve-severity-floor policy snapshot for a single review
 * run (ADR-036 review floor). Called once per dispatch in the finish hook and
 * threaded into the executor, so schema and gate can never diverge mid-run.
 *
 * Precedence (via the pure `resolveApproveFloorPolicy`): stored per-repo row for
 * this org > locked default. The Neon row is read LIVE, so a dashboard change
 * takes effect on the next dispatched review without a restart.
 *
 * A thread with no organization (a pre-tenant-fence legacy thread) cannot carry
 * a per-repo override — it resolves to the locked default, exactly today's
 * behavior, never another org's setting.
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
    return resolveApproveFloorPolicy(undefined);
  }
  const setting = await getRepoReviewSetting({
    db,
    organizationId,
    repoFullName,
  });
  return resolveApproveFloorPolicy(
    setting ? { blockTolerance: setting.blockTolerance } : undefined,
  );
}
