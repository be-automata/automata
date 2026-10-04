import { App } from "@octokit/app";

let appInstance: App | null = null;

// Export for testing purposes only
export function resetAppInstance() {
  appInstance = null;
}

/**
 * Get or create GitHub App instance
 */
export function getGitHubApp(): App {
  if (appInstance) {
    return appInstance;
  }

  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    throw new Error(
      "GitHub App configuration missing: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required",
    );
  }

  appInstance = new App({
    appId,
    privateKey: privateKey.replace(/\\n/g, "\n"), // Handle escaped newlines
  });

  return appInstance;
}

/** Optional per-call abort signal (self-heal passes a bounded one). */
export interface GitHubCallOptions {
  signal?: AbortSignal;
}

/** `{ request: { signal } }` only when a signal was given: callers without one are unchanged. */
function requestSignal(options?: GitHubCallOptions): {
  request?: { signal: AbortSignal };
} {
  return options?.signal ? { request: { signal: options.signal } } : {};
}

/** Rethrow a 404 from the installation lookup as the "not installed" error. */
function notInstalledOr(error: unknown, owner: string, repo: string): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 404
  ) {
    return new Error(
      `GitHub App is not installed on repository ${owner}/${repo}`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The App installation id covering owner/repo. A 404 throws the same "not
 * installed" error as the minters. Exported so a caller minting several
 * tokens for one repo looks the installation up once and passes the id in.
 */
export async function lookupInstallationId(
  owner: string,
  repo: string,
  options?: GitHubCallOptions,
): Promise<number> {
  try {
    const { data: installation } = await getGitHubApp().octokit.request(
      "GET /repos/{owner}/{repo}/installation",
      {
        owner,
        repo,
        ...requestSignal(options),
      },
    );
    return installation.id;
  } catch (error: unknown) {
    throw notInstalledOr(error, owner, repo);
  }
}

/**
 * Get installation access token for a repository
 * @param owner Repository owner
 * @param repo Repository name
 * @param knownInstallationId The repo's installation id when the caller
 *   already looked it up (lookupInstallationId); otherwise looked up here
 * @returns Installation access token
 */
export async function getInstallationToken(
  owner: string,
  repo: string,
  knownInstallationId?: number,
  options?: GitHubCallOptions,
): Promise<string> {
  const app = getGitHubApp();

  try {
    // Get the installation for this repository
    const installationId =
      knownInstallationId ?? (await lookupInstallationId(owner, repo, options));

    // Create an installation access token with 30-day expiry
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + 30);

    const { data: tokenData } = await app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: installationId,
        repositories: [repo],
        expires_at: expirationDate.toISOString(),
        ...requestSignal(options),
      },
    );

    return tokenData.token;
  } catch (error: unknown) {
    throw notInstalledOr(error, owner, repo);
  }
}

/**
 * The ONLY permissions a read-only task token is ever minted with (phase 7).
 * No write and no admin key, by construction: the request body below spreads
 * nothing else in.
 */
export const READ_ONLY_TOKEN_PERMISSIONS = {
  contents: "read",
  metadata: "read",
  pull_requests: "read",
  issues: "read",
} as const;

/**
 * A READ-ONLY installation token for exactly one repository (phase 7).
 *
 * Scope: READ_ONLY_TOKEN_PERMISSIONS on `[repo]` only. Lifetime: GitHub caps
 * installation tokens at one hour, so no `expires_at` is requested; the
 * response's own expiry is returned so the worker can refuse an expired
 * token. Used ONLY for task runs whose admin-selected packs require
 * `github-read-token` (BATTERY_PACK_REQUIRES) — never for review runs, which
 * keep the #81/ADR-004 fence (no GitHub credential in the agent at all).
 * `knownInstallationId` skips the lookup, exactly as for getInstallationToken.
 */
export async function getReadOnlyInstallationToken(
  owner: string,
  repo: string,
  knownInstallationId?: number,
): Promise<{ token: string; expiresAt: string }> {
  const app = getGitHubApp();
  let data: { token?: unknown; expires_at?: unknown };
  try {
    const installationId =
      knownInstallationId ?? (await lookupInstallationId(owner, repo));
    ({ data } = await app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: installationId,
        repositories: [repo],
        permissions: READ_ONLY_TOKEN_PERMISSIONS,
      },
    ));
  } catch (error: unknown) {
    throw notInstalledOr(error, owner, repo);
  }
  if (typeof data.token !== "string" || typeof data.expires_at !== "string") {
    throw new Error(
      "GitHub App token response has no token or no expires_at (read-only token)",
    );
  }
  return { token: data.token, expiresAt: data.expires_at };
}

/**
 * The id of the App installation that covers a repository, or null when the
 * App is not installed on it.
 */
export async function getRepoInstallationId(
  owner: string,
  repo: string,
): Promise<number | null> {
  try {
    const { data } = await getGitHubApp().octokit.request(
      "GET /repos/{owner}/{repo}/installation",
      { owner, repo },
    );
    return data.id;
  } catch (error) {
    if ((error as { status?: number } | null)?.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * The installation covering a repository and the permissions it was granted
 * (`GET /repos/{owner}/{repo}/installation`). Feeds the self-heal permission
 * preflight and latch. A 404 throws the "not installed" error.
 */
export async function getRepoInstallationPermissions(
  owner: string,
  repo: string,
  options?: GitHubCallOptions,
): Promise<{
  installationId: number;
  permissions: Record<string, string | undefined>;
}> {
  try {
    const { data } = await getGitHubApp().octokit.request(
      "GET /repos/{owner}/{repo}/installation",
      { owner, repo, ...requestSignal(options) },
    );
    return {
      installationId: data.id,
      permissions: { ...(data.permissions as Record<string, string>) },
    };
  } catch (error: unknown) {
    throw notInstalledOr(error, owner, repo);
  }
}

/**
 * Check if the GitHub App is installed on a repository
 * @param owner Repository owner
 * @param repo Repository name
 * @returns Boolean indicating if app is installed
 */
export async function isAppInstalledOnRepo(
  owner: string,
  repo: string,
): Promise<boolean> {
  const app = getGitHubApp();

  try {
    await app.octokit.request("GET /repos/{owner}/{repo}/installation", {
      owner,
      repo,
    });
    return true;
  } catch (error: any) {
    if (error.status === 404) {
      return false;
    }
    throw error;
  }
}
