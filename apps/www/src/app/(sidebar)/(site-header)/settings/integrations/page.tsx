import { IntegrationsSettings } from "@/components/settings/tab/integrations";
import {
  getActiveOrganizationMembershipOrNull,
  getUserIdOrRedirect,
} from "@/lib/auth-server";
import { db } from "@/lib/db";
import { ORG_ADMIN_ROLES } from "@/lib/org-role";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import {
  describeSlackAppConfig,
  resolveSlackAppConfig,
  slackRequestUrlPath,
} from "@/server-lib/slack-config";
import { getSlackAccounts } from "@terragon/shared/model/slack";
import { getOrganizationById } from "@terragon/shared/model/organizations";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Integrations Settings | Terragon",
};

export default async function IntegrationsSettingsPage() {
  const userId = await getUserIdOrRedirect();
  const [slackAccounts, membership] = await Promise.all([
    getSlackAccounts({ db, userId }),
    getActiveOrganizationMembershipOrNull(userId),
  ]);
  const organizationId = membership?.organizationId ?? null;
  const [slackApp, organization] = await Promise.all([
    resolveSlackAppConfig({ db, organizationId }),
    organizationId
      ? getOrganizationById({ db, organizationId })
      : Promise.resolve(undefined),
  ]);
  const appUrl = nonLocalhostPublicAppUrl();
  const isOrganizationAdmin =
    !!membership && ORG_ADMIN_ROLES.has(membership.role);

  return (
    <IntegrationsSettings
      slackAccounts={slackAccounts}
      canBindGithubInstallations={isOrganizationAdmin}
      slackAppSetup={{
        // Key names and presence only: no value leaves the server.
        status: describeSlackAppConfig(slackApp),
        organizationName: organization?.name ?? null,
        canEditOrganization: isOrganizationAdmin,
        requestUrl: `${appUrl}${slackRequestUrlPath(slackApp)}`,
        redirectUrl: `${appUrl}/api/auth/slack/callback`,
      }}
    />
  );
}
