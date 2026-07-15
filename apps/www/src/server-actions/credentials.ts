"use server";

import { db } from "@/lib/db";
import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import {
  insertAgentProviderCredentials,
  updateAgentProviderCredentialsById,
  deleteAgentProviderCredentialById,
} from "@terragon/shared/model/agent-provider-credentials";
import { getPostHogServer } from "@/lib/posthog-server";
import { env } from "@terragon/env/apps-www";
import { UserFacingError } from "@/lib/server-actions";
import { AIAgent } from "@terragon/agent/types";
import { getAgentProviderCredentials } from "@/server-lib/credentials";

export const getAgentProviderCredentialsAction = userOnlyAction(
  async function getAgentProviderCredentialsAction(userId: string) {
    const tenant = await getTenantContextOrNull();
    return getAgentProviderCredentials({
      userId,
      organizationId: tenant?.organizationId ?? null,
    });
  },
  { defaultErrorMessage: "Failed to fetch credentials" },
);

function validateApiKeyFormat({
  apiKey,
  agent,
}: {
  apiKey: string;
  agent: AIAgent;
}) {
  switch (agent) {
    case "amp": {
      if (!apiKey || !apiKey.startsWith("sgamp_user")) {
        throw new UserFacingError("Invalid API key format");
      }
      break;
    }
    case "gemini": {
      if (!apiKey || !apiKey.startsWith("AIza")) {
        throw new UserFacingError("Invalid API key format");
      }
      break;
    }
    case "claudeCode": {
      if (!apiKey || !apiKey.startsWith("sk-ant-")) {
        throw new UserFacingError("Invalid API key format");
      }
      break;
    }
    case "codex": {
      if (!apiKey || !apiKey.startsWith("sk-")) {
        throw new UserFacingError("Invalid API key format");
      }
      break;
    }
  }
}

export const saveAgentProviderApiKey = userOnlyAction(
  async function saveAgentProviderApiKey(
    userId: string,
    { agent, apiKey }: { agent: AIAgent; apiKey: string },
  ) {
    validateApiKeyFormat({ apiKey, agent });
    getPostHogServer().capture({
      distinctId: userId,
      event: "agent_provider_credentials_saved",
      properties: {
        type: "api-key",
        agent,
      },
    });
    const tenant = await getTenantContextOrNull();
    await insertAgentProviderCredentials({
      db,
      userId,
      organizationId: tenant?.organizationId ?? null,
      credentialData: {
        type: "api-key",
        agent,
        apiKey,
        isActive: true,
        expiresAt: null,
        lastRefreshedAt: null,
        metadata: null,
      },
      encryptionKey: env.ENCRYPTION_MASTER_KEY,
    });
  },
  { defaultErrorMessage: "Failed to save API key" },
);

export const deleteAgentProviderCredential = userOnlyAction(
  async function deleteAgentProviderCredential(
    userId: string,
    { credentialId }: { credentialId: string },
  ) {
    getPostHogServer().capture({
      distinctId: userId,
      event: "agent_provider_credential_deleted",
      properties: {
        credentialId,
      },
    });
    const tenant = await getTenantContextOrNull();
    await deleteAgentProviderCredentialById({
      db,
      userId,
      credentialId,
      organizationId: tenant?.organizationId ?? null,
    });
  },
  { defaultErrorMessage: "Failed to delete" },
);

export const setAgentProviderCredentialActive = userOnlyAction(
  async function setAgentProviderCredentialActive(
    userId: string,
    { credentialId, isActive }: { credentialId: string; isActive: boolean },
  ) {
    getPostHogServer().capture({
      distinctId: userId,
      event: "agent_provider_credential_updated",
      properties: {
        credentialId,
        isActive,
      },
    });
    const tenant = await getTenantContextOrNull();
    await updateAgentProviderCredentialsById({
      db,
      userId,
      credentialId,
      organizationId: tenant?.organizationId ?? null,
      updates: { isActive },
    });
  },
  { defaultErrorMessage: "Failed to update" },
);
