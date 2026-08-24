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

export function useSetSupersedeDefaultMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      supersedePolicy?: SupersedePolicy | null;
      recheckOnComplete?: boolean;
      expectedUpdatedAt?: string;
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
    onSuccess: () => {
      toast.success("Org default saved. Applies to new runs.");
      queryClient.invalidateQueries({
        queryKey: supersedeDefaultQueryKeys.detail(),
      });
    },
    onError: (error: unknown) => {
      if (error instanceof ConflictError) return; // section renders the reload row
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}
