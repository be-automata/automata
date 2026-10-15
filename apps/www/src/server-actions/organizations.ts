"use server";

import { getOrganizationsForUser } from "@terragon/shared/model/organizations";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { isPersonalOrganizationSlug } from "@/lib/org-identity";
import { UserFacingError } from "@/lib/server-actions";
import { activateOrganizationForUser } from "@/server-lib/active-organization";

export interface MyOrganization {
  id: string;
  name: string;
  slug: string | null;
  logo: string | null;
  isPersonal: boolean;
}

export interface MyOrganizations {
  organizations: MyOrganization[];
  /** The session's active org, only while the user is still a member of it. */
  activeOrganizationId: string | null;
}

/** The orgs the user belongs to, personal first, and which one is active. */
export const getMyOrganizations = userOnlyAction(
  async function getMyOrganizations(userId: string): Promise<MyOrganizations> {
    const [rows, tenant] = await Promise.all([
      getOrganizationsForUser({ db, userId }),
      getTenantContextOrNull(),
    ]);
    const organizations = rows
      .map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug ?? null,
        logo: row.logo ?? null,
        isPersonal: isPersonalOrganizationSlug(row.slug ?? null),
      }))
      .sort((a, b) => Number(b.isPersonal) - Number(a.isPersonal));
    const activeId = tenant?.organizationId ?? null;
    return {
      organizations,
      activeOrganizationId: organizations.some((org) => org.id === activeId)
        ? activeId
        : null,
    };
  },
  { defaultErrorMessage: "Failed to load your organizations" },
);

/**
 * Make `organizationId` the session's active org. Membership is checked here
 * (and again by Better Auth) so a forged id never moves the session.
 */
export const switchActiveOrganization = userOnlyAction(
  async function switchActiveOrganization(
    userId: string,
    { organizationId }: { organizationId: string },
  ): Promise<void> {
    const activated = await activateOrganizationForUser({
      userId,
      organizationId,
    });
    if (!activated) {
      throw new UserFacingError("You are not a member of that organization");
    }
  },
  { defaultErrorMessage: "Failed to switch organization" },
);
