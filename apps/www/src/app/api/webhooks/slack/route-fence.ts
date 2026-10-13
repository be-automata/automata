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
 * Whether a mention may start a task, and with which text. Returns null to
 * drop the request.
 *
 * Both routes: a workspace bound to an org starts tasks tagged with that org
 * (and carrying its environment), so the mention's linked user must be a
 * member of it — linking a Slack account says nothing about org membership.
 *
 * Org route only: the payload itself is the org admins' to forge, so the
 * mention must be one Slack holds, posted by the user the payload names, and
 * its text is Slack's copy. The platform route trusts its own signature and
 * returns the payload's text.
 */
export async function confirmMentionForRoute({
  db,
  slack,
  route,
  installationOrganizationId,
  mention,
  userId,
}: {
  db: DB;
  slack: WebClient;
  route: SlackRequestRoute;
  /** The org the workspace's installation is bound to, if any. */
  installationOrganizationId: string | null;
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
    if (
      installationOrganizationId &&
      !(await getMembership({
        db,
        organizationId: installationOrganizationId,
        userId,
      }))
    ) {
      return null;
    }
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
