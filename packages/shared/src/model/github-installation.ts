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
}: {
  db: DB;
  installationId: string | number;
  organizationId: string | null;
  accountLogin?: string | null;
  accountType?: string | null;
}): Promise<GithubInstallation> {
  const installationIdStr = String(installationId);
  const [row] = await db
    .insert(githubInstallation)
    .values({
      installationId: installationIdStr,
      organizationId,
      accountLogin,
      accountType,
    })
    .onConflictDoUpdate({
      target: githubInstallation.installationId,
      set: {
        organizationId,
        ...(accountLogin !== undefined ? { accountLogin } : {}),
        ...(accountType !== undefined ? { accountType } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) {
    throw new Error("Failed to bind GitHub installation");
  }
  return row;
}
