import { db } from "@/lib/db";
import { retryAsync } from "@terragon/utils/retry";
import { refreshAccessToken } from "@/lib/claude-oauth";
import { env } from "@terragon/env/apps-www";
import { updateUserFlags } from "@terragon/shared/model/user-flags";
import {
  ClaudeOrganizationType,
  ClaudeAgentProviderMetadata,
} from "@terragon/shared";
import {
  getValidAccessTokenForCredential,
  insertAgentProviderCredentials,
  getAgentProviderCredentialsDecrypted,
  getAgentProviderCredentialsDecryptedById,
} from "@terragon/shared/model/agent-provider-credentials";

const API_BASE_URL = "https://api.anthropic.com";

interface OAuthProfile {
  account?: {
    uuid: string;
    email: string;
  };
  organization?: {
    uuid: string;
    name: string;
    organization_type: string;
  };
}

type AccountInfo = Pick<
  ClaudeAgentProviderMetadata,
  | "accountId"
  | "accountEmail"
  | "orgId"
  | "orgName"
  | "organizationType"
  | "isMax"
>;

async function getAccountInfoFromTokenInner({
  accessToken,
}: {
  accessToken?: string;
}): Promise<AccountInfo | null> {
  if (!accessToken) {
    return null;
  }
  try {
    const profileUrl = `${API_BASE_URL}/api/oauth/profile`;
    const response = await fetch(profileUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    if (response.ok) {
      const profile: OAuthProfile = await response.json();
      return {
        accountId: profile?.account?.uuid,
        accountEmail: profile?.account?.email,
        orgId: profile?.organization?.uuid,
        orgName: profile?.organization?.name,
        organizationType: profile?.organization
          ?.organization_type as ClaudeOrganizationType,
        isMax: profile?.organization?.organization_type === "claude_max",
      };
    }
    return null;
  } catch (error) {
    console.error(
      "[getAccountInfoFromTokenInner] Failed to get account info:",
      error,
    );
    return null;
  }
}

/**
 * Check if an access token belongs to a Claude Max user and update userFlags
 */
async function checkAndUpdateClaudeStatus({
  userId,
  isSubscription,
  accessToken,
}: {
  userId: string;
  isSubscription: boolean;
  accessToken?: string;
}): Promise<AccountInfo | null> {
  // If they have a valid access token, they're a Claude subscriber
  const isClaudeSub = isSubscription;
  let accountInfo: AccountInfo | null = null;
  let organizationType: ClaudeOrganizationType | null = null;
  if (isClaudeSub) {
    accountInfo = await getAccountInfoFromTokenInner({
      accessToken,
    });
    if (accountInfo?.organizationType) {
      organizationType = accountInfo.organizationType;
    }
  }
  // Store these flags on the user to make it easy for us to look this up.
  await updateUserFlags({
    db,
    userId,
    updates: {
      isClaudeSub,
      isClaudeMaxSub: organizationType === "claude_max",
      claudeOrganizationType: organizationType,
    },
  });
  return accountInfo;
}

type TokenData = {
  accessToken?: string;
  refreshToken?: string;
  anthropicApiKey?: string;
  isSubscription: boolean;
  expiresAt: Date | null;
  scope?: string;
  tokenType?: string;
};

/**
 * Store Claude OAuth tokens for a user
 */
export async function saveClaudeTokens({
  userId,
  organizationId,
  tokenData,
}: {
  userId: string;
  // Tenant to stamp on the credential (WI-5). The credential list reads are
  // org-fenced, so a credential saved with a null org while the session has an
  // active org is invisible in the UI.
  organizationId?: string | null;
  tokenData: TokenData;
}): Promise<void> {
  const additionalClaudeMetadata = await checkAndUpdateClaudeStatus({
    userId,
    isSubscription: tokenData.isSubscription,
    accessToken: tokenData.accessToken,
  });
  const isApiKey = !!tokenData.anthropicApiKey;
  await insertAgentProviderCredentials({
    db,
    userId,
    organizationId: organizationId ?? null,
    credentialData: {
      type: isApiKey ? "api-key" : "oauth",
      agent: "claudeCode",
      isActive: true,
      apiKey: isApiKey ? tokenData.anthropicApiKey : undefined,
      accessToken: isApiKey ? undefined : tokenData.accessToken,
      refreshToken: isApiKey ? undefined : tokenData.refreshToken,
      expiresAt: isApiKey ? null : tokenData.expiresAt,
      lastRefreshedAt: isApiKey ? null : new Date(),
      metadata: {
        type: "claude",
        tokenType: tokenData.tokenType,
        scope: tokenData.scope ?? undefined,
        accountEmail: additionalClaudeMetadata?.accountEmail,
        accountId: additionalClaudeMetadata?.accountId,
        orgId: additionalClaudeMetadata?.orgId,
        orgName: additionalClaudeMetadata?.orgName,
        organizationType: additionalClaudeMetadata?.organizationType,
        isMax: !!additionalClaudeMetadata?.isMax,
        isSubscription: tokenData.isSubscription,
      },
    },
    encryptionKey: env.ENCRYPTION_MASTER_KEY,
  });
}

/**
 * Store a long-lived token minted by `claude setup-token`.
 *
 * Unlike the interactive OAuth flow there is no code exchange and no refresh
 * token: the user runs the CLI locally and pastes the result. It lands in
 * `accessTokenEncrypted` (NOT `apiKeyEncrypted` — the resolver checks `apiKey`
 * first and would emit it as an `anthropicApiKey`, which the CLI would send as an
 * `x-api-key` and Anthropic would reject) with a null `expiresAt`, which
 * `getValidAccessTokenForCredential` already treats as "never refresh".
 */
export async function saveClaudeSetupToken({
  userId,
  organizationId,
  token,
}: {
  userId: string;
  organizationId?: string | null;
  token: string;
}): Promise<void> {
  // Best-effort only. `claude setup-token` tokens are inference-scoped, so the
  // OAuth profile endpoint may refuse them — that must not block a valid token
  // from being saved. getAccountInfoFromTokenInner already returns null on any
  // non-200 or throw.
  const accountInfo = await getAccountInfoFromTokenInner({
    accessToken: token,
  });
  await updateUserFlags({
    db,
    userId,
    updates: {
      isClaudeSub: true,
      // Unknown rather than false: the probe above usually cannot read org type
      // for an inference-scoped token. Do not gate features on these for a
      // setup-token user — branch on the credential type instead.
      isClaudeMaxSub: accountInfo?.organizationType === "claude_max",
      claudeOrganizationType: accountInfo?.organizationType ?? null,
    },
  });
  await insertAgentProviderCredentials({
    db,
    userId,
    organizationId: organizationId ?? null,
    credentialData: {
      type: "setup-token",
      agent: "claudeCode",
      isActive: true,
      accessToken: token,
      expiresAt: null,
      lastRefreshedAt: null,
      metadata: {
        type: "claude",
        isSubscription: true,
        accountEmail: accountInfo?.accountEmail,
        accountId: accountInfo?.accountId,
        orgId: accountInfo?.orgId,
        orgName: accountInfo?.orgName,
        organizationType: accountInfo?.organizationType,
        isMax: !!accountInfo?.isMax,
      },
    },
    encryptionKey: env.ENCRYPTION_MASTER_KEY,
  });
}

/**
 * Get a valid Claude access token, refreshing if necessary
 */
async function getValidAccessTokenInternal({
  userId,
  credentialId,
  forceRefresh = false,
}: {
  userId: string;
  credentialId: string;
  forceRefresh?: boolean;
}): Promise<string | null> {
  return await getValidAccessTokenForCredential({
    db,
    userId,
    credentialId,
    encryptionKey: env.ENCRYPTION_MASTER_KEY,
    forceRefresh,
    refreshTokenCallback: async ({ refreshToken }) => {
      const response = await refreshAccessToken(refreshToken);
      const claudeMetadata = await checkAndUpdateClaudeStatus({
        userId,
        isSubscription: true,
        accessToken: response.access_token,
      });
      return {
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        expiresAt: response.expires_in
          ? new Date(Date.now() + response.expires_in * 1000)
          : null,
        lastRefreshedAt: new Date(),
        metadata: {
          type: "claude",
          tokenType: response.token_type,
          scope: response.scope,
          accountEmail: claudeMetadata?.accountEmail,
          accountId: claudeMetadata?.accountId,
          orgId: claudeMetadata?.orgId,
          orgName: claudeMetadata?.orgName,
          organizationType: claudeMetadata?.organizationType,
          isMax: !!claudeMetadata?.isMax,
          isSubscription: true,
        },
      };
    },
  });
}

/**
 * Wraps getValidAccessTokenInternal with retry to handle the case where
 * multiple processes refresh the token at the same time.
 */
async function getValidAccessToken({
  userId,
  credentialId,
  forceRefresh = false,
}: {
  userId: string;
  credentialId: string;
  forceRefresh?: boolean;
}): Promise<string | null> {
  return retryAsync(
    () => {
      return getValidAccessTokenInternal({
        userId,
        credentialId,
        forceRefresh,
      });
    },
    { label: "getValidAccessToken (claude)" },
  );
}

/**
 * Force refresh of Claude credentials (for admin use)
 */
export async function forceRefreshClaudeCredentials({
  userId,
  credentialId,
}: {
  userId: string;
  credentialId: string;
}): Promise<string | null> {
  return getValidAccessToken({ userId, credentialId, forceRefresh: true });
}

function orgTypeToSubscriptionType(
  organizationType: ClaudeOrganizationType | null,
) {
  if (!organizationType) {
    return null;
  }
  switch (organizationType) {
    case "claude_max":
      return "max";
    case "claude_pro":
      return "pro";
    case "claude_enterprise":
      return "enterprise";
    case "claude_team":
      return "team";
    default:
      return null;
  }
}

/**
 * Get Claude credentials in the format of the .claude/.credentials.json file.
 * Returns null if no valid credentials exist.
 */
export async function getClaudeCredentialsJSONOrNull({
  userId,
  organizationId,
}: {
  userId: string;
  // Tenant of the thread this agent run belongs to (WI-5 batch 3a). Fences the
  // primary credential lookup so the agent uses THIS org's credential. The
  // downstream by-credentialId refresh reads are already gated by that id.
  organizationId?: string | null;
}): Promise<{ contents: string | null; error: string | null }> {
  try {
    // Get the stored tokens
    const credentials = await getAgentProviderCredentialsDecrypted({
      db,
      userId,
      organizationId,
      agent: "claudeCode",
      encryptionKey: env.ENCRYPTION_MASTER_KEY,
    });
    if (!credentials) {
      return { contents: null, error: null };
    }
    // For API keys, just include the API key
    if (credentials.apiKey) {
      return {
        contents: JSON.stringify({ anthropicApiKey: credentials.apiKey }),
        error: null,
      };
    }
    if (!credentials.accessToken) {
      return { contents: null, error: null };
    }
    // A `claude setup-token` token is a long-lived OAuth bearer with no refresh
    // token and no expiry, so it skips the refresh round-trip entirely and is
    // emitted in the SAME claudeAiOauth shape the interactive flow uses. Riding
    // the existing file shape is deliberate: it inherits per-resume rewrite and
    // removal in the sandbox (packages/sandbox setup.ts), 0600 materialisation on
    // the worker, and the box-key drop — none of which an env-var delivery would
    // get. Verified on the sandbox-pinned CLI (2.0.65): an `sk-ant-oat…` value in
    // the accessToken slot is sent as an OAuth bearer.
    if (credentials.type === "setup-token") {
      return {
        contents: JSON.stringify({
          claudeAiOauth: {
            accessToken: credentials.accessToken,
            // The CLI must never refresh; the control plane owns credential
            // lifecycle, and a setup-token has nothing to refresh with anyway.
            refreshToken: "",
            // No real expiry. Far-future keeps the CLI from pre-emptively
            // treating it as stale; a revoked token surfaces as a 401 instead.
            expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
            scopes: ["user:inference"],
            subscriptionType: null,
          },
        }),
        error: null,
      };
    }
    // Try to refresh the token
    const validAccessToken = await getValidAccessToken({
      userId,
      credentialId: credentials.id,
    });

    let finalCredentials = credentials;
    if (validAccessToken && validAccessToken !== credentials.accessToken) {
      const reloaded = await getAgentProviderCredentialsDecryptedById({
        db,
        userId,
        credentialId: credentials.id,
        encryptionKey: env.ENCRYPTION_MASTER_KEY,
      });
      if (reloaded) {
        finalCredentials = reloaded;
      }
    }
    if (!finalCredentials.accessToken) {
      return { contents: null, error: null };
    }

    let organizationType: ClaudeOrganizationType | null = null;
    let scopes: string[] = [];
    if (finalCredentials.metadata?.type === "claude") {
      organizationType = finalCredentials.metadata.organizationType ?? null;
      scopes = finalCredentials.metadata.scope
        ? finalCredentials.metadata.scope.split(" ")
        : [];
    }
    const expiresAt = finalCredentials.expiresAt
      ? finalCredentials.expiresAt.getTime()
      : Date.now() + 365 * 24 * 60 * 60 * 1000; // Default to 1 year if no expiration
    // Build the credentials object in the expected format
    const credentialsJson = {
      claudeAiOauth: {
        accessToken: finalCredentials.accessToken,
        refreshToken: "", // We don't want the cli to refresh the token
        expiresAt,
        scopes,
        subscriptionType: orgTypeToSubscriptionType(organizationType),
      },
    };
    return { contents: JSON.stringify(credentialsJson), error: null };
  } catch (error) {
    console.error(
      "[getCredentialsJSONOrNull] Failed to get credentials:",
      error,
    );
    return { contents: null, error: "Failed to get Claude credentials" };
  }
}
