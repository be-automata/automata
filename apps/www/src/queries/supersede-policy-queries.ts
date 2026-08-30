import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SupersedePolicy } from "@terragon/shared/model/repo-review-settings";
import { ConflictError, errorFromResponse } from "./error-from-response";

/**
 * The org-default supersede policy (#125 C6) — the sentinel row behind
 * `/api/review-settings/default`. Per-repo overrides go through the existing
 * `useSetReviewSettingMutation` (same endpoint as the tolerance overrides).
 * A 409 (another admin saved concurrently) surfaces as {@link ConflictError},
 * which the section renders with a Reload action — never a silent overwrite.
 */
export interface SupersedeDefaultDto {
  supersedePolicy: SupersedePolicy | null;
  recheckOnComplete: boolean;
  /** Org-wide draft-PR default. Tri-state: null = the org has not chosen
   * (effective default true). */
  reviewDraftPrs: boolean | null;
  updatedAt: string;
}

export const supersedeDefaultQueryKeys = {
  detail: () => ["supersede-policy", "default"] as const,
};

async function fetchDefault(): Promise<SupersedeDefaultDto | null> {
  const res = await fetch("/api/review-settings/default");
  if (!res.ok) throw await errorFromResponse(res);
  const json = (await res.json()) as { setting: SupersedeDefaultDto | null };
  return json.setting;
}

export function useSupersedeDefaultQuery() {
  return useQuery({
    queryKey: supersedeDefaultQueryKeys.detail(),
    queryFn: fetchDefault,
  });
}

export function useSetSupersedeDefaultMutation(options?: {
  /** Toast on success — callers name their own outcome (the supersede card
   * talks about runs, the draft card about PR events). */
  successMessage?: string;
}) {
  const queryClient = useQueryClient();
  const successMessage =
    options?.successMessage ?? "Org default saved. Applies to new runs.";
  return useMutation({
    mutationFn: async (args: {
      supersedePolicy?: SupersedePolicy | null;
      recheckOnComplete?: boolean;
      reviewDraftPrs?: boolean | null;
      expectedUpdatedAt?: string | null;
    }): Promise<SupersedeDefaultDto> => {
      const res = await fetch("/api/review-settings/default", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      if (!res.ok) throw await errorFromResponse(res);
      const json = (await res.json()) as { setting: SupersedeDefaultDto };
      return json.setting;
    },
    onSuccess: (setting) => {
      toast.success(successMessage);
      // Synchronous cache write of the returned row. Two cards share this
      // sentinel row's cache entry; invalidate-only left a window where the
      // sibling still held the prior updatedAt and self-409ed on its next
      // save. The PUT response IS the stored row, so no refetch needed.
      queryClient.setQueryData(supersedeDefaultQueryKeys.detail(), setting);
    },
    onError: (error: unknown) => {
      if (error instanceof ConflictError) return; // section renders the reload row
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}
