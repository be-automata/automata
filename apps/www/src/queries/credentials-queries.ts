import {
  getServerActionQueryOptions,
  useServerActionMutation,
} from "./server-action-helpers";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentProviderCredentialsMap } from "@/server-lib/credentials";
import {
  deleteAgentProviderCredential,
  saveAgentProviderApiKey,
  getAgentProviderCredentialsAction,
  setAgentProviderCredentialActive,
} from "@/server-actions/credentials";
import { toast } from "sonner";
import { saveCodexAuthJson } from "@/server-actions/codex-auth";
import { saveClaudeSetupToken } from "@/server-actions/claude-setup-token";
import { exchangeCode } from "@/server-actions/claude-oauth";
import { AIAgent } from "@terragon/agent/types";

export const credentialsQueryKeys = {
  list: () => ["credentials", "list"] as const,
};

export function credentialsQueryOptions() {
  return getServerActionQueryOptions<AgentProviderCredentialsMap>({
    queryKey: credentialsQueryKeys.list(),
    queryFn: () => getAgentProviderCredentialsAction(),
  });
}

export function useCredentials() {
  return useQuery(credentialsQueryOptions());
}

export function useSaveApiKeyMutation() {
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn: saveAgentProviderApiKey,
    onSuccess: () => {
      toast.success("API key saved");
      queryClient.invalidateQueries({
        queryKey: credentialsQueryKeys.list(),
      });
    },
  });
}

export function useToggleActiveCredentialMutation() {
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn: setAgentProviderCredentialActive,
    onMutate: async ({ credentialId, isActive }) => {
      await queryClient.cancelQueries({
        queryKey: credentialsQueryKeys.list(),
      });
      const previousCredentials =
        queryClient.getQueryData<AgentProviderCredentialsMap>(
          credentialsQueryKeys.list(),
        );

      if (previousCredentials) {
        const credentialsCopy = { ...previousCredentials };

        let targetAgent: AIAgent | undefined;
        for (const [k, v] of Object.entries(credentialsCopy)) {
          const agent = k as keyof AgentProviderCredentialsMap;
          const credential = v.find((c) => c.id === credentialId);
          if (credential) {
            targetAgent = agent;
            break;
          }
        }

        if (targetAgent && credentialsCopy[targetAgent]) {
          const credentials = credentialsCopy[targetAgent];
          if (credentials) {
            if (isActive) {
              credentialsCopy[targetAgent] = credentials.map((c) => ({
                ...c,
                isActive: c.id === credentialId,
              }));
            } else {
              credentialsCopy[targetAgent] = credentials.map((c) =>
                c.id === credentialId ? { ...c, isActive: false } : c,
              );
            }
            queryClient.setQueryData(
              credentialsQueryKeys.list(),
              credentialsCopy,
            );
          }
        }
      }
      return { previousCredentials };
    },
    onSuccess: (_, { isActive }) => {
      toast.success(
        isActive ? "Credential activated" : "Credential deactivated",
      );
    },
    onError: (_, __, context) => {
      if (context?.previousCredentials) {
        queryClient.setQueryData(
          credentialsQueryKeys.list(),
          context.previousCredentials,
        );
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: credentialsQueryKeys.list() });
    },
  });
}

export function useDeleteCredentialsMutation() {
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn: deleteAgentProviderCredential,
    onMutate: async ({ credentialId }) => {
      await queryClient.cancelQueries({
        queryKey: credentialsQueryKeys.list(),
      });
      const previousCredentials =
        queryClient.getQueryData<AgentProviderCredentialsMap>(
          credentialsQueryKeys.list(),
        );
      if (previousCredentials) {
        const credentialsCopy = { ...previousCredentials };
        for (const [k, v] of Object.entries(credentialsCopy)) {
          const agent = k as keyof AgentProviderCredentialsMap;
          credentialsCopy[agent] = v.filter((c) => c.id !== credentialId);
          if (credentialsCopy[agent].length === 0) {
            delete credentialsCopy[agent];
          }
        }
        queryClient.setQueryData(credentialsQueryKeys.list(), credentialsCopy);
      }
      return { previousCredentials };
    },
    onSuccess: () => {
      toast.success("Credential deleted");
    },
    onError: (_, __, context) => {
      if (context?.previousCredentials) {
        queryClient.setQueryData(
          credentialsQueryKeys.list(),
          context.previousCredentials,
        );
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: credentialsQueryKeys.list() });
    },
  });
}

export function useSaveCodexAuthJsonMutation() {
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn: saveCodexAuthJson,
    onSuccess: () => {
      toast.success("Codex credentials saved");
      queryClient.invalidateQueries({
        queryKey: credentialsQueryKeys.list(),
      });
    },
  });
}

export function useSaveClaudeSetupTokenMutation() {
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn: saveClaudeSetupToken,
    onSuccess: () => {
      toast.success("Claude setup token saved");
      queryClient.invalidateQueries({
        queryKey: credentialsQueryKeys.list(),
      });
    },
  });
}

export function useExchangeClaudeAuthorizationCodeMutation() {
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn: exchangeCode,
    onSuccess: () => {
      toast.success("Claude credentials saved");
      queryClient.invalidateQueries({
        queryKey: credentialsQueryKeys.list(),
      });
    },
  });
}
