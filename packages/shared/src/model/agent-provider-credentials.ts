import * as schema from "../db/schema";
import type {
  AgentProviderCredentials,
  AgentProviderCredentialsInsert,
} from "../db/types";
import { eq, and, desc, ne } from "drizzle-orm";
import { encryptValue, decryptValue } from "@terragon/utils/encryption";
import type { DB } from "../db";
import { publishBroadcastUserMessage } from "../broadcast-server";
import { AIAgent } from "@terragon/agent/types";
import { updateUserFlags } from "./user-flags";

/**
 * Tenant fence for owner-scoped agent-credential access (WI-5). We keep the
 * existing PER-USER semantics — a credential belongs to (userId, organizationId)
 * — for consistency with threads/environments. The "org-shared team credential"
 * tier (a cred visible to all org members) is a separate product feature and is
 * NOT introduced here. Optional during the nullable phase; the forTenant
 * accessor always supplies it. drizzle's and() drops undefined.
 */
function credOrgFence(organizationId?: string | null) {
  return organizationId
    ? eq(schema.agentProviderCredentials.organizationId, organizationId)
    : undefined;
}

export type AgentProviderCredentialsDecrypted = Omit<
  AgentProviderCredentials,
  | "userId"
  | "apiKeyEncrypted"
  | "accessTokenEncrypted"
  | "refreshTokenEncrypted"
  | "idTokenEncrypted"
> & {
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
};

export async function insertAgentProviderCredentials({
  db,
  userId,
  credentialData,
  encryptionKey,
  organizationId,
}: {
  db: DB;
  userId: string;
  credentialData: Omit<
    AgentProviderCredentialsDecrypted,
    "id" | "userId" | "organizationId" | "createdAt" | "updatedAt"
  >;
  encryptionKey: string;
  // Tenant to stamp on the new credential (WI-5).
  organizationId?: string | null;
}): Promise<AgentProviderCredentials> {
  // Encrypt the credential values
  const { apiKey, accessToken, refreshToken, idToken, ...restCredentialData } =
    credentialData;
  const {
    apiKeyEncrypted,
    accessTokenEncrypted,
    refreshTokenEncrypted,
    idTokenEncrypted,
  } = {
    apiKeyEncrypted: apiKey ? encryptValue(apiKey, encryptionKey) : null,
    accessTokenEncrypted: accessToken
      ? encryptValue(accessToken, encryptionKey)
      : null,
    refreshTokenEncrypted: refreshToken
      ? encryptValue(refreshToken, encryptionKey)
      : null,
    idTokenEncrypted: idToken ? encryptValue(idToken, encryptionKey) : null,
  };
  const updateData: Omit<AgentProviderCredentialsInsert, "userId" | "agent"> = {
    apiKeyEncrypted,
    accessTokenEncrypted,
    refreshTokenEncrypted,
    idTokenEncrypted,
    ...restCredentialData,
  };
  const result = await db
    .insert(schema.agentProviderCredentials)
    .values({
      userId,
      organizationId: organizationId ?? null,
      agent: credentialData.agent,
      ...updateData,
    })
    .returning();
  if (!result[0]) {
    throw new Error("Failed to store agent provider credentials");
  }
  if (credentialData.isActive) {
    await deactivateOtherCredentialsForAgent({
      db,
      userId,
      agent: credentialData.agent,
      credentialId: result[0].id,
      organizationId,
    });
  }
  // Publish realtime update
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: {
      userSettings: true,
      userCredentials: true,
    },
  });
  return result[0];
}

export function decryptCredentials({
  credentials,
  encryptionKey,
}: {
  credentials: AgentProviderCredentials;
  encryptionKey: string;
}): AgentProviderCredentialsDecrypted {
  const {
    apiKeyEncrypted,
    accessTokenEncrypted,
    refreshTokenEncrypted,
    idTokenEncrypted,
    ...restCredentials
  } = credentials;
  const { apiKey, accessToken, refreshToken, idToken } = {
    apiKey: apiKeyEncrypted
      ? decryptValue(apiKeyEncrypted, encryptionKey)
      : undefined,
    accessToken: accessTokenEncrypted
      ? decryptValue(accessTokenEncrypted, encryptionKey)
      : undefined,
    refreshToken: refreshTokenEncrypted
      ? decryptValue(refreshTokenEncrypted, encryptionKey)
      : undefined,
    idToken: idTokenEncrypted
      ? decryptValue(idTokenEncrypted, encryptionKey)
      : undefined,
  };
  return {
    ...restCredentials,
    apiKey,
    accessToken,
    refreshToken,
    idToken,
  };
}

