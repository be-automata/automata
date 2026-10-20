import { env } from "@terragon/env/apps-www";

/** The App bot's author login (GITHUB_BOT_LOGIN, else `<app name>[bot]`). */
export function resolveBotLogin(): string {
  const explicit = env.GITHUB_BOT_LOGIN.trim();
  return explicit || `${env.NEXT_PUBLIC_GITHUB_APP_NAME}[bot]`;
}

/**
 * Whether the review bot itself opened the PR (a self-heal fix PR). GitHub
 * logins are case-insensitive, so the comparison is too: a false "not ours"
 * here re-opens the 422 this check exists to avoid.
 */
export function isPrAuthoredByBot(
  authorLogin: string | null | undefined,
  botLogin: string,
): boolean {
  if (!authorLogin || !botLogin) return false;
  return authorLogin.toLowerCase() === botLogin.toLowerCase();
}

/**
 * Whether `login` is the App bot. REST reports App logins as `<name>[bot]`
 * while GraphQL drops the suffix, so both sides compare without it,
 * case-insensitively.
 */
export function isBotAuthor(
  login: string | null | undefined,
  botLogin: string = resolveBotLogin(),
): boolean {
  const bare = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/\[bot\]$/, "");
  if (!login || !botLogin) return false;
  return bare(login) === bare(botLogin);
}
