import type { Octokit } from "octokit";

import { getOctokitForUser } from "@/lib/github";

/**
 * A GitHub App installation as the signed-in user's OAuth token sees it. This
 * is the visibility check for every org-binding decision: a user can only
 * see, list repos from, or bind an installation their own GitHub account can
 * reach.
 */
export interface VisibleGithubInstallation {
  installationId: string;
  accountLogin: string | null;
  accountType: string | null;
}

type ListedInstallation = Awaited<
  ReturnType<Octokit["rest"]["apps"]["listInstallationsForAuthenticatedUser"]>
>["data"]["installations"][number];

function describeAccount(installation: ListedInstallation): {
  accountLogin: string | null;
  accountType: string | null;
} {
  const account = installation.account;
  if (!account) {
    return { accountLogin: null, accountType: null };
  }
  // A user/org account has a login and a type; an enterprise account has a
  // slug and a name instead.
  if ("login" in account) {
    return {
      accountLogin: account.login,
      accountType: "type" in account ? (account.type ?? null) : null,
    };
  }
  return {
    accountLogin: account.slug ?? account.name,
    accountType: "Enterprise",
  };
}

/** The installations the token behind `octokit` can see (all pages). */
export async function listInstallationsForOctokit(
  octokit: Octokit,
): Promise<VisibleGithubInstallation[]> {
  // Every page: a user in more than 100 installations must still see them all.
  const installations: ListedInstallation[] = await octokit.paginate(
    octokit.rest.apps.listInstallationsForAuthenticatedUser,
    { per_page: 100 },
  );
  return installations.map((installation) => ({
    installationId: String(installation.id),
    ...describeAccount(installation),
  }));
}

/**
 * The installations visible to `userId`'s GitHub token, or null when the user
 * has no usable token (never signed in with GitHub, or the token expired and
 * could not be renewed).
 */
export async function listVisibleGithubInstallations(
  userId: string,
): Promise<VisibleGithubInstallation[] | null> {
  const octokit = await getOctokitForUser({ userId });
  if (!octokit) {
    return null;
  }
  return await listInstallationsForOctokit(octokit);
}
