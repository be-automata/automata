"use server";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";

import {
  getEnvironment,
  updateEnvironment,
} from "@terragon/shared/model/environments";
import { encryptValue } from "@terragon/utils/encryption";
import { env } from "@terragon/env/apps-www";
import { getPostHogServer } from "@/lib/posthog-server";
import { UserFacingError } from "@/lib/server-actions";
import {
  EnvironmentVariable,
  validateEnvironmentVariables,
} from "@/server-lib/environment-variables";

export const updateEnvironmentVariables = userOnlyAction(
  async function updateEnvironmentVariables(
    userId: string,
    {
      environmentId,
      variables,
    }: {
      environmentId: string;
      variables: EnvironmentVariable[];
    },
  ) {
    getPostHogServer().capture({
      distinctId: userId,
      event: "update_environment_variables",
      properties: {
        environmentId,
      },
    });

    // Verify the user owns this environment (within the active org)
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
    await validateEnvironmentVariables(variables);
    // Update the environment with the new variables
    await updateEnvironment({
      db,
      userId,
      environmentId,
      organizationId,
      updates: {
        environmentVariables: variables.map((variable) => ({
          key: variable.key,
          valueEncrypted: encryptValue(
            variable.value,
            env.ENCRYPTION_MASTER_KEY,
          ),
        })),
      },
    });
    return { success: true };
  },
  { defaultErrorMessage: "Failed to update environment variables" },
);
