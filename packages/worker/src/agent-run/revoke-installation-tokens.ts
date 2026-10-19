import type { RunSecrets } from "@terragon/utils/payload-seal";

/**
 * End-of-run revocation of the GitHub App installation tokens (#380).
 *
 * Each run's `ghs_` tokens are minted for that run alone (www mints a fresh
 * single-repo token per dispatch, never cached), so revoking them at the end
 * of the run cannot break www or a sibling run. Until now nothing revoked
 * them: a token outlived its run by up to an hour, live in the engine's
 * payload rows. `DELETE /installation/token` (204) ends that.
 *
 * Best effort by contract: a 5 s budget per token, every outcome logged as
 * ONE `token.revoke` line (kind + status, or kind + error class — never the
 * token), and NEVER a throw or a changed run outcome. A revoke that fails
 * only leaves the token to its own ≤1h expiry; it can never extend it.
 */

export const GITHUB_INSTALLATION_TOKEN_URL =
  "https://api.github.com/installation/token";
export const REVOKE_TIMEOUT_MS = 5_000;

export type RevokeTokens = Pick<
  RunSecrets,
  "installationToken" | "githubReadToken"
>;

export async function revokeInstallationTokens({
  tokens,
  log,
  fetchFn = fetch,
  timeoutMs = REVOKE_TIMEOUT_MS,
}: {
  tokens: RevokeTokens;
  /** One line per token: `token.revoke {"kind":…,"status":…}`. */
  log: (line: string) => void;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<void> {
  const entries: Array<{ kind: "installation" | "read"; token: string }> = [
    { kind: "installation" as const, token: tokens.installationToken },
    ...(tokens.githubReadToken !== undefined && tokens.githubReadToken !== ""
      ? [{ kind: "read" as const, token: tokens.githubReadToken }]
      : []),
  ];
  // Both DELETEs in parallel: the box slot is still held, so a GitHub stall
  // costs one timeout budget, not one per token.
  await Promise.all(
    entries.map(async ({ kind, token }) => {
      try {
        const res = await fetchFn(GITHUB_INSTALLATION_TOKEN_URL, {
          method: "DELETE",
          headers: {
            Authorization: `token ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        log(`token.revoke ${JSON.stringify({ kind, status: res.status })}`);
      } catch (err) {
        const error =
          err instanceof Error
            ? err.name === "TimeoutError" || err.name === "AbortError"
              ? "timeout"
              : err.name
            : "unknown";
        log(`token.revoke ${JSON.stringify({ kind, error })}`);
      }
    }),
  );
}

/**
 * A once-only revoker for one run: `runAgent` creates it right after the
 * secrets are resolved, `runAgentInner`'s finally calls it after the
 * self-heal fix check (which still needs the token) and before the box lock
 * release, and `runAgent`'s own finally calls it again as the safety net for
 * every exit that never reached that point (stale-skip, a clone failure, an
 * admission throw). The second call is a no-op.
 */
export interface TokenRevoker {
  revokeOnce: () => Promise<void>;
}

export function createTokenRevoker(
  tokens: RevokeTokens,
  log: (line: string) => void,
  deps: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): TokenRevoker {
  let started: Promise<void> | null = null;
  return {
    revokeOnce: () => {
      if (started === null) {
        started = revokeInstallationTokens({ tokens, log, ...deps });
      }
      return started;
    },
  };
}
