import { db } from "@/lib/db";
import { getAllAgentProviderCredentialRecords } from "@terragon/shared/model/agent-provider-credentials";
import { UserCredentials } from "@terragon/shared";

export async function getUserCredentials({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId?: string | null;
}): Promise<UserCredentials> {
  const agentProviderCredentials = await getAllAgentProviderCredentialRecords({
    db,
    userId,
    organizationId,
    isActive: true,
  });
  const result: UserCredentials = {
    hasClaude: false,
    hasAmp: false,
    hasOpenAI: false,
    hasOpenAIOAuthCredentials: false,
  };
  for (const credential of agentProviderCredentials) {
    switch (credential.agent) {
      case "claudeCode":
        result.hasClaude = true;
        break;
      case "codex":
        result.hasOpenAI = true;
        result.hasOpenAIOAuthCredentials =
          result.hasOpenAIOAuthCredentials || credential.type === "oauth";
        break;
      case "amp":
        result.hasAmp = true;
        break;
    }
  }
  return result;
}
