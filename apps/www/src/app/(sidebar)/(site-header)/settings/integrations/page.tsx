import { IntegrationsSettings } from "@/components/settings/tab/integrations";
import { getTenantContextOrNull, getUserIdOrRedirect } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { isOrgAdmin } from "@/lib/org-role";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import {
  describeSlackAppConfig,
  resolveSlackAppConfig,
  slackRequestUrlPath,
} from "@/server-lib/slack-config";
import { getSlackAccounts } from "@terragon/shared/model/slack";
import {
  getMembership,
  getOrganizationById,
} from "@terragon/shared/model/organizations";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Integrations Settings | Terragon",
};

export default async function IntegrationsSettingsPage() {
  const userId = await getUserIdOrRedirect();
  const tenant = await getTenantContextOrNull();
  const activeOrganizationId = tenant?.organizationId ?? null;
  const membership = activeOrganizationId
    ? await getMembership({ db, organizationId: activeOrganizationId, userId })
    : undefined;
  const organizationId = membership ? activeOrganizationId : null;

  const [slackAccounts, slackApp, organization, canEditOrganization] =
    await Promise.all([
      getSlackAccounts({ db, userId }),
      resolveSlackAppConfig({ db, organizationId }),
      organizationId
        ? getOrganizationById({ db, organizationId })
        : Promise.resolve(undefined),
      organizationId
        ? isOrgAdmin({ db, organizationId, userId })
        : Promise.resolve(false),
    ]);
  const appUrl = nonLocalhostPublicAppUrl();

  return (
    <IntegrationsSettings
      slackAccounts={slackAccounts}
      slackAppSetup={{
        // Key names and presence only: no value leaves the server.
        status: describeSlackAppConfig(slackApp),
        organizationName: organization?.name ?? null,
        canEditOrganization,
        requestUrl: `${appUrl}${slackRequestUrlPath(slackApp)}`,
        redirectUrl: `${appUrl}/api/auth/slack/callback`,
      }}
    />
  );
}
