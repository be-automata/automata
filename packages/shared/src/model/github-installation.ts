import { DB } from "../db";
import { githubInstallation } from "../db/schema";
import { GithubInstallation } from "../db/types";
import { eq } from "drizzle-orm";

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
