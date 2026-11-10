import { DB } from "../db";
import { githubInstallation, githubRepoOrgBinding } from "../db/schema";
import { GithubInstallation, GithubRepoOrgBinding } from "../db/types";
import { eq, inArray } from "drizzle-orm";

/**
 * GitHub App installation → org mapping (WI-5, ADR-001). This is the tenant seam
 * for GitHub mentions: the webhook's installation id resolves to an org, the way
 * a Slack workspace resolves via slackInstallation. One installation binds to at
 * most one org (installationId is unique), so the derivation is unambiguous.
 */

export async function getGithubInstallation({
  db,
  installationId,
}: {
  db: DB;
  installationId: string | number;
}): Promise<GithubInstallation | undefined> {
  const [row] = await db
    .select()
    .from(githubInstallation)
    .where(eq(githubInstallation.installationId, String(installationId)))
    .limit(1);
  return row;
}

/**
 * The binding rows for a set of installations (any org). Installations with no
 * row are simply absent from the result.
 */
export async function getGithubInstallationsByInstallationIds({
  db,
  installationIds,
}: {
  db: DB;
  installationIds: string[];
}): Promise<GithubInstallation[]> {
  if (installationIds.length === 0) {
    return [];
  }
  return await db
    .select()
    .from(githubInstallation)
    .where(inArray(githubInstallation.installationId, installationIds));
}

