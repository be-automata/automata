"use server";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { getUserCredentials } from "@/server-lib/user-credentials";

export const getUserCredentialsAction = userOnlyAction(
  async function getUserCredentialsAction(userId: string) {
    console.log("getUserCredentialsAction");
    const tenant = await getTenantContextOrNull();
    return getUserCredentials({
      userId,
      organizationId: tenant?.organizationId ?? null,
    });
  },
  { defaultErrorMessage: "Failed to get user credentials" },
);
