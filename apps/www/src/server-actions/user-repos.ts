"use server";

import {
  getActiveOrganizationMembershipOrNull,
  userOnlyAction,
} from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  getOctokitForApp,
  getOctokitForUser,
  parseRepoFullName,
} from "@/lib/github";
import { listInstallationsForOctokit } from "@/server-lib/github-installations";
import { getGithubInstallationsForOrganization } from "@terragon/shared/model/github-installation";
import { Endpoints } from "@octokit/types";

export type UserRepo =
  Endpoints["GET /installation/repositories"]["response"]["data"]["repositories"][number];

/**
 * Which repos the list holds for the active org:
 * - "organization": only repos of GitHub installations bound to that org.
 * - "unassigned": the org has no bound installation yet, so the list falls
 *   back to every installation the user's token can see (the picker says so
 *   and points at Settings → Integrations).
 * Absent when there is no active org.
 */
export type UserReposScope = "organization" | "unassigned";

export type UserReposResult = {
  repos: UserRepo[];
  // The signed-in user has no usable GitHub OAuth token — e.g. an
  // email/password account, or a github account row created without ever
  // completing the OAuth flow. Distinct from "token is fine but the GitHub
  // App has no repositories": the first is fixed by signing in with GitHub,
  // the second by installing the App.
  githubTokenMissing?: boolean;
  scope?: UserReposScope;
};

/**
 * The installation ids the active org may list repos from, or null for "no
 * restriction" (no active org, or an org with nothing bound yet).
 */
async function resolveRepoScope(userId: string): Promise<{
  scope: UserReposScope | undefined;
  allowedInstallationIds: Set<string> | null;
}> {
  const membership = await getActiveOrganizationMembershipOrNull(userId);
  if (!membership) {
    return { scope: undefined, allowedInstallationIds: null };
  }
  const bound = await getGithubInstallationsForOrganization({
    db,
    organizationId: membership.organizationId,
  });
  if (bound.length === 0) {
    return { scope: "unassigned", allowedInstallationIds: null };
  }
  return {
    scope: "organization",
    allowedInstallationIds: new Set(bound.map((row) => row.installationId)),
  };
}

export const getUserRepos = userOnlyAction(
  async function getUserRepos(userId: string): Promise<UserReposResult> {
    const octokit = await getOctokitForUser({ userId });
    if (!octokit) {
      return { repos: [], githubTokenMissing: true };
    }
    const { scope, allowedInstallationIds } = await resolveRepoScope(userId);
    try {
      const installations = (await listInstallationsForOctokit(octokit)).filter(
        (installation) =>
          !allowedInstallationIds ||
          allowedInstallationIds.has(installation.installationId),
      );

      if (installations.length > 0) {
        // Get repositories from those installations in parallel
        const repoPromises = installations.map(async (installation) => {
          try {
            // Get all repositories accessible to the user in this installation using pagination
            const repositories = await octokit.paginate(
              octokit.rest.apps.listInstallationReposForAuthenticatedUser,
              {
                installation_id: Number(installation.installationId),
                per_page: 100,
              },
            );

            return repositories;
          } catch (installationError) {
            console.warn(
              `Failed to get repos for installation ${installation.installationId}:`,
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

          return { repos: filteredRepos, scope };
        }
      }
    } catch (appError) {
      console.warn("Failed to get app installations or user info:", appError);
    }
    return { repos: [], scope };
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
