import { DB } from "../db";
import { organizationReviewSettings } from "../db/schema";
import { OrganizationReviewSetting } from "../db/types";
import { eq } from "drizzle-orm";

/**
 * Per-organization review-settings floor (ADR-005 §4) — the org-wide
 * `blockTolerance` and `trustedAuthorThreshold` floors, persisted in Neon and
 * edited from the dashboard. A repo's own `repoReviewSettings` row may only
 * narrow `blockTolerance` and only *raise* `trustedAuthorThreshold`
 * relative to this row (`T_eff = max(T_org, T_repo)`); composition happens at
 * the resolver, not here.
 *
 * MULTI-TENANT: `organizationId` is both the primary key and the tenant
 * fence — one row per org, no repo slug in this table, so lookups are a bare
 * PK match (no `normalizeRepo` needed, unlike `repoReviewSettings`).
 *
 * The stored `blockTolerance` and `trustedAuthorThreshold` are raw strings
 * here (kept dependency-free from `@terragon/review`); validation to their
 * respective unions happens at the apps/www boundary before they map to a
 * policy.
 */

/**
 * Read the org-wide floor row, or undefined when none exists (the org then
 * has no floor and repos are unconstrained by this axis). Read LIVE on every
 * dispatched review run — a dashboard write applies with no restart.
 */
export async function getOrganizationReviewSetting({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<OrganizationReviewSetting | undefined> {
  const [row] = await db
    .select()
    .from(organizationReviewSettings)
    .where(eq(organizationReviewSettings.organizationId, organizationId))
    .limit(1);
  return row;
}

/**
 * Upsert one or more fields of the org's review-settings floor row. Conflict
 * target is the `organizationId` primary key, so a repeat write updates in
 * place. Only the fields present in `patch` are written — an absent field
 * keeps its stored value (or NULL on first insert, meaning "no floor" for
 * that axis). Pass `null` explicitly to CLEAR a previously set floor.
 * Returns the stored row. `blockTolerance` and `trustedAuthorThreshold`, when
 * present, MUST be pre-validated by the caller.
 */
export async function upsertOrganizationReviewSetting({
  db,
  organizationId,
  patch,
  updatedByUserId,
}: {
  db: DB;
  organizationId: string;
  patch: {
    blockTolerance?: string | null;
    trustedAuthorThreshold?: string | null;
  };
  updatedByUserId?: string | null;
}): Promise<OrganizationReviewSetting> {
  const set: {
    blockTolerance?: string | null;
    trustedAuthorThreshold?: string | null;
    updatedByUserId: string | null;
    updatedAt: Date;
  } = { updatedByUserId: updatedByUserId ?? null, updatedAt: new Date() };
  if (patch.blockTolerance !== undefined)
    set.blockTolerance = patch.blockTolerance;
  if (patch.trustedAuthorThreshold !== undefined)
    set.trustedAuthorThreshold = patch.trustedAuthorThreshold;

  const [row] = await db
    .insert(organizationReviewSettings)
    .values({
      organizationId,
      // Omitted fields fall to NULL (no floor) on first insert.
      ...(patch.blockTolerance !== undefined
        ? { blockTolerance: patch.blockTolerance }
        : {}),
      ...(patch.trustedAuthorThreshold !== undefined
        ? { trustedAuthorThreshold: patch.trustedAuthorThreshold }
        : {}),
      updatedByUserId: updatedByUserId ?? null,
    })
    .onConflictDoUpdate({
      target: [organizationReviewSettings.organizationId],
      set,
    })
    .returning();
  return row!;
}

/**
 * Remove the org's review-settings floor row entirely (both axes revert to
 * "no floor"). No-op when absent. Returns true when a row was actually
 * deleted.
 */
export async function removeOrganizationReviewSetting({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<boolean> {
  const deleted = await db
    .delete(organizationReviewSettings)
    .where(eq(organizationReviewSettings.organizationId, organizationId))
    .returning({ organizationId: organizationReviewSettings.organizationId });
  return deleted.length > 0;
}
