import type { DB } from "@terragon/shared/db";
import {
  getOldestSeedVersion,
  getRepoSkill,
  getSkillVersion,
} from "@terragon/shared/model/repo-skills";
import { validateSkillBody } from "./review-skill";

/**
 * Resolve the ONE skill-body snapshot for a single automation run — the live
 * counterpart of the seed-time inlining (issue #54, twin of
 * resolve-approve-floor). Called at thread-creation time in runAutomation, so
 * an accepted skill edit is picked up by the NEXT run with no seed script and
 * no redeploy; in-flight threads are untouched by construction.
 *
 * PURE-DB by design: the resolver never touches the filesystem. The Workers
 * runtime has no checkout, and the one fs-based tier this module used to have
 * broke the production build (webpack rewrote its module-scope
 * `new URL(..., import.meta.url)` into an asset URL — PR #57). The tracked
 * in-repo skill files reach the DB only through the tsx write surfaces
 * (deploy/seed-pilot-mirror.ts, deploy/skill-push.ts).
 *
 * Fallback chain — a body that fails its skill's validator is NEVER dispatched:
 *   1. the referenced version (currentVersionId for 'latest', or the pin)
 *   2. lastKnownGoodVersionId (promoted only after a demonstrably healthy run)
 *   3. the oldest `source: 'seed'` version — the DB record of the shipped
 *      default. A skill with no usable version at all resolves to null and the
 *      caller skips thread creation with a loud log, rather than dispatch an
 *      instruction nobody in the org ever approved.
 *
 * Validation is PER-SKILL (`validateSkillBody` — the shared registry in
 * review-skill.ts, also enforced at every write surface): github-ops requires
 * the fenced-json verdict contract; any other skill requires only a non-empty
 * body.
 */

export type ResolvedSkill = {
  /** The raw skill body (render placeholders before dispatch). */
  body: string;
  /** sha256 of `body` — stamped into thread.sourceMetadata for traceability. */
  contentSha: string;
  /** Which tier of the fallback chain served the body. */
  source: "db-version" | "seed-default";
  /** The repo_skill_versions row id — always present (every tier is a row). */
  versionId: string;
};

/**
 * Substitute the supported placeholders into a skill body. Deliberately tiny:
 * only `{{repoFullName}}` and `{{baseBranch}}` are defined; any OTHER
 * `{{...}}` token is left verbatim (a skill author's literal braces must not
 * be silently eaten, and a typoed placeholder surfacing in the prompt is
 * visible, unlike one substituted with 'undefined').
 */
export function renderSkillPlaceholders(
  body: string,
  vars: { repoFullName: string; baseBranch: string },
): string {
  return body
    .replaceAll("{{repoFullName}}", vars.repoFullName)
    .replaceAll("{{baseBranch}}", vars.baseBranch);
}

export async function resolveReviewSkill({
  db,
  organizationId,
  repoFullName,
  skillName,
  version,
}: {
  db: DB;
  organizationId: string | null | undefined;
  repoFullName: string;
  skillName: string;
  /** 'latest' follows currentVersionId; anything else is a version-id pin. */
  version: "latest" | string;
}): Promise<ResolvedSkill | null> {
  // A thread with no organization (pre-tenant-fence legacy) cannot carry a
  // per-repo skill: skill rows are org-fenced, so there is nothing safe to
  // serve. Refuse rather than guess another org's body.
  if (!organizationId) {
    console.error(
      `resolveReviewSkill: skill '${skillName}' (${repoFullName}) requested ` +
        `without an organization — org-fenced skills cannot resolve; the ` +
        `caller must SKIP this run.`,
    );
    return null;
  }

  const skill = await getRepoSkill({
    db,
    organizationId,
    repoFullName,
    skillName,
  });
  const referencedVersionId =
    version !== "latest" ? version : skill?.currentVersionId;

  // Tier 1: the referenced version.
  if (referencedVersionId) {
    const candidate = await getSkillVersion({
      db,
      organizationId,
      versionId: referencedVersionId,
    });
    if (candidate) {
      try {
        validateSkillBody(skillName, candidate.body, `version ${candidate.id}`);
        return {
          body: candidate.body,
          contentSha: candidate.contentSha,
          source: "db-version",
          versionId: candidate.id,
        };
      } catch (err) {
        console.error(
          `resolveReviewSkill: skill '${skillName}' (${repoFullName}) version ` +
            `${candidate.id} failed validation, falling back:`,
          err,
        );
      }
    } else {
      console.error(
        `resolveReviewSkill: skill '${skillName}' (${repoFullName}) references ` +
          `missing version ${referencedVersionId}, falling back.`,
      );
    }
  }

  // Tier 2: last known good — only ever points at a body that produced a
  // healthy run, but re-validate anyway (never dispatch contract-less).
  if (skill?.lastKnownGoodVersionId) {
    const lkg = await getSkillVersion({
      db,
      organizationId,
      versionId: skill.lastKnownGoodVersionId,
    });
    if (lkg) {
      try {
        validateSkillBody(skillName, lkg.body, `last-known-good ${lkg.id}`);
        console.warn(
          `resolveReviewSkill: skill '${skillName}' (${repoFullName}) served ` +
            `last-known-good version ${lkg.id}.`,
        );
        return {
          body: lkg.body,
          contentSha: lkg.contentSha,
          source: "db-version",
          versionId: lkg.id,
        };
      } catch (err) {
        console.error(
          `resolveReviewSkill: last-known-good ${lkg.id} for skill ` +
            `'${skillName}' (${repoFullName}) failed validation too:`,
          err,
        );
      }
    }
  }

  // Tier 3: the oldest seeded version — the DB record of the shipped default,
  // pushed from the tracked in-repo file at onboarding. Re-validated like
  // every tier: a seed that no longer passes its validator must not dispatch.
  const seed = await getOldestSeedVersion({
    db,
    organizationId,
    repoFullName,
    skillName,
  });
  if (seed) {
    try {
      validateSkillBody(skillName, seed.body, `seed version ${seed.id}`);
      console.warn(
        `resolveReviewSkill: skill '${skillName}' (${repoFullName}) resolved ` +
          `to seed version ${seed.id} (no usable current/last-known-good).`,
      );
      return {
        body: seed.body,
        contentSha: seed.contentSha,
        source: "seed-default",
        versionId: seed.id,
      };
    } catch (err) {
      console.error(
        `resolveReviewSkill: seed version ${seed.id} for skill ` +
          `'${skillName}' (${repoFullName}) failed validation too:`,
        err,
      );
    }
  }

  console.error(
    `resolveReviewSkill: skill '${skillName}' (${repoFullName}) has no usable ` +
      `version at any tier — the caller must SKIP this run.`,
  );
  return null;
}
