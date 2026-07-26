"use server";

import { userOnlyAction } from "@/lib/auth-server";
import {
  getOctokitForApp,
  getOctokitForUser,
  parseRepoFullName,
} from "@/lib/github";
import { Endpoints } from "@octokit/types";

export type UserRepo =
  Endpoints["GET /installation/repositories"]["response"]["data"]["repositories"][number];

export type UserReposResult = {
  repos: UserRepo[];
  // The signed-in user has no usable GitHub OAuth token — e.g. an
  // email/password account, or a github account row created without ever
  // completing the OAuth flow. Distinct from "token is fine but the GitHub
  // App has no repositories": the first is fixed by signing in with GitHub,
  // the second by installing the App.
  githubTokenMissing?: boolean;
};

export const getUserRepos = userOnlyAction(
  async function getUserRepos(userId: string): Promise<UserReposResult> {
    const octokit = await getOctokitForUser({ userId });
    if (!octokit) {
      return { repos: [], githubTokenMissing: true };
    }
    try {
      // Try to get installations if GitHub App is configured
      const { data } =
        await octokit.rest.apps.listInstallationsForAuthenticatedUser();

      if (data.installations.length > 0) {
        // If user has app installations, get repositories from those installations in parallel
        const repoPromises = data.installations.map(async (installation) => {
          try {
            // Get all repositories accessible to the user in this installation using pagination
            const repositories = await octokit.paginate(
              octokit.rest.apps.listInstallationReposForAuthenticatedUser,
              {
                installation_id: installation.id,
                per_page: 100,
              },
            );

            return repositories;
          } catch (installationError) {
            console.warn(
              `Failed to get repos for installation ${installation.id}:`,
              installationError,
            );
            return [];
          }
        });

        const repoArrays = await Promise.all(repoPromises);
        const allRepos = repoArrays.flat();

        if (allRepos.length > 0) {
          const filteredRepos = allRepos
            .filter((repo) => repo && repo.permissions?.push === true)
            .sort((a, b) => {
              // Sort by most recently pushed (descending order)
              const aPushedAt = a.pushed_at
                ? new Date(a.pushed_at).getTime()
                : 0;
              const bPushedAt = b.pushed_at
                ? new Date(b.pushed_at).getTime()
                : 0;
              return bPushedAt - aPushedAt;
            });

          return { repos: filteredRepos };
        }
      }
    } catch (appError) {
      console.warn("Failed to get app installations or user info:", appError);
    }
    return { repos: [] };
  },
  { defaultErrorMessage: "An unexpected error occurred" },
);

export const getUserRepoBranches = userOnlyAction(
  async function getUserRepoBranches(userId: string, repoFullName: string) {
    const [owner, repo] = parseRepoFullName(repoFullName);
    const octokit = await getOctokitForApp({ owner, repo });
    try {
      // Fetch repository details to get the default branch
      const [{ data: repoData }, branches] = await Promise.all([
        octokit.rest.repos.get({
          owner,
          repo,
        }),
        octokit.paginate(
          octokit.rest.repos.listBranches,
          {
            owner,
            repo,
            per_page: 100,
          },
          (response) => response.data,
        ),
      ]);
      const defaultBranch = repoData.default_branch;
      // Sort branches with default branch first, then alphabetically
      branches.sort((a, b) => {
        if (a.name === defaultBranch) return -1;
        if (b.name === defaultBranch) return 1;
        return a.name.localeCompare(b.name);
      });
      return branches;
    } catch (error) {
      console.warn(`Failed to get branches for ${repoFullName}:`, error);
      return [];
    }
  },
  { defaultErrorMessage: "An unexpected error occurred" },
);