/** Every installation bound to an org. */
export async function getGithubInstallationsForOrganization({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<GithubInstallation[]> {
  return await db
    .select()
    .from(githubInstallation)
    .where(eq(githubInstallation.organizationId, organizationId));
}

/**
 * Resolve the org bound to a GitHub App installation, or null when the
 * installation is unmapped / unknown. Nullable-safe derivation used by the
 * GitHub app-mention webhook.
 */
export async function getOrganizationIdForInstallation({
  db,
  installationId,
}: {
  db: DB;
  installationId: string | number | null | undefined;
}): Promise<string | null> {
  if (installationId === null || installationId === undefined) {
    return null;
  }
  const row = await getGithubInstallation({ db, installationId });
  return row?.organizationId ?? null;
}

export type InstallationMode = "shadow" | "active";

/**
 * Resolve both the org AND the mode for an installation in one read — the shape
 * the GitHub webhook needs (pilot). Unmapped/unknown installation → org
 * null.
 *
 * Mode defaults to 'active' when there's NO row — this preserves today's
 * behavior for every installation that predates the binding table (migration
 * safety: an unbound installation must keep working, not silently stop). Shadow
 * is opt-in: a *new binding* starts in 'shadow' (see bindGithubInstallationToOrg
 * / the column default), so onboarding an org is safe-by-default, but the mere
 * absence of a binding never suppresses an existing installation.
 */
export async function getInstallationOrgAndMode({
  db,
  installationId,
}: {
  db: DB;
  installationId: string | number | null | undefined;
}): Promise<{ organizationId: string | null; mode: InstallationMode }> {
  if (installationId === null || installationId === undefined) {
    return { organizationId: null, mode: "active" };
  }
  const row = await getGithubInstallation({ db, installationId });
  return {
    organizationId: row?.organizationId ?? null,
    mode: row?.mode ?? "active",
  };
}

/**
 * Reverse lookup: the effective mode for an ORG (not an installation) — used by
 * the automation run path, which is keyed by org, not installation. An org is
 * treated as 'shadow' only when it has at least one bound installation and NONE
 * of them is active (i.e. every binding is shadow). Any active binding — or no
 * binding at all — resolves to 'active', so this never suppresses an org that
 * isn't deliberately in a shadow pilot (migration-safe, mirrors
 * getInstallationOrgAndMode's no-row default).
 */
export async function getOrganizationInstallationMode({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string | null | undefined;
}): Promise<InstallationMode> {
  if (!organizationId) {
    return "active";
  }
  const rows = await db
    .select({ mode: githubInstallation.mode })
    .from(githubInstallation)
    .where(eq(githubInstallation.organizationId, organizationId));
  if (rows.length === 0) {
    return "active";
  }
  return rows.every((r) => r.mode === "shadow") ? "shadow" : "active";
}

/**
 * Registration seam: bind (or rebind) a GitHub App installation to an org.
 * Minimal now — an org admin calls this to claim an installation; it grows a UI
 * in the GitHub-App phase. Upserts on the unique installationId.
 */
export async function bindGithubInstallationToOrg({
  db,
  installationId,
  organizationId,
  accountLogin,
  accountType,
  mode,
}: {
  db: DB;
  installationId: string | number;
  organizationId: string | null;
  accountLogin?: string | null;
  accountType?: string | null;
  // Omitted → 'shadow' for a new binding (safe pilot default); on rebind, an
  // omitted mode is left unchanged so a flip to 'active' isn't reverted.
  mode?: "shadow" | "active";
}): Promise<GithubInstallation> {
  const installationIdStr = String(installationId);
  const [row] = await db
    .insert(githubInstallation)
    .values({
      installationId: installationIdStr,
      organizationId,
      accountLogin,
      accountType,
      ...(mode !== undefined ? { mode } : {}),
    })
    .onConflictDoUpdate({
      target: githubInstallation.installationId,
      set: {
        organizationId,
        ...(accountLogin !== undefined ? { accountLogin } : {}),
        ...(accountType !== undefined ? { accountType } : {}),
        ...(mode !== undefined ? { mode } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) {
    throw new Error("Failed to bind GitHub installation");
  }
  return row;
}

/**
 * Per-repo org override for a shared installation (github_repo_org_binding).
 * One GitHub account can host repos that belong to different orgs; a binding
 * row routes one repo to its own org. Repo names compare case-insensitively
 * (GitHub treats `Owner/Repo` and `owner/repo` as the same repo), so they are
 * stored lower-cased.
 */
function normalizeRepoFullName(repoFullName: string): string {
  return repoFullName.trim().toLowerCase();
}

/** The org override for one repo, or undefined when it has none. */
export async function getRepoOrgBinding({
  db,
  repoFullName,
}: {
  db: DB;
  repoFullName: string;
}): Promise<GithubRepoOrgBinding | undefined> {
  const [row] = await db
    .select()
    .from(githubRepoOrgBinding)
    .where(
      eq(
        githubRepoOrgBinding.repoFullName,
        normalizeRepoFullName(repoFullName),
      ),
    )
    .limit(1);
  return row;
}

/** Bind (or rebind) one repo to an org. Upserts on the repo name. */
export async function bindRepoToOrg({
  db,
  repoFullName,
  organizationId,
}: {
  db: DB;
  repoFullName: string;
  organizationId: string;
}): Promise<GithubRepoOrgBinding> {
  const normalized = normalizeRepoFullName(repoFullName);
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new Error(`repoFullName must be owner/repo, got: ${repoFullName}`);
  }
  const [row] = await db
    .insert(githubRepoOrgBinding)
    .values({ repoFullName: normalized, organizationId })
    .onConflictDoUpdate({
      target: githubRepoOrgBinding.repoFullName,
      set: { organizationId, updatedAt: new Date() },
    })
    .returning();
  if (!row) {
    throw new Error("Failed to bind repo to org");
  }
  return row;
}

/** Remove a repo's org override. True when a row was deleted. */
export async function unbindRepoFromOrg({
  db,
  repoFullName,
}: {
  db: DB;
  repoFullName: string;
}): Promise<boolean> {
  const deleted = await db
    .delete(githubRepoOrgBinding)
    .where(
      eq(
        githubRepoOrgBinding.repoFullName,
        normalizeRepoFullName(repoFullName),
      ),
    )
    .returning({ id: githubRepoOrgBinding.id });
  return deleted.length > 0;
}

export type RepoOrgSource = "repo_binding" | "installation";

/**
 * The org AND mode for an event on one repo: the repo's org override when it
 * has one, otherwise the installation's org (getInstallationOrgAndMode,
 * unchanged). The mode always comes from the installation, so an override
 * never turns a shadow installation active. The override applies only when
 * the installation is KNOWN (an id with a mapped row): a null or unmapped
 * installation keeps `organizationId: null`, so a binding never bypasses a
 * lane's unmapped-installation rejection. Every installation-resolved
 * webhook lane uses this, so they agree on a repo's org.
 *
 * `boundOrganizationId` reports the repo's binding whether or not it was
 * applied, so a lane can tell "no org, but an org claimed this repo" (the
 * mention lane's fail-closed guard, #579) without reading the binding again.
 */
export async function getRepoOrgAndMode({
  db,
  installationId,
  repoFullName,
}: {
  db: DB;
  installationId: string | number | null | undefined;
  repoFullName: string;
}): Promise<{
  organizationId: string | null;
  mode: InstallationMode;
  source: RepoOrgSource;
  boundOrganizationId: string | null;
}> {
  const [binding, installation] = await Promise.all([
    getRepoOrgBinding({ db, repoFullName }),
    getInstallationOrgAndMode({ db, installationId }),
  ]);
  const boundOrganizationId = binding?.organizationId ?? null;
  if (binding && installation.organizationId !== null) {
    return {
      organizationId: binding.organizationId,
      mode: installation.mode,
      source: "repo_binding",
      boundOrganizationId,
    };
  }
  return { ...installation, source: "installation", boundOrganizationId };
}
