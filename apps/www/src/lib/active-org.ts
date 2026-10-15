import type { DB } from "@terragon/shared/db";
import { getOrganizationsForUser } from "@terragon/shared/model/organizations";

import { isPersonalOrganization } from "@/lib/org-identity";

/**
 * Better Auth session.create.before hook body: default activeOrganizationId
 * from the user's org membership so org-gated surfaces (review settings,
 * environments, …) work without an explicit organization.setActive call.
 * Deterministic: sole membership → that org; multiple → the oldest-created
 * TEAM org (a user who joined a team lands in it, not in their personal
 * workspace), falling back to the oldest personal org when they have no team
 * (getOrganizationsForUser orders by organization.createdAt, then id); none →
 * leave unset. Fail-open: a resolver error must never block sign-in.
 */
export async function withDefaultActiveOrganization<
  TSession extends { userId: string; activeOrganizationId?: string | null },
>({
  db,
  session,
}: {
  db: DB;
  session: TSession;
}): Promise<{ data: TSession } | undefined> {
  if (session.activeOrganizationId) {
    return; // respect an explicit setActive
  }
  try {
    const orgs = await getOrganizationsForUser({ db, userId: session.userId });
    const activeOrganizationId = (
      orgs.find((org) => !isPersonalOrganization(org)) ?? orgs[0]
    )?.id;
    if (!activeOrganizationId) {
      return;
    }
    return { data: { ...session, activeOrganizationId } };
  } catch (error) {
    console.error("[active-org] failed to resolve default org", error);
    return;
  }
}
