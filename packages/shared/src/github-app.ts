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
): Promise<number> {
  try {
    const { data: installation } = await getGitHubApp().octokit.request(
      "GET /repos/{owner}/{repo}/installation",
      {
        owner,
        repo,
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
): Promise<string> {
  const app = getGitHubApp();

  try {
    // Get the installation for this repository
    const installationId =
      knownInstallationId ?? (await lookupInstallationId(owner, repo));

    // Create an installation access token with 30-day expiry
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + 30);

    const { data: tokenData } = await app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: installationId,
        repositories: [repo],
        expires_at: expirationDate.toISOString(),
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
