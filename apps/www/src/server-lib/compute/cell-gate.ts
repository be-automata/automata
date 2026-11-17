import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import { normalizeCellBrokerHost } from "@terragon/shared/model/cell-egress";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";

import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";

/**
 * Whether cells are on, and the two facts every cell route derives from the
 * deployment. Env and flags only: it imports no provider, reconciler or
 * authority code, so dispatch and the routes can load it cheaply.
 */

export const OPENSANDBOX_RUNC_PROFILE_ID = "opensandbox/runc";

/** "Configured" means the URL and the API key are both non-empty. */
export function opensandboxConfigured(): boolean {
  return (
    env.OPENSANDBOX_URL.trim() !== "" && env.OPENSANDBOX_API_KEY.trim() !== ""
  );
}

/** Configured and the per-user `opensandboxCells` flag is on. */
export async function cellsEnabledForUser({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}): Promise<boolean> {
  return (
    opensandboxConfigured() &&
    (await getFeatureFlagForUser({ db, userId, flagName: "opensandboxCells" }))
  );
}

/** This deployment's public host, as the compiled egress set allows it. */
export function cellBrokerHost(): string {
  return normalizeCellBrokerHost(new URL(nonLocalhostPublicAppUrl()).hostname);
}
