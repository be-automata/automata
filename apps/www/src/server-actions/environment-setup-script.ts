"use server";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  getSetupScriptFromEnvironment,
  getSetupScriptFromRepo,
} from "@/server-lib/environment";
import {
  getEnvironment,
  updateEnvironment,
} from "@terragon/shared/model/environments";
import { UserFacingError } from "@/lib/server-actions";

export const updateEnvironmentSetupScript = userOnlyAction(
  async function updateEnvironmentSetupScript(
    userId: string,
    {
      environmentId,
      setupScript,
    }: {
      environmentId: string;
      setupScript: string | null;
    },
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
    await updateEnvironment({
      db,
      userId,
      environmentId,
      organizationId,
      updates: {
        setupScript,
      },
    });
  },
  { defaultErrorMessage: "Failed to update environment setup script" },
);

export const getEnvironmentSetupScript = userOnlyAction(
  async function getEnvironmentSetupScript(
    userId: string,
    {
      environmentId,
    }: {
      environmentId: string;
    },
  ): Promise<{
    type: "environment" | "repo";
    content: string | null;
  } | null> {
    const tenant = await getTenantContextOrNull();
    const organizationId = tenant?.organizationId ?? null;
    const scriptFromEnvironment = await getSetupScriptFromEnvironment({
      db,
      userId,
      environmentId,
      organizationId,
    });
    if (typeof scriptFromEnvironment === "string") {
      return {
        type: "environment",
        content: scriptFromEnvironment,
      };
    }

    const scriptFromRepo = await getSetupScriptFromRepo({
      db,
      userId,
      environmentId,
      organizationId,
    });
    if (typeof scriptFromRepo === "string") {
      return {
        type: "repo",
        content: scriptFromRepo,
      };
    }
    return null;
  },
  { defaultErrorMessage: "Failed to get environment setup script" },
);
