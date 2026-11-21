import { useQuery, useMutation } from "@tanstack/react-query";
import { apiClient, Outputs } from "../utils/apiClient.js";
import { safe, isDefinedError } from "@orpc/client";
import { saveApiKey } from "../utils/config.js";

async function fetchThreads(
  repo?: string,
): Promise<Outputs["threads"]["list"]> {
  const [error, result] = await safe(
    apiClient.threads.list({
      repo,
    }),
  );

  if (isDefinedError(error)) {
    switch (error.code) {
      case "UNAUTHORIZED":
        throw new Error("Authentication failed. Try running 'terry auth'.");
      case "NOT_FOUND":
        throw new Error("No tasks found");
      case "INTERNAL_ERROR":
        throw new Error("Internal server error");
      case "RATE_LIMIT_EXCEEDED":
        throw new Error("Rate limit exceeded. Please try again later.");
      case "SERVICE_UNAVAILABLE":
        throw new Error("Service temporarily unavailable. Try again shortly.");
      default:
        const _exhaustiveCheck: never = error;
        throw new Error(`Unknown error: ${_exhaustiveCheck}`);
    }
  } else if (error) {
    throw new Error("Failed to fetch tasks");
  }

  return result;
}

async function fetchThreadDetail(
  threadId: string,
): Promise<Outputs["threads"]["detail"]> {
  const [error, result] = await safe(
    apiClient.threads.detail({
      threadId,
    }),
  );

  if (isDefinedError(error)) {
    switch (error.code) {
      case "UNAUTHORIZED":
        throw new Error("Authentication failed. Try running 'terry auth'.");
      case "NOT_FOUND":
        throw new Error("Task not found");
      case "INTERNAL_ERROR":
        throw new Error("Internal server error");
      case "RATE_LIMIT_EXCEEDED":
        throw new Error("Rate limit exceeded. Please try again later.");
      case "SERVICE_UNAVAILABLE":
        throw new Error("Service temporarily unavailable. Try again shortly.");
      default:
        const _exhaustiveCheck: never = error;
        throw new Error(`Unknown error: ${_exhaustiveCheck}`);
    }
  } else if (error) {
    throw new Error("Failed to fetch task detail");
  }

  return result;
}

export function useThreads(repo?: string) {
  return useQuery({
    queryKey: ["threads", repo],
    queryFn: () => fetchThreads(repo),
  });
}

export function useThreadDetail(threadId: string | undefined) {
  return useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => fetchThreadDetail(threadId!),
    enabled: !!threadId,
  });
}

export function useSaveApiKey() {
  return useMutation({
    mutationFn: async (apiKey: string) => {
      await saveApiKey(apiKey);
    },
  });
}
