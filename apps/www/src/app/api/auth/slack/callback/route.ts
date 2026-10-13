import { NextRequest } from "next/server";
import { getUserIdOrNull } from "@/lib/auth-server";
import { decryptValue, encryptValue } from "@terragon/utils/encryption";
import { env } from "@terragon/env/apps-www";
import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  upsertSlackInstallation,
  upsertSlackAccount,
  getSlackSettingsForTeam,
  upsertSlackSettings,
} from "@terragon/shared/model/slack";
import { getUserFlags } from "@terragon/shared/model/user-flags";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import { isOrgAdmin } from "@/lib/org-role";
import { getMembership } from "@terragon/shared/model/organizations";
import { SlackWorkspaceBoundElsewhereError } from "@terragon/shared/model/slack";
import { resolveSlackAppConfig } from "@/server-lib/slack-config";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getUserCredentials } from "@/server-lib/user-credentials";
import { getDefaultModel } from "@/lib/default-ai-model";

export async function GET(request: NextRequest) {
  const userId = await getUserIdOrNull();
  if (!userId) {
    notFound();
    return;
  }
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  // Validate required parameters
  if (!code || !state) {
    redirect(
      "/settings/integrations?integration=slack&status=error&code=invalid_params",
    );
    return;
  }

  const decryptedState = decryptValue(state!, env.ENCRYPTION_MASTER_KEY);
  const {
    userId: stateUserId,
    timestamp,
    type,
    organizationId: stateOrganizationId,
  } = JSON.parse(decryptedState);
  // States minted before org-scoped Slack apps carry no org: the platform app.
  const organizationId: string | null = stateOrganizationId ?? null;
  if (stateUserId !== userId) {
    redirect(
      "/settings/integrations?integration=slack&status=error&code=invalid_state",
    );
    return;
  }
  // State should be less than 24 hours old
  if (timestamp < Date.now() - 1000 * 60 * 60 * 24) {
    redirect(
      "/settings/integrations?integration=slack&status=error&code=invalid_state",
    );
    return;
  }
  // Handle OAuth errors
  if (error) {
    console.error("Slack OAuth error:", error);
    if (error === "access_denied") {
      redirect(
        "/settings/integrations?integration=slack&status=error&code=auth_cancelled",
      );
      return;
    }
    redirect(
      "/settings/integrations?integration=slack&status=error&code=auth_error",
    );
    return;
  }

  // The state names the org whose Slack app started this flow; the user must
  // still belong to it (and, to bind a workspace, administer it).
  if (
    organizationId &&
    !(await getMembership({ db, organizationId, userId }))
  ) {
    redirect(
      "/settings/integrations?integration=slack&status=error&code=invalid_state",
    );
    return;
  }
  if (
    type === "app_install" &&
    organizationId &&
    !(await isOrgAdmin({ db, organizationId, userId }))
  ) {
    redirect(
      "/settings/integrations?integration=slack&status=error&code=not_org_admin",
    );
    return;
  }
  const slackApp = await resolveSlackAppConfig({ db, organizationId });
  if (!slackApp.clientId || !slackApp.clientSecret) {
    redirect(
      "/settings/integrations?integration=slack&status=error&code=not_configured",
    );
    return;
  }

  // Exchange authorization code for access token
  const tokenUrl =
    type === "app_install"
      ? "https://slack.com/api/oauth.v2.access"
      : "https://slack.com/api/openid.connect.token";
  const params = new URLSearchParams();
  params.append("client_id", slackApp.clientId);
  params.append("client_secret", slackApp.clientSecret);
  params.append("code", code);
  params.append(
    "redirect_uri",
    `${nonLocalhostPublicAppUrl()}/api/auth/slack/callback`,
  );
  const tokenResponse = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const tokenData = await tokenResponse.json();
  if (!tokenData.ok) {
    console.error("Slack token exchange failed:", tokenData);
    redirect(
      "/settings/integrations?integration=slack&status=error&code=auth_error",
    );
    return;
  }

  if (type === "app_install") {
    // Create new connection
    try {
      await upsertSlackInstallation({
        db,
        userId,
        teamId: tokenData.team.id,
        installation: {
          organizationId,
          teamName: tokenData.team.name,
          botUserId: tokenData.bot_user_id,
          botAccessTokenEncrypted: encryptValue(
            tokenData.access_token,
            env.ENCRYPTION_MASTER_KEY,
          ),
          scope: tokenData.scope,
          appId: tokenData.app_id,
          installerUserId: userId,
          isEnterpriseInstall: !!tokenData.is_enterprise_install,
          enterpriseId: tokenData.enterprise?.id || null,
          enterpriseName: tokenData.enterprise?.name,
          isActive: true,
        },
      });
    } catch (error) {
      if (error instanceof SlackWorkspaceBoundElsewhereError) {
        redirect(
          "/settings/integrations?integration=slack&status=error&code=workspace_bound_elsewhere",
        );
        return;
      }
      throw error;
    }
    redirect(
      "/settings/integrations?integration=slack&status=success&code=app_installed",
    );
  }
  if (type === "openid") {
    // Decode the JWT id_token to get user information
    const idToken = tokenData.id_token;
    if (!idToken) {
      console.error("No id_token in OpenID Connect response");
      redirect(
        "/settings/integrations?integration=slack&status=error&code=auth_error",
      );
      return;
    }

    // Verify the JWT signature and validate claims
    let verifiedPayload: any = null;
    try {
      // Slack's JWKS endpoint for OpenID Connect
      const JWKS = createRemoteJWKSet(
        new URL("https://slack.com/openid/connect/keys"),
      );
      // Verify the JWT with Slack's public keys
      const { payload } = await jwtVerify(idToken, JWKS, {
        // Validate the issuer
        issuer: "https://slack.com",
        // Validate the audience (should be your client ID)
        audience: slackApp.clientId,
        // The token should not be expired
        clockTolerance: 5, // Allow 5 seconds of clock skew
      });
      verifiedPayload = payload;
    } catch (error) {
      console.error("JWT verification failed:", error);
      redirect(
        "/settings/integrations?integration=slack&status=error&code=auth_error",
      );
      return;
    }
    if (!verifiedPayload) {
      console.error("No verified payload in OpenID Connect response");
      redirect(
        "/settings/integrations?integration=slack&status=error&code=auth_error",
      );
      return;
    }

    // Extract user and team information from the verified JWT payload
    const slackUserId = (verifiedPayload["https://slack.com/user_id"] ||
      verifiedPayload.sub) as string;
    const teamId = verifiedPayload["https://slack.com/team_id"] as string;
    const slackTeamName = verifiedPayload[
      "https://slack.com/team_name"
    ] as string;
    const slackTeamDomain = verifiedPayload[
      "https://slack.com/team_domain"
    ] as string;

    // Store user's Slack account information
    await upsertSlackAccount({
      db,
      userId,
      teamId,
      account: {
        slackUserId,
        slackTeamName,
        slackTeamDomain,
        accessTokenEncrypted: encryptValue(
          tokenData.access_token,
          env.ENCRYPTION_MASTER_KEY,
        ),
      },
    });

    // Create a slack setting with pre-populated defaults from user flags
    const [existingSettings, userFlags, userCredentials] = await Promise.all([
      getSlackSettingsForTeam({
        db,
        userId,
        teamId,
      }),
      getUserFlags({ db, userId }),
      getUserCredentials({ userId }),
    ]);
    if (
      !existingSettings ||
      !existingSettings?.defaultModel ||
      !existingSettings?.defaultRepoFullName
    ) {
      await upsertSlackSettings({
        db,
        userId,
        teamId,
        settings: {
          defaultModel:
            existingSettings?.defaultModel ||
            getDefaultModel({ userFlags, userCredentials }),
          defaultRepoFullName:
            existingSettings?.defaultRepoFullName || userFlags.selectedRepo,
        },
      });
    }
    redirect(
      "/settings/integrations?integration=slack&status=success&code=account_connected",
    );
  }
}
