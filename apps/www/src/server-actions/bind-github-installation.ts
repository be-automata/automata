"use server";

import {
  requireExpectedActiveMembership,
  userOnlyAction,
} from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getOctokitForUser } from "@/lib/github";
import { isOrgAdmin } from "@/lib/org-role";
import { UserFacingError } from "@/lib/server-actions";
import {
  getGithubAccountAuthority,
  listInstallationsForOctokit,
  type GithubAccountAuthority,
} from "@/server-lib/github-installations";
import {
  listGithubInstallationRows,
  type GithubInstallationsResult,
} from "@/server-lib/github-installation-rows";
import {
  bindGithubInstallationToOrg,
  getGithubInstallation,
} from "@terragon/shared/model/github-installation";

export type {
  GithubInstallationBinding,
  GithubInstallationRow,
  GithubInstallationsResult,
} from "@/server-lib/github-installation-rows";

function describeMissingAuthority(
  authority: Exclude<GithubAccountAuthority, "authorized">,
  accountLogin: string | null,
): string {
  const account = accountLogin ?? "this account";
  switch (authority) {
    case "not-org-admin":
      return `Only an admin of the ${account} GitHub organization can bind its installation. Ask an organization admin to bind it.`;
    case "not-account-owner":
      return `This installation belongs to the GitHub user ${account}. Only that user can bind it.`;
    case "enterprise-account":
      return "An enterprise-level GitHub installation cannot be bound to an organization. Install the GitHub App on each GitHub organization and bind those instead.";
    case "unknown-account":
      return "GitHub did not say which account owns this installation, so it cannot be bound. Try again later.";
  }
}

/**
 * Server-action form of GET /api/github/installations. The Settings →
 * Integrations card reads the route instead, so this slow GitHub listing is
 * not queued behind (or ahead of) the page's other server actions.
 */
export const getGithubInstallations = userOnlyAction(
  async function getGithubInstallations(
    userId: string,
  ): Promise<GithubInstallationsResult> {
    const { result } = await listGithubInstallationRows({ userId });
    return result;
  },
  { defaultErrorMessage: "Failed to load GitHub installations" },
);

/**
 * Bind a GitHub App installation to the caller's active organization, so PR
 * reviews, mentions, audits and automations for the account's repos run in
 * that org (see handle-app-mention.ts and getUserRepos).
 *
 * Refuses unless:
 * - the session org is still the one the page showed (`expectedOrganizationId`;
 *   another tab may have switched org since);
 * - the caller is an owner/admin of the active org;
 * - the installation is visible to the caller's own GitHub token (an id typed
 *   by hand cannot claim someone else's account);
 * - the caller has authority over the installation's GitHub account, checked
 *   live: an active admin of the GitHub organization, or the user account
 *   itself. Visibility alone is not enough — GitHub lists an installation for
 *   anyone with read access to one of its repos, so a read-only collaborator
 *   could otherwise route that account's reviews and mentions into their own
 *   org;
 * - when the installation is already bound to a DIFFERENT org, the caller is
 *   also an owner/admin of that org (a binding is not taken from an org
 *   without its admin).
 *
 * A rebind keeps the existing mode (an 'active' binding never silently drops
 * back to 'shadow'); a new binding takes the schema default.
 */
export const bindGithubInstallation = userOnlyAction(
  async function bindGithubInstallation(
    userId: string,
    {
      installationId,
      expectedOrganizationId,
    }: {
      installationId: string;
      expectedOrganizationId: string | null;
    },
  ) {
    const [membership, octokit, existing] = await Promise.all([
      requireExpectedActiveMembership(userId, {
        expectedOrganizationId,
        requireOrganization: { action: "binding a GitHub installation" },
        requireAdmin: { action: "bind a GitHub installation" },
      }),
      getOctokitForUser({ userId }),
      getGithubInstallation({ db, installationId }),
    ]);
    if (!octokit) {
      throw new UserFacingError(
        "Your GitHub connection expired. Reconnect GitHub and try again.",
      );
    }
    // Live, never the listing cache: an installation dropped from the
    // caller's GitHub account must stop being bindable at once.
    const visible = await listInstallationsForOctokit(octokit);
    const installation = visible.find(
      (i) => i.installationId === installationId,
    );
    if (!installation) {
      throw new UserFacingError(
        "This GitHub installation is not visible to your GitHub account",
      );
    }
    const authority = await getGithubAccountAuthority({
      octokit,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
    });
    if (authority !== "authorized") {
      throw new UserFacingError(
        describeMissingAuthority(authority, installation.accountLogin),
      );
    }
    if (
      existing?.organizationId &&
      existing.organizationId !== membership.organizationId &&
      !(await isOrgAdmin({
        db,
        organizationId: existing.organizationId,
        userId,
      }))
    ) {
      throw new UserFacingError(
        "This GitHub installation is bound to another organization. Only an owner or admin of that organization can move it.",
      );
    }
    const row = await bindGithubInstallationToOrg({
      db,
      installationId: installation.installationId,
      organizationId: membership.organizationId,
      // undefined (not null) keeps a stored value GitHub did not return.
      accountLogin: installation.accountLogin ?? undefined,
      accountType: installation.accountType ?? undefined,
      // mode omitted on purpose: keeps the current mode on a rebind.
    });
    return {
      installationId: row.installationId,
      organizationId: row.organizationId,
      mode: row.mode,
    };
  },
  { defaultErrorMessage: "Failed to bind GitHub installation" },
);
