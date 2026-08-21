import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { BlockTolerance } from "@terragon/review/severity-policy";
import { errorFromResponse } from "./error-from-response";

/**
 * Org-wide `blockTolerance` review floor for the caller's active org.
 * Backed by `/api/org-review-settings` (org-fenced via the session cookie —
 * no org id is passed from the client). Mirrors
 * `apps/www/src/queries/review-settings-queries.ts` (the per-repo analog)
 * but there is only ever one row (or none — "no floor").
 */
export interface OrgReviewSettingDto {
  blockTolerance: BlockTolerance | null;
  updatedAt: string;
}

export const orgReviewSettingsQueryKeys = {
  detail: () => ["org-review-settings", "detail"] as const,
};

async function fetchOrgReviewSetting(): Promise<OrgReviewSettingDto | null> {
  const res = await fetch("/api/org-review-settings");
  if (!res.ok) {
    throw await errorFromResponse(res);
  }
  const json = (await res.json()) as { setting: OrgReviewSettingDto | null };
  return json.setting;
}

export function orgReviewSettingsQueryOptions() {
  return {
    queryKey: orgReviewSettingsQueryKeys.detail(),
    queryFn: fetchOrgReviewSetting,
  };
}

export function useOrgReviewSettingsQuery() {
  return useQuery(orgReviewSettingsQueryOptions());
}

/** Pass `blockTolerance: null` to CLEAR the org floor. */
export function useSetOrgReviewSettingMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      blockTolerance,
    }: {
      blockTolerance: BlockTolerance | null;
    }): Promise<OrgReviewSettingDto> => {
      const res = await fetch("/api/org-review-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blockTolerance }),
      });
      if (!res.ok) {
        throw await errorFromResponse(res);
      }
      const json = (await res.json()) as { setting: OrgReviewSettingDto };
      return json.setting;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: orgReviewSettingsQueryKeys.detail(),
      });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}
