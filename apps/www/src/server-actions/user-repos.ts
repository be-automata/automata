"use server";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import {
  GithubListingUnavailableError,
  listUserRepos,
  type UserReposResult,
} from "@/server-lib/user-repos";

export type {
  UserRepo,
  UserReposResult,
  UserReposScope,
} from "@/server-lib/user-repos";

/**
 * Server-action form of GET /api/github/repos, for server-side callers
 * (onboarding). The browser reads the route instead: server actions from one
 * client run one at a time, so a slow GitHub listing here would hold up every
 * other action on the page. A GitHub failure is reported as an empty list,
 * as it always was for these callers.
 */
export const getUserRepos = userOnlyAction(
  async function getUserRepos(userId: string): Promise<UserReposResult> {
    const tenant = await getTenantContextOrNull();
    try {
      const { result } = await listUserRepos({
        userId,
        organizationId: tenant?.organizationId ?? null,
      });
      return result;
    } catch (error) {
      if (error instanceof GithubListingUnavailableError) {
        console.warn("Failed to list the user's repos:", error.cause);
        return { repos: [] };
      }
      throw error;
    }
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
