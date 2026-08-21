import { DB } from "@terragon/shared/db";
import { getMembership } from "@terragon/shared/model/organizations";

/**
 * Org-admin role gate for org-governance routes (ADR-005 §4 — the org floor
 * is an org-level control, not a per-member one).
 *
 * This is NET-NEW: no precedent exists in apps/www today. Do not confuse this
 * with Better Auth's platform-staff admin plugin (`user.role === "admin"`,
 * apps/www/src/lib/auth.ts) — that gates Terragon staff across every org,
 * this gates one org's own members against their own org's settings.
 *
 * Built on the `member` table via {@link getMembership}
 * (packages/shared/src/model/organizations.ts:139-156). Better Auth's
 * organization() plugin is configured with no custom roles (auth.ts:316), so
 * the default role set applies: owner | admin | member, with `member.role`
 * defaulting to `"member"` at the schema level (schema.ts:138).
 */
export const ORG_ADMIN_ROLES = new Set(["owner", "admin"]);

/**
 * True when `userId` holds an admin-or-owner role in `organizationId`. No
 * membership row (or a `member` role) resolves to false — fail closed.
 */
export async function isOrgAdmin({
  db,
  organizationId,
  userId,
}: {
  db: DB;
  organizationId: string;
  userId: string;
}): Promise<boolean> {
  const membership = await getMembership({ db, organizationId, userId });
  if (!membership) {
    return false;
  }
  return ORG_ADMIN_ROLES.has(membership.role);
}
