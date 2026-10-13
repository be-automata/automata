/**
 * The Slack app's permissions and its manifest — one definition for the OAuth
 * install URL (server-actions/slack.ts) and the manifest checked into
 * deploy/slack-app-manifest.json (a test keeps the two equal).
 *
 * Scopes are the minimum the code calls. Every scope change makes each
 * installed workspace re-approve the app (and an Enterprise Grid org
 * re-approve it org-wide), so add one only with the call that needs it.
 */
export const SLACK_BOT_SCOPES = [
  // app_mention events.
  "app_mentions:read",
  // chat.postMessage: replies and setup prompts.
  "chat:write",
  // users.info, bots.info: readable names in the task prompt.
  "users:read",
  // conversations.history / .replies: confirm a mention and read its thread.
  "channels:history",
  "groups:history",
  "mpim:history",
  // conversations.info: the channel name in the task prompt.
  "channels:read",
  "groups:read",
  "mpim:read",
  // Direct messages to a user (task alerts); requested now so adding them
  // later does not force every workspace to re-approve.
  "im:write",
] as const;

/** Events the app subscribes to. */
export const SLACK_BOT_EVENTS = [
  "app_mention",
  "app_uninstalled",
  "tokens_revoked",
] as const;

/** "Sign in with Slack" scopes for linking a member's Slack account. */
export const SLACK_OPENID_SCOPES = ["openid", "profile", "email"] as const;

/**
 * The manifest for an app served at `appUrl`. `requestPath` is
 * /api/webhooks/slack for the platform app, /api/webhooks/slack/<orgId> for
 * an organization's own app.
 */
export function buildSlackAppManifest({
  appUrl,
  requestPath,
  name = "Automata",
}: {
  appUrl: string;
  requestPath: string;
  name?: string;
}) {
  const requestUrl = `${appUrl}${requestPath}`;
  return {
    display_information: {
      name,
      description: "Start coding agent tasks from Slack and get their results.",
      background_color: "#1a1a1a",
    },
    features: {
      bot_user: { display_name: name, always_online: true },
    },
    oauth_config: {
      redirect_urls: [`${appUrl}/api/auth/slack/callback`],
      scopes: {
        bot: [...SLACK_BOT_SCOPES],
        user: [...SLACK_OPENID_SCOPES],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: requestUrl,
        bot_events: [...SLACK_BOT_EVENTS],
      },
      interactivity: { is_enabled: true, request_url: requestUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
