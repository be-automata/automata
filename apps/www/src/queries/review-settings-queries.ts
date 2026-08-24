import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { BlockTolerance } from "@terragon/review/severity-policy";
import type { SupersedePolicy } from "@terragon/shared/model/repo-review-settings";
import { ConflictError, errorFromResponse } from "./error-from-response";

/**
 * Per-repo REQUESTED_CHANGES tolerance overrides for the caller's active org.
 * Backed by the REST endpoints under `/api/review-settings` (org-fenced via the
 * session cookie — no org id is passed from the client). Only repos with an
 * EXPLICIT override are returned; everything else runs on the locked `warning`
 * default. Uses the app's react-query client the same way the other settings
 * queries do, just against a REST route instead of a server action.
 */
export interface RepoReviewSettingDto {
  repoFullName: string;
  blockTolerance: BlockTolerance;
  reviewDraftPrs: boolean;
  supersedePolicy: string | null;
  recheckOnComplete: boolean;
  updatedAt: string;
}

/** Partial patch — send only the field(s) being changed (at least one). */
export interface RepoReviewSettingPatch {
  blockTolerance?: BlockTolerance;
  reviewDraftPrs?: boolean;
  /** null clears the override (falls back to the org default). */
  supersedePolicy?: SupersedePolicy | null;
  recheckOnComplete?: boolean;
  /** Optimistic concurrency fence — a stale value gets a ConflictError. */
  expectedUpdatedAt?: string;
}

export const reviewSettingsQueryKeys = {
  list: () => ["review-settings", "list"] as const,
};

/** Split `owner/name` into its two path segments (name may itself be a slug). */
export function splitRepoFullName(
  repoFullName: string,
): [owner: string, repo: string] {
  const slash = repoFullName.indexOf("/");
  if (slash === -1) {
    throw new Error(
      `Invalid repository "${repoFullName}" (expected owner/name)`,
    );
  }
  return [repoFullName.slice(0, slash), repoFullName.slice(slash + 1)];
}

async function fetchReviewSettings(): Promise<RepoReviewSettingDto[]> {
  const res = await fetch("/api/review-settings");
  if (!res.ok) {
    throw await errorFromResponse(res);
  }
  const json = (await res.json()) as { settings: RepoReviewSettingDto[] };
  return json.settings;
}

export function reviewSettingsQueryOptions() {
  return {
    queryKey: reviewSettingsQueryKeys.list(),
    queryFn: fetchReviewSettings,
  };
}

export function useReviewSettingsQuery() {
  return useQuery(reviewSettingsQueryOptions());
}

export function useSetReviewSettingMutation(options?: {
  /** Toast to show on success (silent by default, matching prior callers). */
  successMessage?: string;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      repoFullName,
      patch,
    }: {
      repoFullName: string;
      patch: RepoReviewSettingPatch;
    }): Promise<RepoReviewSettingDto> => {
      const [owner, repo] = splitRepoFullName(repoFullName);
      const res = await fetch(
        `/api/review-settings/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) {
        throw await errorFromResponse(res);
      }
      const json = (await res.json()) as { setting: RepoReviewSettingDto };
      return json.setting;
    },
    onSuccess: () => {
      if (options?.successMessage) toast.success(options.successMessage);
      queryClient.invalidateQueries({
        queryKey: reviewSettingsQueryKeys.list(),
      });
    },
    onError: (error: unknown) => {
      // Conflicts get a dedicated reload flow at the call site, not a toast.
      if (error instanceof ConflictError) return;
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}

export function useClearReviewToleranceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      repoFullName,
    }: {
      repoFullName: string;
    }): Promise<boolean> => {
      const [owner, repo] = splitRepoFullName(repoFullName);
      const res = await fetch(
        `/api/review-settings/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        throw await errorFromResponse(res);
      }
      const json = (await res.json()) as { removed: boolean };
      return json.removed;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: reviewSettingsQueryKeys.list(),
      });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}
