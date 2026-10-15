import type { Octokit } from "octokit";

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
 * What the caller's GitHub account may do with an installation's account,
 * read LIVE from GitHub with the caller's own OAuth token:
 * - "authorized": an active admin of the organization, or the user account
 *   itself.
 * - "not-org-admin": not an active admin of the organization (a plain or
 *   pending member, an outside collaborator, or GitHub refused the lookup).
 * - "not-account-owner": a user account that is not the caller's.
 * - "enterprise-account": an enterprise installation, which has no single
 *   org or user to hold authority over.
 * - "unknown-account": GitHub described the account without a login or a
 *   known type.
 */
export type GithubAccountAuthority =
  | "authorized"
  | "not-org-admin"
  | "not-account-owner"
  | "enterprise-account"
  | "unknown-account";

function errorStatus(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { status?: unknown }).status
    : undefined;
}

/**
 * GitHub lists an installation for ANY user with read access to one of its
 * repos, so visibility is not authority over the account. This is the
 * authority check. Never answer it from the listing cache: a role change on
 * GitHub must take effect on the next attempt.
 *
 * A 403/404 on the membership lookup (not a member, SSO not authorized for
 * the token, the org hidden from the user) resolves to "not-org-admin", so
 * the check fails closed. Any other GitHub failure propagates.
 */
export async function getGithubAccountAuthority({
  octokit,
  accountLogin,
  accountType,
}: {
  octokit: Octokit;
  accountLogin: string | null;
  accountType: string | null;
}): Promise<GithubAccountAuthority> {
  if (accountType === "Enterprise") {
    return "enterprise-account";
  }
  if (!accountLogin) {
    return "unknown-account";
  }
  if (accountType === "Organization") {
    try {
      const { data } =
        await octokit.rest.orgs.getMembershipForAuthenticatedUser({
          org: accountLogin,
        });
      return data.state === "active" && data.role === "admin"
        ? "authorized"
        : "not-org-admin";
    } catch (error) {
      const status = errorStatus(error);
      if (status === 403 || status === 404) {
        return "not-org-admin";
      }
      throw error;
    }
  }
  if (accountType === "User") {
    const { data } = await octokit.rest.users.getAuthenticated();
    // GitHub logins are case-insensitive.
    return data.login.toLowerCase() === accountLogin.toLowerCase()
      ? "authorized"
      : "not-account-owner";
  }
  return "unknown-account";
}
