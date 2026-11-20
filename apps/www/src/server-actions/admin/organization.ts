"use server";

import { adminOnly } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { User } from "@terragon/shared";
import { setOrganizationCellsEnabled } from "@terragon/shared/model/organizations";

export type SetOrganizationCellsEnabledResult =
  | { ok: true }
  | { ok: false; error: "invalid_input" | "not_found" };

/**
 * #708: switches an org's OpenSandbox cells gate. Applies on the next dispatch
 * and cell-plan (both read the row per call); no deploy.
 */
export const setOrganizationCellsEnabledAction = adminOnly(
  async function setOrganizationCellsEnabledAction(
    adminUser: User,
    input: { organizationId: string; enabled: boolean },
  ): Promise<SetOrganizationCellsEnabledResult> {
    if (
      typeof input?.organizationId !== "string" ||
      input.organizationId.trim() === "" ||
      typeof input.enabled !== "boolean"
    ) {
      return { ok: false, error: "invalid_input" };
    }
    const updated = await setOrganizationCellsEnabled({
      db,
      organizationId: input.organizationId,
      enabled: input.enabled,
    });
    if (!updated) return { ok: false, error: "not_found" };
    // Ids and a boolean only.
    console.log("[admin:org-cells]", {
      actorUserId: adminUser.id,
      organizationId: input.organizationId,
      enabled: input.enabled,
    });
    return { ok: true };
  },
);
