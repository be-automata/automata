"use server";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  deleteEnvironmentById,
  getEnvironment,
} from "@terragon/shared/model/environments";
import { getPostHogServer } from "@/lib/posthog-server";
import { UserFacingError } from "@/lib/server-actions";

export const deleteEnvironment = userOnlyAction(
  async function deleteEnvironment(
    userId: string,
    { environmentId }: { environmentId: string },
  ) {
    const tenant = await getTenantContextOrNull();
    const organizationId = tenant?.organizationId ?? null;
    const environment = await getEnvironment({
      db,
      environmentId,
      userId,
      organizationId,
    });

    if (!environment) {
      throw new UserFacingError("Environment not found");
    }

    getPostHogServer().capture({
      distinctId: userId,
      event: "delete_environment",
      properties: {
        environmentId,
        repoFullName: environment.repoFullName,
      },
    });

    await deleteEnvironmentById({
      db,
      userId,
      environmentId,
      organizationId,
    });

    return { success: true };
  },
  { defaultErrorMessage: "Failed to delete environment" },
);
