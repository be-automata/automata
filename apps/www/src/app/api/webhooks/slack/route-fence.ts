import type { DB } from "@terragon/shared/db";
import type { SlackInstallation } from "@terragon/shared/db/types";

import { resolveSlackAppConfig } from "@/server-lib/slack-config";

/**
 * Which Slack app signed the request being handled. The platform app posts to
 * /api/webhooks/slack; an org's own app posts to /api/webhooks/slack/<orgId>.
 */
export type SlackRequestRoute =
  | { kind: "platform" }
  | { kind: "organization"; organizationId: string };

export const PLATFORM_SLACK_ROUTE: SlackRequestRoute = { kind: "platform" };

/**
 * A verified signature proves which Slack app sent the request — not which
 * workspace it speaks for: an org admin holds their app's signing secret and
 * can sign any `team` id. So a request may only act on an installation made
 * through the same app:
 *
 *   org route      → the installation is bound to that org.
 *   platform route → the installation is unbound, or bound to an org that has
 *                    no Slack app of its own.
 */
export async function installationServesRoute({
  db,
  installation,
  route,
}: {
  db: DB;
  installation: Pick<SlackInstallation, "organizationId">;
  route: SlackRequestRoute;
}): Promise<boolean> {
  if (route.kind === "organization") {
    return installation.organizationId === route.organizationId;
  }
  if (!installation.organizationId) {
    return true;
  }
  const config = await resolveSlackAppConfig({
    db,
    organizationId: installation.organizationId,
  });
  return config.source === "platform";
}
