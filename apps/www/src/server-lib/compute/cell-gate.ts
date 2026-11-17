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

/** The origin when `url` is an https URL, else null. */
export function httpsOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The Cloudflare Access service token (#656 PR-C): "off" when neither value is
 * set (dev), "ok" when both are set and the URL is https, else "invalid".
 */
export function opensandboxAccessState(): "off" | "ok" | "invalid" {
  const id = env.OPENSANDBOX_ACCESS_CLIENT_ID.trim();
  const secret = env.OPENSANDBOX_ACCESS_CLIENT_SECRET.trim();
  if (id === "" && secret === "") return "off";
  return id !== "" && secret !== "" && httpsOrigin(env.OPENSANDBOX_URL) !== null
    ? "ok"
    : "invalid";
}

/** The URL and the API key are both non-empty (before the Access check). */
export function opensandboxUrlAndKeySet(): boolean {
  return (
    env.OPENSANDBOX_URL.trim() !== "" && env.OPENSANDBOX_API_KEY.trim() !== ""
  );
}

/**
 * "Configured" means the URL and the API key are both non-empty and the Access
 * token is complete (both values or neither) over https: cell-plan, dispatch
 * and the reconciler all treat a half-set pair as cells off, together.
 */
export function opensandboxConfigured(): boolean {
  return opensandboxUrlAndKeySet() && opensandboxAccessState() !== "invalid";
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
