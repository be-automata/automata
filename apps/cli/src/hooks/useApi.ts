import { useQuery, useMutation } from "@tanstack/react-query";
import { apiClient, Outputs } from "../utils/apiClient.js";
import { safe, isDefinedError } from "@orpc/client";
import { saveApiKey } from "../utils/config.js";

/** Every error code the CLI contract declares for a thread procedure. */
type CliErrorCode =
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "INTERNAL_ERROR"
  | "RATE_LIMIT_EXCEEDED"
  | "SERVICE_UNAVAILABLE"
  | "BAD_REQUEST";

/**
 * The message for a declared error. Exhaustive at the type level: a code the
 * contract adds fails to compile here until it is worded.
 */
function describeCliError(
  error: { code: CliErrorCode },
  { notFound }: { notFound: string },
): string {
  switch (error.code) {
    case "UNAUTHORIZED":
      return "Authentication failed. Try running 'terry auth'.";
    case "NOT_FOUND":
      return notFound;
    case "INTERNAL_ERROR":
      return "Internal server error";
    case "RATE_LIMIT_EXCEEDED":
      return "Rate limit exceeded. Please try again later.";
    case "SERVICE_UNAVAILABLE":
      return "Service temporarily unavailable. Try again shortly.";
    case "BAD_REQUEST":
      return "Invalid request";
    default: {
      const unreachable: never = error.code;
      return `Unknown error: ${unreachable}`;
    }
  }
}

async function fetchThreads(
  repo?: string,
): Promise<Outputs["threads"]["list"]> {
  const [error, result] = await safe(
    apiClient.threads.list({
      repo,
    }),
  );

  if (isDefinedError(error)) {
    throw new Error(describeCliError(error, { notFound: "No tasks found" }));
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
    throw new Error(describeCliError(error, { notFound: "Task not found" }));
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
