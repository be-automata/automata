import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SupersedePolicy } from "@terragon/shared/model/repo-review-settings";
import { errorFromResponse } from "./error-from-response";
import { reviewSettingsQueryKeys } from "./review-settings-queries";

/**
 * The org-default supersede policy (#125 C6) — the sentinel row behind
 * `/api/review-settings/default`. Mirrors org-review-settings-queries.ts.
 * A 409 (another admin saved concurrently) is surfaced as a conflict error
 * the section renders with a Reload action — never a silent overwrite.
 */
export interface SupersedeDefaultDto {
  supersedePolicy: SupersedePolicy | null;
  recheckOnComplete: boolean;
  updatedAt: string;
}

export const supersedeDefaultQueryKeys = {
  detail: () => ["supersede-policy", "default"] as const,
};

export class ConflictError extends Error {
  constructor(public readonly currentUpdatedAt: string | null) {
    super("Another admin just saved changes to this setting.");
    this.name = "ConflictError";
  }
}

async function throwFrom(res: Response): Promise<never> {
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      currentUpdatedAt?: string;
    };
    throw new ConflictError(body.currentUpdatedAt ?? null);
  }
  throw await errorFromResponse(res);
}

async function fetchDefault(): Promise<SupersedeDefaultDto | null> {
  const res = await fetch("/api/review-settings/default");
  if (!res.ok) return throwFrom(res);
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
      if (!res.ok) return throwFrom(res);
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

/** Per-repo override of the policy — same PUT the tolerance uses. */
export function useSetSupersedeOverrideMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      repoFullName,
      supersedePolicy,
      recheckOnComplete,
      expectedUpdatedAt,
    }: {
      repoFullName: string;
      /** null clears the override (falls back to the org default). */
      supersedePolicy: SupersedePolicy | null;
      recheckOnComplete?: boolean;
      expectedUpdatedAt?: string;
    }) => {
      const slash = repoFullName.indexOf("/");
      const owner = repoFullName.slice(0, slash);
      const repo = repoFullName.slice(slash + 1);
      const res = await fetch(
        `/api/review-settings/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            supersedePolicy,
            ...(recheckOnComplete !== undefined ? { recheckOnComplete } : {}),
            ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}),
          }),
        },
      );
      if (!res.ok) return throwFrom(res);
      return (await res.json()) as { setting: unknown };
    },
    onSuccess: () => {
      toast.success("Repo override saved. Applies to new runs.");
      queryClient.invalidateQueries({
        queryKey: reviewSettingsQueryKeys.list(),
      });
    },
    onError: (error: unknown) => {
      if (error instanceof ConflictError) return;
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}
