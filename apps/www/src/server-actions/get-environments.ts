"use server";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getEnvironments as getEnvironmentsFromDB } from "@terragon/shared/model/environments";

export const getEnvironments = userOnlyAction(
  async function getEnvironments(userId: string) {
    const tenant = await getTenantContextOrNull();
    return getEnvironmentsFromDB({
      db,
      userId,
      organizationId: tenant?.organizationId ?? null,
      includeGlobal: false,
    });
  },
  { defaultErrorMessage: "Failed to get environments" },
);
