import { env } from "@terragon/env/apps-www";

/** The App bot's author login (GITHUB_BOT_LOGIN, else `<app name>[bot]`). */
export function resolveBotLogin(): string {
  const explicit = env.GITHUB_BOT_LOGIN.trim();
  return explicit || `${env.NEXT_PUBLIC_GITHUB_APP_NAME}[bot]`;
}
