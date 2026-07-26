import type { DB } from "@terragon/shared/db";
import { getOrganizationsForUser } from "@terragon/shared/model/organizations";

/**
 * Better Auth session.create.before hook body: default activeOrganizationId
 * from the user's org membership so org-gated surfaces (review settings,
 * environments, …) work without an explicit organization.setActive call.
 * Deterministic: sole membership → that org; multiple → oldest-created
 * (getOrganizationsForUser orders by organization.createdAt); none → leave
 * unset. Fail-open: a resolver error must never block sign-in.
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
    const activeOrganizationId = orgs[0]?.id;
    if (!activeOrganizationId) {
      return;
    }
    return { data: { ...session, activeOrganizationId } };
  } catch (error) {
    console.error("[active-org] failed to resolve default org", error);
    return;
  }
}
