"use server";

import {
  getActiveOrganizationMembershipOrNull,
  userOnlyAction,
} from "@/lib/auth-server";
import { db } from "@/lib/db";
import { isOrgAdmin, ORG_ADMIN_ROLES } from "@/lib/org-role";
import { UserFacingError } from "@/lib/server-actions";
import { listVisibleGithubInstallations } from "@/server-lib/github-installations";
import {
  bindGithubInstallationToOrg,
  getGithubInstallation,
  getGithubInstallationsByInstallationIds,
} from "@terragon/shared/model/github-installation";
import { getOrganizationsForUser } from "@terragon/shared/model/organizations";

export type GithubInstallationBinding =
  | { kind: "unbound" }
  | {
      kind: "organization";
      organization: { id: string; name: string; logo: string | null };
    }
  // Bound to an org the caller is not a member of: its name is not theirs to
  // see, only the fact that the account's work runs somewhere else.
  | { kind: "other-organization" };

export interface GithubInstallationRow {
  installationId: string;
  accountLogin: string | null;
  accountType: string | null;
  binding: GithubInstallationBinding;
  /** Null when the installation has never been bound (no row yet). */
  mode: "shadow" | "active" | null;
}

export interface GithubInstallationsResult {
  installations: GithubInstallationRow[];
  githubTokenMissing?: boolean;
}

/**
 * The GitHub App installations the caller's GitHub token can see, each with
 * the org it is bound to. Feeds the GitHub installations card on Settings →
 * Integrations.
 */
export const getGithubInstallations = userOnlyAction(
  async function getGithubInstallations(
    userId: string,
  ): Promise<GithubInstallationsResult> {
    const visible = await listVisibleGithubInstallations(userId);
    if (!visible) {
      return { installations: [], githubTokenMissing: true };
    }
    const [rows, organizations] = await Promise.all([
      getGithubInstallationsByInstallationIds({
        db,
        installationIds: visible.map((i) => i.installationId),
      }),
      getOrganizationsForUser({ db, userId }),
    ]);
    const rowByInstallationId = new Map(
      rows.map((row) => [row.installationId, row]),
    );
    const organizationById = new Map(organizations.map((org) => [org.id, org]));
    return {
      installations: visible.map((installation) => {
        const row = rowByInstallationId.get(installation.installationId);
        const organization = row?.organizationId
          ? organizationById.get(row.organizationId)
          : undefined;
        const binding: GithubInstallationBinding = !row?.organizationId
          ? { kind: "unbound" }
          : organization
            ? {
                kind: "organization",
                organization: {
                  id: organization.id,
                  name: organization.name,
                  logo: organization.logo ?? null,
                },
              }
            : { kind: "other-organization" };
        return {
          installationId: installation.installationId,
          accountLogin: installation.accountLogin ?? row?.accountLogin ?? null,
          accountType: installation.accountType ?? row?.accountType ?? null,
          binding,
          mode: row?.mode ?? null,
        };
      }),
    };
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
    const membership = await getActiveOrganizationMembershipOrNull(userId);
    if ((membership?.organizationId ?? null) !== expectedOrganizationId) {
      throw new UserFacingError(
        "Your active organization changed in another tab. Reload the page and try again.",
      );
    }
    if (!membership) {
      throw new UserFacingError(
        "Select an organization before binding a GitHub installation",
      );
    }
    if (!ORG_ADMIN_ROLES.has(membership.role)) {
      throw new UserFacingError(
        "Only organization owners and admins can bind a GitHub installation",
      );
    }
    const visible = await listVisibleGithubInstallations(userId);
    if (!visible) {
      throw new UserFacingError(
        "Your GitHub connection expired. Reconnect GitHub and try again.",
      );
    }
    const installation = visible.find(
      (i) => i.installationId === String(installationId),
    );
    if (!installation) {
      throw new UserFacingError(
        "This GitHub installation is not visible to your GitHub account",
      );
    }
    const existing = await getGithubInstallation({ db, installationId });
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