export async function getAgentProviderCredentialsDecryptedById({
  db,
  userId,
  credentialId,
  encryptionKey,
  organizationId,
}: {
  db: DB;
  userId: string;
  credentialId: string;
  encryptionKey: string;
  organizationId?: string | null;
}): Promise<AgentProviderCredentialsDecrypted | null> {
  const credentials = await getAgentProviderCredentialById({
    db,
    userId,
    credentialId,
    organizationId,
  });
  if (!credentials) {
    return null;
  }
  return decryptCredentials({ credentials, encryptionKey });
}

// Get decrypted agent provider credentials for a user
export async function getAgentProviderCredentialsDecrypted({
  db,
  userId,
  agent,
  encryptionKey,
  organizationId,
}: {
  db: DB;
  userId: string;
  agent: AIAgent;
  encryptionKey: string;
  organizationId?: string | null;
}): Promise<AgentProviderCredentialsDecrypted | null> {
  const credentials = await getAgentProviderCredentialsRecord({
    db,
    userId,
    agent,
    organizationId,
  });
  if (!credentials) {
    return null;
  }
  return decryptCredentials({ credentials, encryptionKey });
}

// Get all agent provider credentials for a user (decrypted)
export async function getAllAgentProviderCredentialRecords({
  db,
  userId,
  isActive,
  organizationId,
}: {
  db: DB;
  userId: string;
  isActive?: boolean;
  organizationId?: string | null;
}): Promise<AgentProviderCredentials[]> {
  return await db.query.agentProviderCredentials.findMany({
    where: and(
      eq(schema.agentProviderCredentials.userId, userId),
      credOrgFence(organizationId),
      isActive
        ? eq(schema.agentProviderCredentials.isActive, isActive)
        : undefined,
    ),
  });
}

// Get the raw credential record (with encrypted values)
// Returns the active credential, or the first one if none is active
export async function getAgentProviderCredentialsRecord({
  db,
  userId,
  agent,
  organizationId,
}: {
  db: DB;
  userId: string;
  agent: AIAgent;
  organizationId?: string | null;
}): Promise<AgentProviderCredentials | undefined> {
  return await db.query.agentProviderCredentials.findFirst({
    where: and(
      eq(schema.agentProviderCredentials.userId, userId),
      credOrgFence(organizationId),
      eq(schema.agentProviderCredentials.agent, agent),
      eq(schema.agentProviderCredentials.isActive, true),
    ),
    orderBy: desc(schema.agentProviderCredentials.createdAt),
  });
}

async function getAgentProviderCredentialById({
  db,
  userId,
  credentialId,
  organizationId,
}: {
  db: DB;
  userId: string;
  credentialId: string;
  organizationId?: string | null;
}): Promise<AgentProviderCredentials | undefined> {
  return await db.query.agentProviderCredentials.findFirst({
    where: and(
      eq(schema.agentProviderCredentials.userId, userId),
      credOrgFence(organizationId),
      eq(schema.agentProviderCredentials.id, credentialId),
    ),
  });
}

// Delete a specific credential by ID
export async function deleteAgentProviderCredentialById({
  db,
  userId,
  credentialId,
  organizationId,
}: {
  db: DB;
  userId: string;
  credentialId: string;
  organizationId?: string | null;
}): Promise<void> {
  const credential = await getAgentProviderCredentialById({
    db,
    userId,
    credentialId,
    organizationId,
  });
  if (!credential) {
    throw new Error("Credential not found");
  }
  await db
    .delete(schema.agentProviderCredentials)
    .where(
      and(
        eq(schema.agentProviderCredentials.userId, userId),
        credOrgFence(organizationId),
        eq(schema.agentProviderCredentials.id, credentialId),
      ),
    );
  if (credential.isActive && credential.agent === "claudeCode") {
    await updateUserFlags({
      db,
      userId,
      updates: {
        isClaudeSub: false,
        isClaudeMaxSub: false,
        claudeOrganizationType: null,
      },
    });
  }
  // Publish realtime update
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: {
      userSettings: true,
      userCredentials: true,
    },
  });
}

// Get all credentials for a specific agent
export async function getAgentProviderCredentialsForAgent({
  db,
  userId,
  agent,
  organizationId,
}: {
  db: DB;
  userId: string;
  agent: AIAgent;
  organizationId?: string | null;
}): Promise<AgentProviderCredentials[]> {
  return await db.query.agentProviderCredentials.findMany({
    where: and(
      eq(schema.agentProviderCredentials.userId, userId),
      credOrgFence(organizationId),
      eq(schema.agentProviderCredentials.agent, agent),
    ),
    orderBy: [
      desc(schema.agentProviderCredentials.isActive),
      desc(schema.agentProviderCredentials.createdAt),
    ],
  });
}

