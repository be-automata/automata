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
import { SlackSettingsInsert } from "@terragon/shared/db/types";
import { resolveSlackAppConfig } from "@/server-lib/slack-config";
import { encodeSlackOAuthState } from "@/lib/slack-oauth-state";
import { isSlackTeamId } from "@/lib/slack-team-id";
import {
  SLACK_BOT_SCOPES,
  SLACK_OPENID_SCOPES,
} from "@/lib/slack-app-manifest";

/**
 * The client ID of the session's active org's Slack app (the platform app
 * without one), and that org. The org always comes from the session, never
 * the arguments. `requireAdmin`: installing binds the workspace to the org,
 * an org-governance action, so it is checked before any secret is read.
 */
async function getSessionSlackApp(
  userId: string,
  {
    requireAdmin,
    expectedOrganizationId,
  }: { requireAdmin: boolean; expectedOrganizationId?: string | null },
): Promise<{ organizationId: string | null; clientId: string }> {
  const membership = await getActiveOrganizationMembershipOrNull(userId);
  // The page named an org before the user clicked; the session may have
  // moved since (another tab switched org). Never bind to an org the user
  // was not shown.
  if (
    expectedOrganizationId !== undefined &&
    (membership?.organizationId ?? null) !== expectedOrganizationId
  ) {
    throw new UserFacingError(
      "Your active organization changed in another tab. Reload the page and try again.",
    );
  }
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
        : "Slack isn't enabled on this deployment yet. Ask your Automata operator to set up the Slack app.",
    );
  }
  return { organizationId, clientId: config.clientId };
}

function encryptSlackOAuthState(state: {
  userId: string;
  organizationId: string | null;
  type: "app_install" | "openid";
}): string {
  return encodeSlackOAuthState(state, env.ENCRYPTION_MASTER_KEY);
}

/**
 * Slack's `team` parameter picks the workspace the user signs in to. Without
 * it Slack uses the browser's default workspace, and there is no picker on
 * the "Sign in with Slack" screen. It is a hint, not a binding: the callback
 * still trusts only the team Slack returns.
 */
function setSlackTeamHint(url: URL, teamId: unknown): void {
  if (teamId === undefined || teamId === null) {
    return;
  }
  const trimmed = typeof teamId === "string" ? teamId.trim() : "";
  if (typeof teamId === "string" && !trimmed) {
    return;
  }
  if (!isSlackTeamId(trimmed)) {
    throw new UserFacingError(
      "That is not a Slack workspace ID. It starts with T, e.g. T01ABCDEF.",
    );
  }
  url.searchParams.set("team", trimmed);
}

// Used to install the Slack app
export const getSlackAppInstallUrl = userOnlyAction(
  async function getSlackAppInstallUrl(
    userId: string,
    {
      teamId,
      expectedOrganizationId,
    }: { teamId?: string; expectedOrganizationId?: string | null } = {},
  ): Promise<string> {
    const { organizationId, clientId } = await getSessionSlackApp(userId, {
      requireAdmin: true,
      expectedOrganizationId,
    });
    const redirectUri = `${nonLocalhostPublicAppUrl()}/api/auth/slack/callback`;
    const scopes = SLACK_BOT_SCOPES.join(",");
    const slackAuthUrl = new URL("https://slack.com/oauth/v2/authorize");
    slackAuthUrl.searchParams.set("client_id", clientId);
    slackAuthUrl.searchParams.set("scope", scopes);
    slackAuthUrl.searchParams.set("redirect_uri", redirectUri);
    setSlackTeamHint(slackAuthUrl, teamId);
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
  async function getSlackOAuthUrl(
    userId: string,
    {
      teamId,
      expectedOrganizationId,
    }: { teamId?: string; expectedOrganizationId?: string | null } = {},
  ): Promise<string> {
    const { organizationId, clientId } = await getSessionSlackApp(userId, {
      requireAdmin: false,
      expectedOrganizationId,
    });
    const redirectUri = `${nonLocalhostPublicAppUrl()}/api/auth/slack/callback`;
    const slackAuthUrl = new URL("https://slack.com/openid/connect/authorize");
    slackAuthUrl.searchParams.set("client_id", clientId);
    slackAuthUrl.searchParams.set("scope", SLACK_OPENID_SCOPES.join(","));
    slackAuthUrl.searchParams.set("redirect_uri", redirectUri);
    slackAuthUrl.searchParams.set("response_type", "code");
    setSlackTeamHint(slackAuthUrl, teamId);
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
