import { db } from "@/lib/db";
import { getOctokitForUser } from "@/lib/github";
import {
  getCachedInstallations,
  GithubListingTimer,
  type GithubListingTiming,
} from "@/server-lib/github-listing-cache";
import { getGithubInstallationsByInstallationIds } from "@terragon/shared/model/github-installation";
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
 * The GitHub App installations the user's GitHub token can see, each with
 * the org it is bound to. Feeds the GitHub installations card on Settings →
 * Integrations. The visible-installation listing comes from the per-user
 * cache unless `refresh`; the bindings are read fresh every call. Throws
 * GithubListingUnavailableError when GitHub fails.
 */
export async function listGithubInstallationRows({
  userId,
  refresh = false,
}: {
  userId: string;
  refresh?: boolean;
}): Promise<{
  result: GithubInstallationsResult;
  timing: GithubListingTiming;
}> {
  const timer = new GithubListingTimer(refresh);
  const [octokit, organizations] = await Promise.all([
    getOctokitForUser({ userId }),
    getOrganizationsForUser({ db, userId }),
  ]);
  if (!octokit) {
    return {
      result: { installations: [], githubTokenMissing: true },
      timing: timer.snapshot(),
    };
  }
  const visible = await getCachedInstallations({
    userId,
    octokit,
    bypass: refresh,
    timer,
  });
  const rows = await getGithubInstallationsByInstallationIds({
    db,
    installationIds: visible.map((i) => i.installationId),
  });
  const rowByInstallationId = new Map(
    rows.map((row) => [row.installationId, row]),
  );
  const organizationById = new Map(organizations.map((org) => [org.id, org]));
  const installations = visible.map((installation): GithubInstallationRow => {
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
  });
  return { result: { installations }, timing: timer.snapshot() };
}
