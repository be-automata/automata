"use server";

import {
  AuthType,
  createAnthropicAPIKey,
  createAuthorizationURL,
  exchangeAuthorizationCode,
} from "@/lib/claude-oauth";
import { saveClaudeTokens } from "@/agent/msg/claudeCredentials";
import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { getPostHogServer } from "@/lib/posthog-server";

export const getAuthorizationURL = userOnlyAction(
  async function getAuthorizationURL(
    userId: string,
    { type }: { type: AuthType },
  ) {
    return await createAuthorizationURL({ type });
  },
  { defaultErrorMessage: "Failed to get authorization URL" },
);

export const exchangeCode = userOnlyAction(
  async function exchangeCode(
    userId: string,
    {
      code,
      codeVerifier,
      state,
      authType,
    }: {
      code: string;
      codeVerifier: string;
      state: string;
      authType: AuthType;
    },
  ) {
    // Exchange the code for tokens
    const tokenResponse = await exchangeAuthorizationCode({
      code,
      codeVerifier,
      state,
    });
    const tenant = await getTenantContextOrNull();
    await saveClaudeTokens({
      userId,
      organizationId: tenant?.organizationId ?? null,
      tokenData: {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        // If auth type is api-key, create an Anthropic API key
        anthropicApiKey:
          authType === "api-key"
            ? await createAnthropicAPIKey(tokenResponse.access_token)
            : undefined,
        isSubscription: authType === "subscription",
        tokenType: tokenResponse.token_type,
        expiresAt: tokenResponse.expires_in
          ? new Date(Date.now() + tokenResponse.expires_in * 1000)
          : null,
        scope: tokenResponse.scope,
      },
    });
    getPostHogServer().capture({
      distinctId: userId,
      event: "claude_oauth_token_saved",
      properties: {
        authType,
      },
    });
  },
  { defaultErrorMessage: "Token exchange failed" },
);
