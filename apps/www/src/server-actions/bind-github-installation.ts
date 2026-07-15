"use server";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { UserFacingError } from "@/lib/server-actions";

/**
 * Registration seam (WI-5): bind a GitHub App installation to the caller's active
 * organization, so GitHub mentions on that installation's repos resolve to the
 * org (see handle-app-mention.ts). Minimal for now — it binds to the active org;
 * an org-admin (member.role) gate and management UI arrive in the GitHub-App
 * phase. Requires an active org.
 */
export const bindGithubInstallation = userOnlyAction(
  async function bindGithubInstallation(
    _userId: string,
    {
      installationId,
      accountLogin,
      accountType,
    }: {
      installationId: string | number;
      accountLogin?: string | null;
      accountType?: string | null;
    },
  ) {
    const tenant = await getTenantContextOrNull();
    if (!tenant?.organizationId) {
      throw new UserFacingError(
        "Select an organization before binding a GitHub installation",
      );
    }
    return await bindGithubInstallationToOrg({
      db,
      installationId,
      organizationId: tenant.organizationId,
      accountLogin,
      accountType,
    });
  },
  { defaultErrorMessage: "Failed to bind GitHub installation" },
);
