import { headers } from "next/headers";
import {
  getMembership,
  getMembershipByOrganizationSlug,
} from "@terragon/shared/model/organizations";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Make `organizationId` the current session's active org, but only while
 * `userId` is a member of it. Returns false (and leaves the session alone)
 * for a non-member, so a forged or stale id never moves the session.
 *
 * The org switcher's server action.
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
  await setSessionActiveOrganization(organizationId);
  return true;
}

/**
 * The `/o/<slug>` link's switch: one member⋈organization read, then Better
 * Auth. Returns false (and leaves the session alone) when the slug is unknown
 * or `userId` is not a member — the two are deliberately indistinguishable.
 */
export async function activateOrganizationBySlugForUser({
  userId,
  slug,
}: {
  userId: string;
  slug: string;
}): Promise<boolean> {
  const membership = await getMembershipByOrganizationSlug({
    db,
    slug,
    userId,
  });
  if (!membership) {
    return false;
  }
  await setSessionActiveOrganization(membership.organizationId);
  return true;
}

async function setSessionActiveOrganization(
  organizationId: string,
): Promise<void> {
  await auth.api.setActiveOrganization({
    body: { organizationId },
    headers: await headers(),
  });
}
