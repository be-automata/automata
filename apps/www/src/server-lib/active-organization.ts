import { headers } from "next/headers";
import { getMembership } from "@terragon/shared/model/organizations";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Make `organizationId` the current session's active org, but only while
 * `userId` is a member of it. Returns false (and leaves the session alone)
 * for a non-member, so a forged or stale id never moves the session.
 *
 * Shared by the org switcher's server action and the `/o/<slug>` link route.
 */
export async function activateOrganizationForUser({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  const membership = await getMembership({ db, organizationId, userId });
  if (!membership) {
    return false;
  }
  await auth.api.setActiveOrganization({
    body: { organizationId },
    headers: await headers(),
  });
  return true;
}
