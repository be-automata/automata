/**
 * The organization environment keys of an org's own Slack app
 * (server-lib/slack-config.ts). Pure: shared by the server resolver, the
 * env-audience strip and the browser-side env editor hints.
 */
export const SLACK_APP_ENV_KEYS = [
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
] as const;

export type SlackAppEnvKey = (typeof SLACK_APP_ENV_KEYS)[number];

export function isSlackAppEnvKey(key: string): key is SlackAppEnvKey {
  return (SLACK_APP_ENV_KEYS as readonly string[]).includes(key);
}
