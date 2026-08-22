import { DB } from "../db";
import { repoReviewSettings } from "../db/schema";
import { RepoReviewSetting } from "../db/types";
import { and, eq } from "drizzle-orm";
import { buildEgressPolicyShape } from "./egress-policy";

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

/**
 * Normalize a repo slug for storage/lookup (case-insensitive GitHub slugs).
 * Exported so every model keying on a repo slug (e.g. `hatchet-run`) shares ONE
 * normalization — divergent copies would silently miss rows on case mismatch.
 */
export function normalizeRepo(repoFullName: string): string {
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
 * Upsert one or more fields of the `(org, repo)` review-settings row. Conflict
 * target is the `(organization_id, repo_full_name)` unique index, so a repeat
 * write updates in place. Only the fields present in `patch` are written — an
 * absent field keeps its stored value (or its column default on first insert:
 * `blockTolerance` → 'warning', `reviewDraftPrs` → true). Returns the stored row.
 * `blockTolerance`, when present, MUST be pre-validated by the caller (the route
 * validates against `BLOCK_TOLERANCES`).
 */
export async function upsertRepoReviewSetting({
  db,
  organizationId,
  repoFullName,
  patch,
  updatedByUserId,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  patch: {
    blockTolerance?: string;
    reviewDraftPrs?: boolean;
    /** '#66 egress level ('none'|'ip_port'|'domain'); null clears (= no enforcement). */
    egressPolicy?: string | null;
    /** #66 operator allowlist entries; null clears. Validated at shape-build time. */
    egressAllowlist?: string[] | null;
  };
  updatedByUserId?: string | null;
}): Promise<RepoReviewSetting> {
  const repo = normalizeRepo(repoFullName);

  // #66: validate egress fields at the WRITE boundary by reusing the pure shape
  // builder (empty system hosts) — an invalid level or allowlist entry throws
  // here instead of landing in the table. A partial egress patch pairs with the
  // stored other half so entries are always checked against the effective
  // level. Dispatch-time validation (resolveEgressPolicy) stays as backstop.
  if (patch.egressPolicy !== undefined || patch.egressAllowlist !== undefined) {
    let level = patch.egressPolicy;
    let allowlist = patch.egressAllowlist;
    if (level === undefined || allowlist === undefined) {
      const existing = await getRepoReviewSetting({
        db,
        organizationId,
        repoFullName,
      });
      if (level === undefined) level = existing?.egressPolicy ?? null;
      if (allowlist === undefined)
        allowlist = existing?.egressAllowlist ?? null;
    }
    buildEgressPolicyShape(
      { egressPolicy: level, egressAllowlist: allowlist },
      { systemHosts: [] },
    );
  }
  const set: {
    blockTolerance?: string;
    reviewDraftPrs?: boolean;
    egressPolicy?: string | null;
    egressAllowlist?: string[] | null;
    updatedByUserId: string | null;
    updatedAt: Date;
  } = { updatedByUserId: updatedByUserId ?? null, updatedAt: new Date() };
  if (patch.blockTolerance !== undefined)
    set.blockTolerance = patch.blockTolerance;
  if (patch.reviewDraftPrs !== undefined)
    set.reviewDraftPrs = patch.reviewDraftPrs;
  if (patch.egressPolicy !== undefined) set.egressPolicy = patch.egressPolicy;
  if (patch.egressAllowlist !== undefined)
    set.egressAllowlist = patch.egressAllowlist;

  const [row] = await db
    .insert(repoReviewSettings)
    .values({
      organizationId,
      repoFullName: repo,
      // Omitted fields fall to the column defaults on first insert.
      ...(patch.blockTolerance !== undefined
        ? { blockTolerance: patch.blockTolerance }
        : {}),
      ...(patch.reviewDraftPrs !== undefined
        ? { reviewDraftPrs: patch.reviewDraftPrs }
        : {}),
      ...(patch.egressPolicy !== undefined
        ? { egressPolicy: patch.egressPolicy }
        : {}),
      ...(patch.egressAllowlist !== undefined
        ? { egressAllowlist: patch.egressAllowlist }
        : {}),
      updatedByUserId: updatedByUserId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        repoReviewSettings.organizationId,
        repoReviewSettings.repoFullName,
      ],
      set,
    })
    .returning();
  return row!;
}

/** Convenience: set only the tolerance, preserving any draft-policy field. */
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
  return upsertRepoReviewSetting({
    db,
    organizationId,
    repoFullName,
    patch: { blockTolerance },
    updatedByUserId,
  });
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
