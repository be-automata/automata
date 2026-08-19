import { createHash } from "node:crypto";
import { DB } from "../db";
import { repoSkills, repoSkillVersions } from "../db/schema";
import {
  RepoSkill,
  RepoSkillVersion,
  RepoSkillVersionSource,
} from "../db/types";
import { and, asc, desc, eq } from "drizzle-orm";
import { normalizeRepo } from "./repo-review-settings";

/**
 * Live, versioned skills per (org, repo, skill) — the DB tier of the hybrid
 * skill store (issue #54). The automation row stores a REFERENCE
 * (`skill_message` action); the control plane resolves the current version at
 * thread-creation time, so an accepted edit is live on the next run with no
 * seed script and no redeploy — the same live-read model as
 * `repo-review-settings`.
 *
 * MULTI-TENANT: every read and write is fenced by `organizationId`, and
 * `repoFullName` is lowercased on both write and read via the shared
 * `normalizeRepo` (case-insensitive GitHub slugs). Version reads are fenced
 * too — a version id from another org's skill never resolves.
 *
 * Versions are APPEND-ONLY: an edit inserts a `repo_skill_versions` row and
 * moves `currentVersionId`; rollback is moving the pointer back. Body content
 * is never mutated in place, so `contentSha` stamped on a thread's
 * sourceMetadata is always traceable to the exact text that ran.
 */

/**
 * sha256 hex of a skill body — the traceability stamp written on every
 * version and verified by the write surfaces (API route, dashboard,
 * deploy/skill-push.ts).
 */
