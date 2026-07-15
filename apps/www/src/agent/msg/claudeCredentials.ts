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
  tokenData,
}: {
  userId: string;
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
