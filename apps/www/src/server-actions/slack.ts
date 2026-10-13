"use server";

import { env } from "@terragon/env/apps-www";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import {
  getActiveOrganizationMembershipOrNull,
  userOnlyAction,
} from "@/lib/auth-server";
import { db } from "@/lib/db";
import { ORG_ADMIN_ROLES } from "@/lib/org-role";
import { UserFacingError } from "@/lib/server-actions";
import {
  deleteSlackAccount,
  upsertSlackSettings,
} from "@terragon/shared/model/slack";
import { encryptValue } from "@terragon/utils/encryption";
import { SlackSettingsInsert } from "@terragon/shared/db/types";
import { resolveSlackAppConfig } from "@/server-lib/slack-config";

const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "users:read",
  "users:read.email",
  "channels:history",
  "files:read",
  "files:write",
  "groups:history",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "reactions:read",
  "reactions:write",
  "team:read",
  "channels:read",
  "groups:read",
  "mpim:read",
];
const SLACK_OPENID_SCOPES = ["openid", "profile", "email"];

/**
 * The client ID of the session's active org's Slack app (the platform app
 * without one), and that org. The org always comes from the session, never
 * the arguments. `requireAdmin`: installing binds the workspace to the org,
 * an org-governance action, so it is checked before any secret is read.
 */
async function getSessionSlackApp(
  userId: string,
  { requireAdmin }: { requireAdmin: boolean },
): Promise<{ organizationId: string | null; clientId: string }> {
  const membership = await getActiveOrganizationMembershipOrNull(userId);
  if (requireAdmin && membership && !ORG_ADMIN_ROLES.has(membership.role)) {
    throw new UserFacingError(
      "Only organization owners and admins can install the Slack app",
    );
  }
  const organizationId = membership?.organizationId ?? null;
  const config = await resolveSlackAppConfig({ db, organizationId });
  if (!config.clientId) {
    throw new UserFacingError(
      config.source === "organization"
        ? "Slack is not configured for this organization: set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET on the organization environment"
        : "Slack is not configured: an organization admin can set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET on the organization environment",
    );
  }
  return { organizationId, clientId: config.clientId };
}

function encryptSlackOAuthState(state: {
  userId: string;
  organizationId: string | null;
  type: "app_install" | "openid";
}): string {
  return encryptValue(
    JSON.stringify({ ...state, timestamp: Date.now() }),
    env.ENCRYPTION_MASTER_KEY,
  );
}

// Used to install the Slack app
export const getSlackAppInstallUrl = userOnlyAction(
  async function getSlackAppInstallUrl(userId: string): Promise<string> {
    const { organizationId, clientId } = await getSessionSlackApp(userId, {
      requireAdmin: true,
    });
    const redirectUri = `${nonLocalhostPublicAppUrl()}/api/auth/slack/callback`;
    const scopes = SLACK_BOT_SCOPES.join(",");
    const slackAuthUrl = new URL("https://slack.com/oauth/v2/authorize");
    slackAuthUrl.searchParams.set("client_id", clientId);
    slackAuthUrl.searchParams.set("scope", scopes);
    slackAuthUrl.searchParams.set("redirect_uri", redirectUri);
    slackAuthUrl.searchParams.set(
      "state",
      encryptSlackOAuthState({ userId, organizationId, type: "app_install" }),
    );
    return slackAuthUrl.toString();
  },
  { defaultErrorMessage: "Failed to get Slack app install URL" },
);

// Used to connect to a users
export const getSlackOAuthUrl = userOnlyAction(
  async function getSlackOAuthUrl(userId: string): Promise<string> {
    const { organizationId, clientId } = await getSessionSlackApp(userId, {
      requireAdmin: false,
    });
    const redirectUri = `${nonLocalhostPublicAppUrl()}/api/auth/slack/callback`;
    const slackAuthUrl = new URL("https://slack.com/openid/connect/authorize");
    slackAuthUrl.searchParams.set("client_id", clientId);
    slackAuthUrl.searchParams.set("scope", SLACK_OPENID_SCOPES.join(","));
    slackAuthUrl.searchParams.set("redirect_uri", redirectUri);
    slackAuthUrl.searchParams.set("response_type", "code");
    slackAuthUrl.searchParams.set(
      "state",
      encryptSlackOAuthState({ userId, organizationId, type: "openid" }),
    );
    return slackAuthUrl.toString();
  },
  { defaultErrorMessage: "Failed to get Slack OAuth URL" },
);

export const disconnectSlackAccount = userOnlyAction(
  async function disconnectSlackAccount(
    userId: string,
    { teamId }: { teamId: string },
  ): Promise<void> {
    await deleteSlackAccount({ db, userId, teamId });
  },
  { defaultErrorMessage: "Failed to disconnect Slack account" },
);

export const updateSlackSettings = userOnlyAction(
  async function updateSlackSettings(
    userId: string,
    {
      teamId,
      settings,
    }: {
      teamId: string;
      settings: Omit<SlackSettingsInsert, "userId" | "teamId">;
    },
  ): Promise<void> {
    await upsertSlackSettings({ db, userId, teamId, settings });
  },
  { defaultErrorMessage: "Failed to update Slack settings" },
);
