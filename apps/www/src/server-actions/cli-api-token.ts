"use server";

import { auth } from "@/lib/auth";
import { nanoid } from "nanoid/non-secure";
import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";

export const createCliApiToken = userOnlyAction(
  async function createCliApiToken(userId: string) {
    // Stamp the minting user's active org into the key metadata (WI-5) so the
    // CLI daemon-token read path (getDaemonTokenContext) resolves a tenant.
    // Without this the CLI org fence no-ops. Nullable-safe: no active org =
    // no metadata = today's behavior (user-only fence).
    const tenant = await getTenantContextOrNull();
    const cliApiKey = await auth.api.createApiKey({
      body: {
        name: `cli-${nanoid()}`,
        expiresIn: 60 * 60 * 24 * 30, // 30 days,
        userId,
        ...(tenant?.organizationId
          ? { metadata: { organizationId: tenant.organizationId } }
          : {}),
      },
    });
    return cliApiKey.key;
  },
  { defaultErrorMessage: "Failed to create CLI API token" },
);