async function deactivateOtherCredentialsForAgent({
  db,
  userId,
  agent,
  credentialId,
  organizationId,
}: {
  db: DB;
  userId: string;
  agent: AIAgent;
  credentialId: string;
  organizationId?: string | null;
}): Promise<void> {
  await db
    .update(schema.agentProviderCredentials)
    .set({ isActive: false })
    .where(
      and(
        eq(schema.agentProviderCredentials.userId, userId),
        credOrgFence(organizationId),
        eq(schema.agentProviderCredentials.agent, agent),
        ne(schema.agentProviderCredentials.id, credentialId),
      ),
    );
}

// Set a credential as active (deactivates others for the same agent)
export async function updateAgentProviderCredentialsById({
  db,
  userId,
  credentialId,
  updates,
  organizationId,
}: {
  db: DB;
  userId: string;
  credentialId: string;
  updates: Partial<Pick<AgentProviderCredentials, "isActive">>;
  organizationId?: string | null;
}): Promise<void> {
  const credential = await getAgentProviderCredentialById({
    db,
    userId,
    credentialId,
    organizationId,
  });
  if (!credential) {
    throw new Error("Credential not found");
  }
  // Deactivate all other credentials for this agent
  await deactivateOtherCredentialsForAgent({
    db,
    userId,
    agent: credential.agent,
    credentialId,
    organizationId,
  });
  const updatedCredential = await db
    .update(schema.agentProviderCredentials)
    .set(updates)
    .where(
      and(
        eq(schema.agentProviderCredentials.id, credentialId),
        eq(schema.agentProviderCredentials.userId, userId),
        credOrgFence(organizationId),
      ),
    )
    .returning();
  if (!updatedCredential[0]) {
    throw new Error("Failed to update credential");
  }
  // Publish realtime update
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: {
      userSettings: true,
      userCredentials: true,
    },
  });
}

export async function getValidAccessTokenForCredential({
  db,
  userId,
  credentialId,
  encryptionKey,
  refreshTokenCallback,
  forceRefresh = false,
  organizationId,
}: {
  db: DB;
  userId: string;
  credentialId: string;
  encryptionKey: string;
  forceRefresh?: boolean;
  organizationId?: string | null;
  refreshTokenCallback?: (tokenData: {
    refreshToken: string;
  }) => Promise<
    Pick<
      AgentProviderCredentialsDecrypted,
      "accessToken" | "refreshToken" | "idToken" | "expiresAt" | "metadata"
    >
  >;
}): Promise<string | null> {
  const credentialsDecrypted = await getAgentProviderCredentialsDecryptedById({
    db,
    userId,
    credentialId,
    encryptionKey,
    organizationId,
  });
  if (!credentialsDecrypted?.accessToken) {
    return null;
  }
  if (credentialsDecrypted.expiresAt) {
    // Add a 24h buffer before the actual expiration
    // codex tokens last for 10 days, claude tokens last for 8 hours lol
    const bufferMs =
      credentialsDecrypted.agent === "codex"
        ? 10 * 24 * 60 * 60 * 1000
        : 1 * 60 * 60 * 1000;
    const isExpired =
      new Date(credentialsDecrypted.expiresAt).getTime() - bufferMs <
      Date.now();
    if (
      (forceRefresh || isExpired) &&
      credentialsDecrypted.refreshToken &&
      refreshTokenCallback
    ) {
      console.log("[getValidAccessTokenForCredential] Refreshing token", {
        credentialId,
        agent: credentialsDecrypted.agent,
      });
      const refreshed = await refreshTokenCallback({
        refreshToken: credentialsDecrypted.refreshToken,
      });
      const update: Partial<AgentProviderCredentials> = {
        lastRefreshedAt: new Date(),
      };
      if (refreshed.accessToken) {
        update.accessTokenEncrypted = encryptValue(
          refreshed.accessToken,
          encryptionKey,
        );
      }
      if (refreshed.refreshToken) {
        update.refreshTokenEncrypted = encryptValue(
          refreshed.refreshToken,
          encryptionKey,
        );
      }
      if (refreshed.idToken) {
        update.idTokenEncrypted = encryptValue(
          refreshed.idToken,
          encryptionKey,
        );
      }
      if (refreshed.expiresAt) {
        update.expiresAt = new Date(refreshed.expiresAt);
      }
      if (refreshed.metadata) {
        update.metadata = {
          ...credentialsDecrypted.metadata,
          ...refreshed.metadata,
        };
      }
      await db
        .update(schema.agentProviderCredentials)
        .set(update)
        .where(eq(schema.agentProviderCredentials.id, credentialsDecrypted.id));
      return refreshed.accessToken ?? null;
    }
  }
  return credentialsDecrypted.accessToken;
}
