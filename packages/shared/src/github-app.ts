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

/**
 * Get installation access token for a repository
 * @param owner Repository owner
 * @param repo Repository name
 * @returns Installation access token
 */
export async function getInstallationToken(
  owner: string,
  repo: string,
): Promise<string> {
  const app = getGitHubApp();

  try {
    // Get the installation for this repository
    const { data: installation } = await app.octokit.request(
      "GET /repos/{owner}/{repo}/installation",
      {
        owner,
        repo,
      },
    );

    // Get an authenticated Octokit instance for this installation
    // Note: We don't need to use this octokit instance here, we're just getting the token

    // Create an installation access token with 30-day expiry
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + 30);

    const { data: tokenData } = await app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: installation.id,
        repositories: [repo],
        expires_at: expirationDate.toISOString(),
      },
    );

    return tokenData.token;
  } catch (error: any) {
    if (error.status === 404) {
      throw new Error(
        `GitHub App is not installed on repository ${owner}/${repo}`,
      );
    }
    throw error;
  }
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
