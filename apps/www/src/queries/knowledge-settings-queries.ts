import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type {
  KnowledgeControlsDto,
  KnowledgePatch,
  KnowledgeSettingsResponse,
} from "@/components/settings/knowledge/knowledge-form";
import { ConflictError, errorFromResponse } from "./error-from-response";

/** The server refused a budget above the platform ceiling (403). */
export class BudgetAboveCeilingError extends Error {
  constructor(public readonly ceilingMicroUsd: number | null) {
    super("That budget is above the platform ceiling.");
    this.name = "BudgetAboveCeilingError";
  }
}

/** The org is offboarded; the engine cannot be turned on (409). */
export class KnowledgeOffboardedError extends Error {
  constructor() {
    super("This organization is offboarded. Undo the offboarding first.");
    this.name = "KnowledgeOffboardedError";
  }
}

/** The typed confirmation did not match the org slug (400). */
export class ConfirmationMismatchError extends Error {
  constructor() {
    super("The typed text does not match the organization slug.");
    this.name = "ConfirmationMismatchError";
  }
}

export const knowledgeSettingsQueryKeys = {
  detail: () => ["knowledge-settings"] as const,
};

const BASE_URL = "/api/knowledge-settings";

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const json: unknown = await res.clone().json();
    return typeof json === "object" && json !== null
      ? (json as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Typed errors for the knowledge routes; everything else falls through. */
async function knowledgeErrorFromResponse(res: Response): Promise<Error> {
  const body = await readJson(res);
  if (res.status === 403 && body.error === "budget_above_ceiling") {
    return new BudgetAboveCeilingError(
      typeof body.ceilingMicroUsd === "number" ? body.ceilingMicroUsd : null,
    );
  }
  if (res.status === 409 && body.error === "offboarded") {
    return new KnowledgeOffboardedError();
  }
  if (res.status === 400 && body.error === "confirmation_mismatch") {
    return new ConfirmationMismatchError();
  }
  return errorFromResponse(res);
}

async function fetchSettings(): Promise<KnowledgeSettingsResponse> {
  const res = await fetch(BASE_URL);
  if (!res.ok) throw await errorFromResponse(res);
  return (await res.json()) as KnowledgeSettingsResponse;
}

export function useKnowledgeSettings() {
  return useQuery({
    queryKey: knowledgeSettingsQueryKeys.detail(),
    queryFn: fetchSettings,
  });
}

function useWriteControls<TArgs>(
  send: (
    args: TArgs,
    cached: KnowledgeSettingsResponse | undefined,
  ) => Promise<Response>,
  successMessage: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: TArgs): Promise<KnowledgeControlsDto> => {
      const cached = queryClient.getQueryData<KnowledgeSettingsResponse>(
        knowledgeSettingsQueryKeys.detail(),
      );
      const res = await send(args, cached);
      if (!res.ok) throw await knowledgeErrorFromResponse(res);
      const json = (await res.json()) as { controls: KnowledgeControlsDto };
      return json.controls;
    },
    onSuccess: (controls) => {
      toast.success(successMessage);
      // Synchronous cache write of the returned controls: the PUT/POST
      // response IS the stored row, and a refetch-only flow leaves a window
      // where the next save still carries the prior updatedAt and 409s
      // against itself. The invalidate then refreshes spend and actions.
      queryClient.setQueryData<KnowledgeSettingsResponse>(
        knowledgeSettingsQueryKeys.detail(),
        (prev) => (prev ? { ...prev, controls } : prev),
      );
      void queryClient.invalidateQueries({
        queryKey: knowledgeSettingsQueryKeys.detail(),
      });
    },
    onError: (error: unknown) => {
      // The section renders these inline (reload banner, ceiling alert, ...).
      if (
        error instanceof ConflictError ||
        error instanceof BudgetAboveCeilingError ||
        error instanceof KnowledgeOffboardedError ||
        error instanceof ConfirmationMismatchError
      ) {
        return;
      }
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
}

export function useUpdateKnowledgeSettings() {
  return useWriteControls<KnowledgePatch>(
    (patch, cached) =>
      fetch(BASE_URL, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...patch,
          expectedUpdatedAt: cached?.controls?.updatedAt ?? null,
        }),
      }),
    "Knowledge settings saved.",
  );
}

export type KnowledgeOffboardArgs =
  | { action: "offboard"; confirm: string }
  | { action: "undo" };

export function useKnowledgeOffboard() {
  return useWriteControls<KnowledgeOffboardArgs>(
    (args) =>
      fetch(`${BASE_URL}/offboard`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      }),
    "Knowledge offboarding updated.",
  );
}
