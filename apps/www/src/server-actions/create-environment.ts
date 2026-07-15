"use server";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getOrCreateEnvironment } from "@terragon/shared/model/environments";

export const createEnvironment = userOnlyAction(
  async function createEnvironment(
    userId: string,
    { repoFullName }: { repoFullName: string },
  ) {
    const tenant = await getTenantContextOrNull();
    const environment = await getOrCreateEnvironment({
      db,
      userId,
      organizationId: tenant?.organizationId ?? null,
      repoFullName,
    });
    return environment;
  },
  { defaultErrorMessage: "Failed to create environment" },
);