export function computeContentSha(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Read the skill row for one `(org, repo, skill)`, or undefined when none
 * exists (the resolver then falls back to the tracked default). Read LIVE on
 * every automation run — an accepted edit applies with no restart.
 */
export async function getRepoSkill({
  db,
  organizationId,
  repoFullName,
  skillName,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  skillName: string;
}): Promise<RepoSkill | undefined> {
  const [row] = await db
    .select()
    .from(repoSkills)
    .where(
      and(
        eq(repoSkills.organizationId, organizationId),
        eq(repoSkills.repoFullName, normalizeRepo(repoFullName)),
        eq(repoSkills.skillName, skillName),
      ),
    )
    .limit(1);
  return row;
}

/** List all skills for one org, optionally narrowed to one repo (dashboard). */
export async function listRepoSkills({
  db,
  organizationId,
  repoFullName,
}: {
  db: DB;
  organizationId: string;
  repoFullName?: string;
}): Promise<RepoSkill[]> {
  return db
    .select()
    .from(repoSkills)
    .where(
      and(
        eq(repoSkills.organizationId, organizationId),
        ...(repoFullName
          ? [eq(repoSkills.repoFullName, normalizeRepo(repoFullName))]
          : []),
      ),
    );
}

/**
 * Read one version by id, ORG-FENCED through its parent skill row: a version
 * id leaked (or guessed) across tenants resolves to undefined, never to
 * another org's skill body. Used by the resolver for both 'latest' (via
 * currentVersionId) and pinned references.
 */
export async function getSkillVersion({
  db,
  organizationId,
  versionId,
}: {
  db: DB;
  organizationId: string;
  versionId: string;
}): Promise<RepoSkillVersion | undefined> {
  const [row] = await db
    .select({
      id: repoSkillVersions.id,
      skillId: repoSkillVersions.skillId,
      body: repoSkillVersions.body,
      contentSha: repoSkillVersions.contentSha,
      source: repoSkillVersions.source,
      createdByUserId: repoSkillVersions.createdByUserId,
      createdAt: repoSkillVersions.createdAt,
    })
    .from(repoSkillVersions)
    .innerJoin(repoSkills, eq(repoSkillVersions.skillId, repoSkills.id))
    .where(
      and(
        eq(repoSkillVersions.id, versionId),
        eq(repoSkills.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Oldest `source: 'seed'` version for one `(org, repo, skill)` — the
 * resolver's LAST fallback tier. Seed versions are pushed from the tracked
 * in-repo skill files by `deploy/seed-pilot-mirror.ts`, so this row is the DB
 * record of the shipped default; the runtime never reads the filesystem (the
 * Workers bundle has no checkout). Org-fenced like every other read here.
 * Ordered by (createdAt, id) so re-seeds never change which row is "the"
 * default.
 */
export async function getOldestSeedVersion({
  db,
  organizationId,
  repoFullName,
  skillName,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  skillName: string;
}): Promise<RepoSkillVersion | undefined> {
  const [row] = await db
    .select({
      id: repoSkillVersions.id,
      skillId: repoSkillVersions.skillId,
      body: repoSkillVersions.body,
      contentSha: repoSkillVersions.contentSha,
      source: repoSkillVersions.source,
      createdByUserId: repoSkillVersions.createdByUserId,
      createdAt: repoSkillVersions.createdAt,
    })
    .from(repoSkillVersions)
    .innerJoin(repoSkills, eq(repoSkillVersions.skillId, repoSkills.id))
    .where(
      and(
        eq(repoSkills.organizationId, organizationId),
        eq(repoSkills.repoFullName, normalizeRepo(repoFullName)),
        eq(repoSkills.skillName, skillName),
        eq(repoSkillVersions.source, "seed"),
      ),
    )
    .orderBy(asc(repoSkillVersions.createdAt), asc(repoSkillVersions.id))
    .limit(1);
  return row;
}

/**
 * Version-history METADATA for one skill — deliberately excludes `body`.
 * The history views (GET route version list, dashboard panel) only need
 * id/sha/provenance; bodies can be large (the github-ops methodology is
 * multi-KB) and multiplying that by every version on every history read is
 * pure waste. Fetch one body on demand via `getSkillVersion`. Newest first,
 * org-fenced through the parent skill row like every other read here.
 */
export type RepoSkillVersionMeta = Omit<RepoSkillVersion, "body">;

export async function listSkillVersions({
  db,
  organizationId,
  repoFullName,
  skillName,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  skillName: string;
}): Promise<RepoSkillVersionMeta[]> {
  return db
    .select({
      id: repoSkillVersions.id,
      skillId: repoSkillVersions.skillId,
      contentSha: repoSkillVersions.contentSha,
      source: repoSkillVersions.source,
      createdByUserId: repoSkillVersions.createdByUserId,
      createdAt: repoSkillVersions.createdAt,
    })
    .from(repoSkillVersions)
    .innerJoin(repoSkills, eq(repoSkillVersions.skillId, repoSkills.id))
    .where(
      and(
        eq(repoSkills.organizationId, organizationId),
        eq(repoSkills.repoFullName, normalizeRepo(repoFullName)),
        eq(repoSkills.skillName, skillName),
      ),
    )
    .orderBy(desc(repoSkillVersions.createdAt), desc(repoSkillVersions.id));
}

/**
 * Append a new version and move `currentVersionId` to it — THE edit operation
 * for every surface (dashboard PUT, API/CLI push, seed, repo-file sync). The
 * skill row is created on first write (get-or-create keyed on the unique
 * (org, repo, skill) index). Runs in one transaction so a version row can
 * never exist without the pointer move, and vice versa. The sha256 is
 * computed HERE, not trusted from the caller — the hash must always match
 * the stored body. Returns the stored skill row and the new version.
 *
 * Contract validation (e.g. the github-ops fenced-json check) deliberately
 * lives at the write boundary (route/CLI) and the resolver, not here: the
 * model stores what it is given, and the resolver refuses to dispatch a
 * contract-less body.
 */
export async function createRepoSkillVersion({
  db,
  organizationId,
  repoFullName,
  skillName,
  body,
  source,
  createdByUserId,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  skillName: string;
  body: string;
  source: RepoSkillVersionSource;
  createdByUserId?: string | null;
}): Promise<{ skill: RepoSkill; version: RepoSkillVersion }> {
  const repo = normalizeRepo(repoFullName);
  return db.transaction(async (tx) => {
    // Get-or-create the skill row. onConflictDoNothing + re-read (instead of a
    // dummy-update upsert) so a concurrent first-write race still converges on
    // one row without clobbering its pointers.
    await tx
      .insert(repoSkills)
      .values({ organizationId, repoFullName: repo, skillName })
      .onConflictDoNothing({
        target: [
          repoSkills.organizationId,
          repoSkills.repoFullName,
          repoSkills.skillName,
        ],
      });
    const [skillRow] = await tx
      .select()
      .from(repoSkills)
      .where(
        and(
          eq(repoSkills.organizationId, organizationId),
          eq(repoSkills.repoFullName, repo),
          eq(repoSkills.skillName, skillName),
        ),
      )
      .limit(1);
    if (!skillRow) {
      throw new Error(
        `repo_skills row missing after upsert for (${organizationId}, ${repo}, ${skillName})`,
      );
    }
    const [version] = await tx
      .insert(repoSkillVersions)
      .values({
        skillId: skillRow.id,
        body,
        contentSha: computeContentSha(body),
        source,
        createdByUserId: createdByUserId ?? null,
      })
      .returning();
    const [skill] = await tx
      .update(repoSkills)
      .set({ currentVersionId: version!.id, updatedAt: new Date() })
      .where(eq(repoSkills.id, skillRow.id))
      .returning();
    return { skill: skill!, version: version! };
  });
}

/**
 * Revert = move `currentVersionId` back to a chosen EXISTING version. This is
 * deliberately NOT `promoteLastKnownGood` (which moves the resolver's fallback
 * pointer after a demonstrably healthy run) and deliberately NOT a new version
 * row: history stays append-only and linear, and the reverted-to sha remains
 * traceable to the exact text that originally ran. Same fencing rules as
 * promotion — the version must belong to this (org, repo, skill) or the call
 * is a no-op returning undefined (a guessed/cross-tenant version id can never
 * become live).
 */
export async function revertSkillToVersion({
  db,
  organizationId,
  repoFullName,
  skillName,
  versionId,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  skillName: string;
  versionId: string;
}): Promise<RepoSkill | undefined> {
  const skill = await getRepoSkill({
    db,
    organizationId,
    repoFullName,
    skillName,
  });
  if (!skill) {
    return undefined;
  }
  const version = await getSkillVersion({ db, organizationId, versionId });
  if (!version || version.skillId !== skill.id) {
    return undefined;
  }
  const [updated] = await db
    .update(repoSkills)
    .set({ currentVersionId: versionId, updatedAt: new Date() })
    .where(eq(repoSkills.id, skill.id))
    .returning();
  return updated;
}

/**
 * Promote a version to `lastKnownGoodVersionId` — called after the version
 * demonstrably produced a healthy run (e.g. a non-degraded review post), so
 * the resolver's fallback tier never points at a body that has not worked in
 * production. Org-fenced AND skill-fenced: the version must belong to this
 * (org, repo, skill) or the call is a no-op returning undefined.
 */
export async function promoteLastKnownGood({
  db,
  organizationId,
  repoFullName,
  skillName,
  versionId,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  skillName: string;
  versionId: string;
}): Promise<RepoSkill | undefined> {
  const skill = await getRepoSkill({
    db,
    organizationId,
    repoFullName,
    skillName,
  });
  if (!skill) {
    return undefined;
  }
  const version = await getSkillVersion({ db, organizationId, versionId });
  if (!version || version.skillId !== skill.id) {
    return undefined;
  }
  const [updated] = await db
    .update(repoSkills)
    .set({ lastKnownGoodVersionId: versionId, updatedAt: new Date() })
    .where(eq(repoSkills.id, skill.id))
    .returning();
  return updated;
}
