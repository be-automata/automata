import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { AIAgent, AIAgentCredentials, AIModel } from "@terragon/agent/types";
import { getAgentProviderCredentialsDecrypted } from "@terragon/shared/model/agent-provider-credentials";
import { getCodexCredentialsJSONOrNull } from "@/agent/msg/codexCredentials";
import { getClaudeCredentialsJSONOrNull } from "@/agent/msg/claudeCredentials";
import { ThreadError } from "./error";

export async function getAndVerifyCredentials({
  agent,
  model: _model,
  userId,
  organizationId,
}: {
  agent: AIAgent;
  model: AIModel | null;
  userId: string;
  // Tenant of the thread this agent run belongs to (WI-5 batch 3a). Fences the
  // credential lookup to this org's credential.
  organizationId?: string | null;
}): Promise<AIAgentCredentials> {
  switch (agent) {
    case "amp": {
      const ampCredentials = await getAgentProviderCredentialsDecrypted({
        db,
        userId,
        organizationId,
        agent: "amp",
        encryptionKey: env.ENCRYPTION_MASTER_KEY,
      });
      const ampApiKey = ampCredentials?.apiKey ?? null;
      if (!ampApiKey) {
        throw new ThreadError(
          "missing-amp-credentials",
          "User does not have Amp API key.",
          null,
        );
      }
      return {
        type: "env-var",
        key: "AMP_API_KEY",
        value: ampApiKey,
      };
    }
    case "codex": {
      const codexCredentials = await getCodexCredentialsJSONOrNull({
        userId,
        organizationId,
      });
      if (codexCredentials.contents) {
        return {
          type: "json-file",
          contents: codexCredentials.contents,
        };
      }
      if (codexCredentials.error) {
        throw new ThreadError(
          "invalid-codex-credentials",
          codexCredentials.error,
          null,
        );
      }
      return {
        type: "built-in-credits",
      };
    }
    case "claudeCode": {
      const claudeCredentials = await getClaudeCredentialsJSONOrNull({
        userId,
        organizationId,
      });
      if (claudeCredentials.contents) {
        return {
          type: "json-file",
          contents: claudeCredentials.contents,
        };
      }
      if (claudeCredentials.error) {
        throw new ThreadError(
          "invalid-claude-credentials",
          claudeCredentials.error,
          null,
        );
      }
      return {
        type: "built-in-credits",
      };
    }
    case "gemini":
    case "opencode": {
      return {
        type: "built-in-credits",
      };
    }
    default: {
      const _exhaustiveCheck: never = agent;
      throw new Error(`Unknown agent: ${_exhaustiveCheck}`);
    }
  }
}
