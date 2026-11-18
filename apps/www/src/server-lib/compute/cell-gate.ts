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
function httpsOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The OpenSandbox env, read and trimmed once:
 * - `off`: the URL or the API key is empty;
 * - `invalid`: the Cloudflare Access service token (#656 PR-C) is half set, or
 *   set over a non-https URL;
 * - `ok`: `access` is the token and its origin, or null when neither value is
 *   set (dev, plain fetch).
 */
export type OpenSandboxEnv =
  | { state: "off" }
  | { state: "invalid" }
  | {
      state: "ok";
      url: string;
      apiKey: string;
      access: { origin: string; clientId: string; clientSecret: string } | null;
    };

export function resolveOpenSandboxEnv(): OpenSandboxEnv {
  const url = env.OPENSANDBOX_URL.trim();
  const apiKey = env.OPENSANDBOX_API_KEY.trim();
  if (url === "" || apiKey === "") return { state: "off" };
  const clientId = env.OPENSANDBOX_ACCESS_CLIENT_ID.trim();
  const clientSecret = env.OPENSANDBOX_ACCESS_CLIENT_SECRET.trim();
  if (clientId === "" && clientSecret === "") {
    return { state: "ok", url, apiKey, access: null };
  }
  const origin = httpsOrigin(url);
  if (clientId === "" || clientSecret === "" || origin === null) {
    return { state: "invalid" };
  }
  return {
    state: "ok",
    url,
    apiKey,
    access: { origin, clientId, clientSecret },
  };
}

/**
 * "Configured" means the URL and the API key are both non-empty and the Access
 * token is complete (both values or neither) over https: cell-plan, dispatch
 * and the reconciler all treat a half-set pair as cells off, together.
 */
export function opensandboxConfigured(): boolean {
  return resolveOpenSandboxEnv().state === "ok";
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
