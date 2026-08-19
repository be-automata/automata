import type { DB } from "@terragon/shared/db";
import {
  computeContentSha,
  getRepoSkill,
  getSkillVersion,
} from "@terragon/shared/model/repo-skills";
import { loadReviewSkillBody, validateSkillBody } from "./review-skill";

/**
 * Resolve the ONE skill-body snapshot for a single automation run — the live
 * counterpart of the seed-time inlining (issue #54, twin of
 * resolve-approve-floor). Called at thread-creation time in runAutomation, so
 * an accepted skill edit is picked up by the NEXT run with no seed script and
 * no redeploy; in-flight threads are untouched by construction.
 *
 * Fallback chain — a body that fails its skill's validator is NEVER dispatched:
 *   1. the referenced version (currentVersionId for 'latest', or the pin)
 *   2. lastKnownGoodVersionId (promoted only after a demonstrably healthy run)
 *   3. the tracked default — github-ops ONLY (deploy/skills/github-ops/SKILL.md
 *      via loadReviewSkillBody). Other skills have no tracked default: resolve
 *      to null and let the caller skip thread creation with a loud log, rather
 *      than dispatch an empty instruction.
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
  source: "db-version" | "tracked-default";
  /** The repo_skill_versions row id, when a DB version was served. */
  versionId?: string;
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
  // per-repo skill — it resolves straight to the tracked default, never
  // another org's body.
  if (organizationId) {
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
          validateSkillBody(
            skillName,
            candidate.body,
            `version ${candidate.id}`,
          );
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
  }

  // Tier 3: tracked default — github-ops only. The tracked SKILL.md is the
  // review methodology; other skills have no in-repo default body.
  if (skillName === "github-ops") {
    const body = loadReviewSkillBody();
    console.warn(
      `resolveReviewSkill: skill 'github-ops' (${repoFullName}) resolved to ` +
        `the tracked default (no usable DB version).`,
    );
    return {
      body,
      contentSha: computeContentSha(body),
      source: "tracked-default",
    };
  }

  console.error(
    `resolveReviewSkill: skill '${skillName}' (${repoFullName}) has no usable ` +
      `version and no tracked default — the caller must SKIP this run.`,
  );
  return null;
}
