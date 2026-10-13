import type { WebClient } from "@slack/web-api";
import type { DB } from "@terragon/shared/db";
import type { SlackInstallation } from "@terragon/shared/db/types";
import { getMembership } from "@terragon/shared/model/organizations";
import { getSlackInstallationForTeam } from "@terragon/shared/model/slack";

import { resolveSlackAppConfig } from "@/server-lib/slack-config";

/**
 * Which Slack app signed the request being handled. The platform app posts to
 * /api/webhooks/slack; an org's own app posts to /api/webhooks/slack/<orgId>.
 *
 * A verified signature proves which Slack APP sent the request — nothing
 * else. The platform holds the platform app's secret, but an org's admins
 * hold their own app's, so on the org route every claim in the payload (team,
 * user, text) is the admin's to forge. This module is where those claims are
 * checked against something the signer does not control.
 */
export type SlackRequestRoute =
  | { kind: "platform" }
  | { kind: "organization"; organizationId: string };

export const PLATFORM_SLACK_ROUTE: SlackRequestRoute = { kind: "platform" };

/**
 * The installation for `teamId`, only if it was made through the app that
 * sent this request — the one way the webhook looks an installation up:
 *
 *   org route      → the installation is bound to that org.
 *   platform route → the installation is unbound, or bound to an org that has
 *                    no Slack app of its own.
 */
export async function getSlackInstallationForRoute({
  db,
  teamId,
  route,
}: {
  db: DB;
  teamId: string;
  route: SlackRequestRoute;
}): Promise<SlackInstallation | null> {
  const installation = await getSlackInstallationForTeam({ db, teamId });
  if (!installation) {
    return null;
  }
  if (route.kind === "organization") {
    return installation.organizationId === route.organizationId
      ? installation
      : null;
  }
  if (!installation.organizationId) {
    return installation;
  }
  const config = await resolveSlackAppConfig({
    db,
    organizationId: installation.organizationId,
  });
  return config.source === "platform" ? installation : null;
}

/**
 * On the org route, the mention must be one Slack itself holds, posted by the
 * user the payload names, and that user's linked account must belong to the
 * org. Returns the message text as Slack stores it — never the payload's — or
 * null to drop the request. The platform route returns the payload as is.
 */
export async function confirmMentionForRoute({
  db,
  slack,
  route,
  mention,
  userId,
}: {
  db: DB;
  slack: WebClient;
  route: SlackRequestRoute;
  mention: {
    channel: string;
    ts?: string;
    threadTs?: string;
    user: string;
    text: string;
  };
  /** The app user the mention's Slack user is linked to. */
  userId: string;
}): Promise<{ text: string } | null> {
  if (route.kind === "platform") {
    return { text: mention.text };
  }
  if (!mention.ts) {
    return null;
  }
  const [stored, membership] = await Promise.all([
    fetchSlackMessage({
      slack,
      channel: mention.channel,
      ts: mention.ts,
      threadTs: mention.threadTs,
    }),
    getMembership({ db, organizationId: route.organizationId, userId }),
  ]);
  if (!stored || stored.user !== mention.user || !membership) {
    return null;
  }
  return { text: stored.text };
}

async function fetchSlackMessage({
  slack,
  channel,
  ts,
  threadTs,
}: {
  slack: WebClient;
  channel: string;
  ts: string;
  threadTs?: string;
}): Promise<{ user: string; text: string } | null> {
  try {
    const response =
      threadTs && threadTs !== ts
        ? await slack.conversations.replies({
            channel,
            ts: threadTs,
            oldest: ts,
            latest: ts,
            inclusive: true,
          })
        : await slack.conversations.history({
            channel,
            oldest: ts,
            latest: ts,
            inclusive: true,
            limit: 1,
          });
    const message = response.messages?.find((candidate) => candidate.ts === ts);
    return message?.user && message.text
      ? { user: message.user, text: message.text }
      : null;
  } catch (error) {
    console.error("[slack webhook] Could not read the mention from Slack", {
      channel,
      ts,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
