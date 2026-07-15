"use server";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { refreshAccessToken } from "@/lib/openai-oauth";
import { insertAgentProviderCredentials } from "@terragon/shared/model/agent-provider-credentials";
import { UserFacingError } from "@/lib/server-actions";
import { getPostHogServer } from "@/lib/posthog-server";

export const saveCodexAuthJson = userOnlyAction(
  async function saveCodexAuthJson(
    userId: string,
    { authJson }: { authJson: string },
  ) {
    const parsed = JSON.parse(authJson || "{}");
    // Skip the OPENAI_API_KEY - we only handle OAuth tokens
    const tokens = parsed.tokens || {};
    let id_token: string | undefined = tokens.id_token;
    let access_token: string | undefined = tokens.access_token;
    let refresh_token: string | undefined = tokens.refresh_token;
    const account_id: string | undefined = tokens.account_id;

    // Try to refresh tokens to ensure we have a fresh access token and expiry
    let expires_in: number | undefined;
    try {
      const refreshed = await refreshAccessToken(refresh_token ?? "");
      access_token = refreshed.access_token;
      id_token = refreshed.id_token ?? id_token;
      refresh_token = refreshed.refresh_token ?? refresh_token;
      expires_in = refreshed.expires_in;
    } catch (err) {
      console.warn("OpenAI token refresh failed, using provided tokens", err);
      throw new UserFacingError(
        "Invalid OpenAI credentials, please run 'codex login' to refresh your credentials",
      );
    }

    // Save OAuth tokens if present
    if (access_token) {
      getPostHogServer().capture({
        distinctId: userId,
        event: "codex_oauth_tokens_saved",
        properties: {},
      });
      const tenant = await getTenantContextOrNull();
      await insertAgentProviderCredentials({
        db,
        userId,
        organizationId: tenant?.organizationId ?? null,
        credentialData: {
          type: "oauth",
          agent: "codex",
          isActive: true,
          accessToken: access_token,
          refreshToken: refresh_token,
          idToken: id_token,
          expiresAt: expires_in
            ? new Date(Date.now() + expires_in * 1000)
            : null,
          lastRefreshedAt: new Date(),
          metadata: {
            type: "openai",
            accountId: account_id,
          },
        },
        encryptionKey: env.ENCRYPTION_MASTER_KEY,
      });
    }
  },
  { defaultErrorMessage: "Failed to save Codex auth.json" },
);
