import { db } from "@/lib/db";
import {
  getAllAgentProviderCredentialRecords,
  decryptCredentials,
} from "@terragon/shared/model/agent-provider-credentials";
import { AIAgent } from "@terragon/agent/types";
import { AgentProviderCredentials } from "@terragon/shared";
import { env } from "@terragon/env/apps-www";

type AgentProviderCredentialsData = Pick<
  AgentProviderCredentials,
  | "id"
  | "type"
  | "agent"
  | "isActive"
  | "apiKeyEncrypted"
  | "accessTokenEncrypted"
  | "metadata"
  | "createdAt"
>;

export type AgentProviderCredentialsMap = {
  [key in AIAgent]?: AgentProviderCredentialsData[];
};

function parseJwtPayload(idToken: string): {
  email?: string;
  planType?: string;
  chatgptAccountId?: string;
} {
  try {
    // JWT format: header.payload.signature
    const parts = idToken.split(".");
    if (parts.length === 3) {
      // Decode the payload (second part) - base64url encoding
      const payload = JSON.parse(
        Buffer.from(parts[1]!, "base64url").toString("utf-8"),
      );
      return {
        email: payload.email,
        planType: payload["https://api.openai.com/auth.chatgpt_plan_type"],
        chatgptAccountId:
          payload["https://api.openai.com/auth.chatgpt_account_id"],
      };
    }
  } catch (err) {
    console.warn("Failed to parse JWT id_token:", err);
  }
  return {};
}

export async function getAgentProviderCredentials({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId?: string | null;
}) {
  const agentProviderCredentials = await getAllAgentProviderCredentialRecords({
    db,
    userId,
    organizationId,
  });
  // Group credentials by agent and sort by createdAt (earliest first)
  const grouped = agentProviderCredentials.reduce(
    (acc, credential) => {
      if (!acc[credential.agent]) {
        acc[credential.agent] = [];
      }

      // For Codex OAuth credentials, parse the JWT to extract fields
      let metadata = credential.metadata;
      if (
        credential.agent === "codex" &&
        credential.type === "oauth" &&
        credential.idTokenEncrypted
      ) {
        try {
          const decrypted = decryptCredentials({
            credentials: credential,
            encryptionKey: env.ENCRYPTION_MASTER_KEY,
          });
          if (decrypted.idToken) {
            const parsed = parseJwtPayload(decrypted.idToken);
            // Preserve existing metadata structure and merge parsed fields
            const existingMetadata = metadata as {
              type: "openai";
              accountId?: string;
            } | null;
            metadata = {
              type: "openai",
              accountId: existingMetadata?.accountId,
              ...parsed,
            };
          }
        } catch (err) {
          console.warn("Failed to decrypt and parse Codex JWT:", err);
        }
      }

      acc[credential.agent].push({
        id: credential.id,
        type: credential.type,
        agent: credential.agent,
        isActive: credential.isActive,
        apiKeyEncrypted: credential.apiKeyEncrypted,
        accessTokenEncrypted: credential.accessTokenEncrypted,
        metadata,
        createdAt: credential.createdAt,
      });
      return acc;
    },
    {} as Record<AIAgent, AgentProviderCredentialsData[]>,
  );

  // Sort credentials within each agent by createdAt (earliest first)
  for (const agent of Object.keys(grouped) as AIAgent[]) {
    grouped[agent]?.sort((a, b) => {
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
  }

  return grouped;
}
