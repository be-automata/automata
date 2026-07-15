import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import {
  getAgentProviderCredentialsDecrypted,
  getAgentProviderCredentialsDecryptedById,
  getValidAccessTokenForCredential,
} from "@terragon/shared/model/agent-provider-credentials";
import { refreshAccessToken } from "@/lib/openai-oauth";
import { retryAsync } from "@terragon/utils/retry";

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
    refreshTokenCallback: async (tokenDataToRefresh) => {
      const response = await refreshAccessToken(
        tokenDataToRefresh.refreshToken,
      );
      return {
        accessToken: response.access_token,
        expiresAt: response.expires_in
          ? new Date(Date.now() + response.expires_in * 1000)
          : null,
        refreshToken: response.refresh_token,
        idToken: response.id_token,
        lastRefreshedAt: new Date(),
        metadata: null,
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
    { label: "getValidAccessToken (codex)" },
  );
}

/**
 * Force refresh of Codex credentials (for admin use)
 */
export async function forceRefreshCodexCredentials({
  userId,
  credentialId,
}: {
  userId: string;
  credentialId: string;
}): Promise<string | null> {
  return getValidAccessToken({ userId, credentialId, forceRefresh: true });
}

/**
 * Get Codex (OpenAI) credentials in the format of ~/.codex/auth.json
 * Returns null if no valid credentials exist.
 */
export async function getCodexCredentialsJSONOrNull({
  userId,
  organizationId,
}: {
  userId: string;
  // Tenant of the thread this agent run belongs to (WI-5 batch 3a). Fences the
  // primary credential lookup to this org.
  organizationId?: string | null;
}): Promise<{
  contents: string | null;
  error: string | null;
}> {
  try {
    const credentials = await getAgentProviderCredentialsDecrypted({
      db,
      userId,
      organizationId,
      agent: "codex",
      encryptionKey: env.ENCRYPTION_MASTER_KEY,
    });
    if (credentials?.apiKey) {
      return {
        contents: JSON.stringify({
          apiKey: credentials.apiKey,
        }),
        error: null,
      };
    }
    if (!credentials?.accessToken) {
      return { contents: null, error: null };
    }
    // Try to refresh if needed
    const validAccessToken = await getValidAccessToken({
      userId,
      credentialId: credentials.id,
    });
    // Reload auth data if token was refreshed
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

    if (!finalCredentials?.accessToken) {
      return { contents: null, error: null };
    }
    const authJson: Record<string, any> = {
      tokens: {
        id_token: finalCredentials.idToken || "",
        access_token: finalCredentials.accessToken,
        refresh_token: "", // We don't want the cli to refresh the token
        account_id: finalCredentials.metadata?.accountId || null,
      },
      // Always tell codex that we just refreshed the token to it doesn't try to.
      last_refresh: new Date().toISOString(),
    };
    return { contents: JSON.stringify(authJson), error: null };
  } catch (error) {
    console.error("[getCodexCredentialsJSONOrNull] Failed:", error);
    return { contents: null, error: "Failed to get Codex credentials" };
  }
}
