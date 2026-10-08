"use server";

import { env } from "@terragon/env/apps-www";
import { replaceOrganizationEnvironmentVariables } from "@terragon/shared/model/organization-environment";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { isOrgAdmin } from "@/lib/org-role";
import { getPostHogServer } from "@/lib/posthog-server";
import { UserFacingError } from "@/lib/server-actions";
import {
  EnvironmentVariable,
  validateEnvironmentVariables,
} from "@/server-lib/environment-variables";

/**
 * Replace the ACTIVE org's environment variables. The org always comes from
 * the session, never from the arguments; only the org's owners and admins
 * may write. Logs and analytics carry key names only — never a value.
 */
export const updateOrganizationEnvironmentVariables = userOnlyAction(
  async function updateOrganizationEnvironmentVariables(
    userId: string,
    { variables }: { variables: EnvironmentVariable[] },
  ) {
    const tenant = await getTenantContextOrNull();
    const organizationId = tenant?.organizationId ?? null;
    if (!organizationId) {
      throw new UserFacingError("No active organization");
    }
    if (!(await isOrgAdmin({ db, organizationId, userId }))) {
      throw new UserFacingError(
        "Only organization owners and admins can edit organization variables",
      );
    }
    await validateEnvironmentVariables(variables);
    const diff = await replaceOrganizationEnvironmentVariables({
      db,
      organizationId,
      actorUserId: userId,
      variables,
      encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    });
    console.log("[org-env] updated", {
      organizationId,
      actorUserId: userId,
      ...diff,
    });
    getPostHogServer().capture({
      distinctId: userId,
      event: "update_organization_environment_variables",
      properties: {
        organizationId,
        added: diff.added,
        removed: diff.removed,
        changed: diff.changed,
        variableCount: variables.length,
      },
    });
    return { success: true };
  },
  { defaultErrorMessage: "Failed to update organization variables" },
);
