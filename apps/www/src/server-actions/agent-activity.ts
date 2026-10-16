"use server";

import {
  getOrgAgentActivity,
  type OrgAgentActivity,
} from "@terragon/shared/model/agent-activity";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { createRepoAccessChecker } from "@/server-lib/repo-access";

const NO_ACTIVITY: OrgAgentActivity = {
  needsYou: [],
  active: [],
  recent: [],
  counts: { running: 0, waiting: 0, needsYou: 0 },
};

/**
 * What every agent in the session's active org is doing. The org comes from
 * the session (membership-checked in getTenantContextOrNull), never from the
 * client.
 */
export const getAgentActivity = userOnlyAction(
  async function getAgentActivity(
    userId: string,
    { mineOnly, peopleOnly }: { mineOnly: boolean; peopleOnly: boolean },
  ): Promise<OrgAgentActivity> {
    const tenant = await getTenantContextOrNull();
    if (!tenant?.organizationId) {
      return NO_ACTIVITY;
    }
    return getOrgAgentActivity({
      db,
      organizationId: tenant.organizationId,
      viewerUserId: userId,
      mineOnly,
      peopleOnly,
      hasRepoAccess: createRepoAccessChecker(userId, { cache: true }),
    });
  },
  { defaultErrorMessage: "Failed to load agent activity" },
);
