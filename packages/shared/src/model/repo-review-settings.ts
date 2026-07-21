import { DB } from "../db";
import { repoReviewSettings } from "../db/schema";
import { RepoReviewSetting } from "../db/types";
import { and, eq } from "drizzle-orm";

/**
 * Per-repository REQUESTED_CHANGES severity tolerance (ADR-036 review floor),
 * persisted in Neon and edited from the dashboard. This is the Automata-native
 * replacement for the orch-agents SQLite store — the same feature on the Workers
 * runtime, where `node:sqlite` is unavailable.
 *
 * MULTI-TENANT: every read and write is fenced by `organizationId` — the same
 * repo slug under two orgs carries two independent tolerances and one org can
 * never read or clobber another's. `repoFullName` is lowercased on BOTH write
 * and read: GitHub slugs are case-insensitive but webhook / automation casing
 * varies, and a case-mismatched override must never silently stop matching.
 *
 * The stored `blockTolerance` is a raw string here (kept dependency-free from
 * `@terragon/review`); validation to the `BlockTolerance` union happens at the
 * apps/www boundary via `isBlockTolerance` before it maps to a policy.
 */

/** Normalize a repo slug for storage/lookup (case-insensitive GitHub slugs). */
function normalizeRepo(repoFullName: string): string {
  return repoFullName.trim().toLowerCase();
}

/**
 * Read the tolerance override for one `(org, repo)`, or undefined when none
 * exists (the repo then falls back to env/default at the resolver). Read LIVE on
 * every dispatched review run — a dashboard write applies with no restart.
 */
export async function getRepoReviewSetting({
  db,
  organizationId,
  repoFullName,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
}): Promise<RepoReviewSetting | undefined> {
  const [row] = await db
    .select()
    .from(repoReviewSettings)
    .where(
      and(
        eq(repoReviewSettings.organizationId, organizationId),
        eq(repoReviewSettings.repoFullName, normalizeRepo(repoFullName)),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Upsert the tolerance override for one `(org, repo)`. Conflict target is the
 * `(organization_id, repo_full_name)` unique index, so a repeat write updates in
 * place. Returns the stored row. `blockTolerance` MUST be pre-validated by the
 * caller (the route validates against `BLOCK_TOLERANCES`).
 */
export async function setRepoReviewSetting({
  db,
  organizationId,
  repoFullName,
  blockTolerance,
  updatedByUserId,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  blockTolerance: string;
  updatedByUserId?: string | null;
}): Promise<RepoReviewSetting> {
  const repo = normalizeRepo(repoFullName);
  const [row] = await db
    .insert(repoReviewSettings)
    .values({
      organizationId,
      repoFullName: repo,
      blockTolerance,
      updatedByUserId: updatedByUserId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        repoReviewSettings.organizationId,
        repoReviewSettings.repoFullName,
      ],
      set: {
        blockTolerance,
        updatedByUserId: updatedByUserId ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row!;
}

/**
 * Remove the override for one `(org, repo)` (repo reverts to env/default). No-op
 * when absent. Returns true when a row was actually deleted.
 */
export async function removeRepoReviewSetting({
  db,
  organizationId,
  repoFullName,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
}): Promise<boolean> {
  const deleted = await db
    .delete(repoReviewSettings)
    .where(
      and(
        eq(repoReviewSettings.organizationId, organizationId),
        eq(repoReviewSettings.repoFullName, normalizeRepo(repoFullName)),
      ),
    )
    .returning({ id: repoReviewSettings.id });
  return deleted.length > 0;
}

/** List all tolerance overrides for one org (dashboard settings page). */
export async function listRepoReviewSettings({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<RepoReviewSetting[]> {
  return db
    .select()
    .from(repoReviewSettings)
    .where(eq(repoReviewSettings.organizationId, organizationId));
}
