import { DB } from "../db";
import { repoReviewSettings } from "../db/schema";
import { RepoReviewSetting } from "../db/types";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
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
 * Supersede policies for PR-review runs (#125/#127): what happens when a new
 * commit lands while a review run is still in flight on the same PR.
 *  - 'newest-wins'          → engine cancels the in-flight run, runs the new one
 *  - 'complete-run-queue'   → the new run queues behind the in-flight one
 *  - 'complete-run-discard' → the new run is discarded while one is live
 *  - 'app-side'             → the control plane decides (legacy #8 rules)
 */
/** The stored row changed since the caller read it (expectedUpdatedAt mismatch). */
export class RepoReviewSettingConflictError extends Error {
  constructor() {
    super("repo review setting changed since it was read");
    this.name = "RepoReviewSettingConflictError";
  }
}

export const SUPERSEDE_POLICIES = [
  "newest-wins",
  "complete-run-queue",
  "complete-run-discard",
  "app-side",
] as const;
export type SupersedePolicy = (typeof SUPERSEDE_POLICIES)[number];

/** The policy every (org, repo) gets when nothing is configured. */
export const DEFAULT_SUPERSEDE_POLICY: SupersedePolicy = "newest-wins";

/**
 * The org-default row's repo slug sentinel. `normalizeRepo` lowercases real
 * slugs and GitHub slugs can never be a bare '*', so this row can never
 * collide with a real repo override.
 */
export const ORG_DEFAULT_REPO_SENTINEL = "*";

export function isSupersedePolicy(value: string): value is SupersedePolicy {
  return (SUPERSEDE_POLICIES as readonly string[]).includes(value);
}

/**
 * The policy snapshot stamped onto a run at dispatch (#125 decision 5): the
 * authority for that run's audit/recheck/cancel semantics. Consumers read the
 * stamp, never the current settings row — so BOTH fields travel together.
 */
export type SupersedeSnapshot = {
  policy: SupersedePolicy;
  recheckOnComplete: boolean;
};

/**
 * The one human wording per policy — shared by the thread-view chip (C5) and
 * the settings page (C6) so the two can never disagree.
 */
export const SUPERSEDE_POLICY_LABELS: Record<SupersedePolicy, string> = {
  "newest-wins": "newest commit wins",
  "complete-run-queue": "finish the running review, then queue",
  "complete-run-discard": "finish the running review, drop newer",
  "app-side": "control plane decides",
};

/**
 * One query for a repo's row AND the org-default sentinel row ('*'). The
 * draft-PR resolver consumes this: repo override → org default → (caller's
 * legacy tiers). Same single-query shape as resolveSupersedePolicy — the
 * two candidate rows are fetched together so the tiers can never straddle
 * two snapshots.
 */
export async function getRepoReviewSettingWithOrgDefault({
  db,
  organizationId,
  repoFullName,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
}): Promise<{
  repo: RepoReviewSetting | undefined;
  orgDefault: RepoReviewSetting | undefined;
}> {
  const repo = normalizeRepo(repoFullName);
  const rows = await db
    .select()
    .from(repoReviewSettings)
    .where(
      and(
        eq(repoReviewSettings.organizationId, organizationId),
        inArray(repoReviewSettings.repoFullName, [
          repo,
          ORG_DEFAULT_REPO_SENTINEL,
        ]),
      ),
    );
  const byRepo = new Map(rows.map((r) => [r.repoFullName, r]));
  return {
    repo: byRepo.get(repo),
    orgDefault: byRepo.get(ORG_DEFAULT_REPO_SENTINEL),
  };
}

/**
 * Resolve the effective supersede policy for one (org, repo): exact repo
 * override → org-default sentinel row ('*') → 'newest-wins'. One query for
 * both candidate rows; resolved LIVE at every dispatch.
 *
 * An unknown stored value THROWS (never a silent degrade): a bad row must
 * fail the dispatch loudly, exactly like an invalid egress policy does.
 */
export async function resolveSupersedePolicy({
  db,
  organizationId,
  repoFullName,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
}): Promise<SupersedeSnapshot> {
  const repo = normalizeRepo(repoFullName);
  const rows = await db
    .select()
    .from(repoReviewSettings)
    .where(
      and(
        eq(repoReviewSettings.organizationId, organizationId),
        inArray(repoReviewSettings.repoFullName, [
          repo,
          ORG_DEFAULT_REPO_SENTINEL,
        ]),
      ),
    );
  const byRepo = new Map(rows.map((r) => [r.repoFullName, r]));
  for (const candidate of [repo, ORG_DEFAULT_REPO_SENTINEL]) {
    const row = byRepo.get(candidate);
    if (!row?.supersedePolicy) continue;
    if (!isSupersedePolicy(row.supersedePolicy)) {
      throw new Error(
        `Unknown supersedePolicy '${row.supersedePolicy}' stored for ` +
          `(${organizationId}, ${row.repoFullName}) — refusing to dispatch ` +
          `with a silently-degraded policy`,
      );
    }
    return {
      policy: row.supersedePolicy,
      recheckOnComplete: row.recheckOnComplete,
    };
  }
  return { policy: DEFAULT_SUPERSEDE_POLICY, recheckOnComplete: false };
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
  expectedUpdatedAt,
  expectAbsentSupersedeOverride,
  expectRowAbsent,
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
    /** #125/#127 supersede policy; null clears (falls back org-default → 'newest-wins'). */
    supersedePolicy?: string | null;
    /** #125 discard-mode recheck toggle. */
    recheckOnComplete?: boolean;
  };
  updatedByUserId?: string | null;
  /**
   * Optimistic concurrency (#131): when given, the write applies ONLY if the
   * stored row's updatedAt still equals this value — enforced by the database
   * in the same statement (ON CONFLICT … DO UPDATE … WHERE), never by a
   * read-then-write. A mismatch throws {@link RepoReviewSettingConflictError}.
   * A row that does not exist yet is created (nothing to conflict with).
   */
  expectedUpdatedAt?: Date;
  /**
   * First-write CAS (#131): the write applies ONLY if no supersede override
   * exists yet (`supersede_policy IS NULL` — the row may still exist for the
   * tolerance/egress families). Two admins racing to create the same repo's
   * first override: the loser throws {@link RepoReviewSettingConflictError}.
   * Mutually exclusive with `expectedUpdatedAt`.
   */
  expectAbsentSupersedeOverride?: boolean;
  /**
   * Whole-row first-write CAS (org-default sentinel writes). The write applies
   * ONLY if NO row exists at all. The per-family absence fence above is wrong
   * for the sentinel: a draft-toggle-only first write would slip past a
   * `supersede_policy IS NULL` check even though another admin's draft write
   * already landed — and draft-created sentinel rows keep supersede_policy
   * NULL, hollowing that fence for the supersede family too. The default
   * route's GET returns the WHOLE row, so its client sends
   * `expectedUpdatedAt: null` only when the row is truly absent — making
   * row-level absence the correct fence there. Mutually exclusive with both
   * fences above.
   */
  expectRowAbsent?: boolean;
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
  // #127: an unknown policy must never land in the table (dispatch throws on
  // read as backstop, but the write boundary is the right place to reject).
  if (
    patch.supersedePolicy !== undefined &&
    patch.supersedePolicy !== null &&
    !isSupersedePolicy(patch.supersedePolicy)
  ) {
    throw new Error(
      `Unknown supersedePolicy '${patch.supersedePolicy}' — expected one of ${SUPERSEDE_POLICIES.join(", ")}`,
    );
  }
  const set: {
    blockTolerance?: string;
    reviewDraftPrs?: boolean;
    egressPolicy?: string | null;
    egressAllowlist?: string[] | null;
    supersedePolicy?: string | null;
    recheckOnComplete?: boolean;
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
  if (patch.supersedePolicy !== undefined)
    set.supersedePolicy = patch.supersedePolicy;
  if (patch.recheckOnComplete !== undefined)
    set.recheckOnComplete = patch.recheckOnComplete;

  // CAS has two shapes: a version fence for edits (updated_at must still be
  // the value the admin read), and an ABSENCE fence for first writes
  // (expectAbsentSupersedeOverride: the row may exist for another family, but
  // supersede_policy must still be NULL). Both are enforced by the DATABASE
  // in the write itself; the loser's UPDATE matches no row and 409s — two
  // admins racing to CREATE the first override can never both get 200.
  const setWhere = expectedUpdatedAt
    ? eq(repoReviewSettings.updatedAt, expectedUpdatedAt)
    : expectRowAbsent
      ? // Any pre-existing row loses: the ON CONFLICT UPDATE matches nothing.
        sql`false`
      : expectAbsentSupersedeOverride
        ? isNull(repoReviewSettings.supersedePolicy)
        : undefined;
  const [row] = await db
    .insert(repoReviewSettings)
    // `set` holds exactly the defined patch fields (+ provenance); omitted
    // fields fall to the column defaults on first insert.
    .values({ organizationId, repoFullName: repo, ...set })
    .onConflictDoUpdate({
      target: [
        repoReviewSettings.organizationId,
        repoReviewSettings.repoFullName,
      ],
      set,
      ...(setWhere ? { setWhere } : {}),
    })
    .returning();
  if (!row) {
    if (setWhere) {
      throw new RepoReviewSettingConflictError();
    }
    throw new Error("upsertRepoReviewSetting returned no row");
  }
  return row;
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
 * "Reset to default" for the TOLERANCE family (block tolerance + draft-PR
 * review) of one repo. The row is shared with the other per-repo families
 * (#66 egress, #125 supersede policy): when any of those still carries an
 * override the row is KEPT and only the tolerance columns go back to their
 * defaults; the row is deleted only when nothing else lives on it. Resetting
 * a repo's tolerance must never silently discard its supersede policy.
 * Optional `expectedUpdatedAt` makes the reset a compare-and-swap (409-class
 * conflict → false, nothing changed).
 */
export async function removeRepoReviewSetting({
  db,
  organizationId,
  repoFullName,
  expectedUpdatedAt,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  expectedUpdatedAt?: Date;
}): Promise<{ removed: boolean; conflict: boolean }> {
  const repo = normalizeRepo(repoFullName);
  const rowFilter = and(
    eq(repoReviewSettings.organizationId, organizationId),
    eq(repoReviewSettings.repoFullName, repo),
    ...(expectedUpdatedAt
      ? [eq(repoReviewSettings.updatedAt, expectedUpdatedAt)]
      : []),
  );
  // The "does another family live on this row" decision is made BY THE
  // DATABASE inside each statement, not by a prior SELECT: a supersede/egress
  // override landing concurrently can never be wiped by a reset that read
  // the row a moment earlier.
  const otherFamiliesPresent = or(
    isNotNull(repoReviewSettings.supersedePolicy),
    isNotNull(repoReviewSettings.egressPolicy),
    isNotNull(repoReviewSettings.egressAllowlist),
  )!;
  const reset = await db
    .update(repoReviewSettings)
    .set({
      blockTolerance: "warning",
      reviewDraftPrs: true,
      updatedAt: new Date(),
    })
    .where(and(rowFilter, otherFamiliesPresent))
    .returning({ id: repoReviewSettings.id });
  if (reset.length > 0) return { removed: true, conflict: false };
  const deleted = await db
    .delete(repoReviewSettings)
    .where(and(rowFilter, not(otherFamiliesPresent)))
    .returning({ id: repoReviewSettings.id });
  if (deleted.length > 0) return { removed: true, conflict: false };
  // Nothing matched: either no row (nothing to reset) or, with a version
  // given, the row moved on since the caller read it.
  if (expectedUpdatedAt) {
    const exists = await getRepoReviewSetting({
      db,
      organizationId,
      repoFullName,
    });
    return { removed: false, conflict: exists !== undefined };
  }
  return { removed: false, conflict: false };
}

/** List all tolerance overrides for one org (dashboard settings page). */
export async function listRepoReviewSettings({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<RepoReviewSetting[]> {
  // The org-default sentinel ('*') is a storage encoding, not a repo override —
  // it has its own accessor (getRepoReviewSetting with the sentinel name) and
  // must never leak into "list the org's overrides".
  return db
    .select()
    .from(repoReviewSettings)
    .where(
      and(
        eq(repoReviewSettings.organizationId, organizationId),
        ne(repoReviewSettings.repoFullName, ORG_DEFAULT_REPO_SENTINEL),
      ),
    );
}
