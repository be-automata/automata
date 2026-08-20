import type { DB } from "@terragon/shared/db";
import {
  getRepoSkill,
  getSkillVersion,
  listRecentSkillVersionsWithBodies,
} from "@terragon/shared/model/repo-skills";
import { stripFrontmatter, validateSkillBody } from "./review-skill";
import { computeContentSha } from "@terragon/shared/model/repo-skills";

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
 * in-repo skill files reach the DB only through validator-enforced write
 * surfaces (deploy/skill-push.ts today; the seed script once the #54 C3
 * cutover lands).
 *
 * Fallback chain — a body that fails its skill's validator is NEVER dispatched:
 *   0. the repo-file override (`.automata/skills/<skillName>.md` on the repo's
 *      DEFAULT branch, when the caller injects `fetchRepoOverride`) — editing
 *      a skill from the terminal is plain `git commit` (#54 C5)
 *   1. the referenced version (currentVersionId for 'latest', or the pin)
 *   2. lastKnownGoodVersionId (promoted only after a demonstrably healthy run)
 *   3. the newest HISTORICAL version that still passes validation. Every
 *      version row was written through a validator-enforced surface (API
 *      route, dashboard action, skill-push), so any historical body is
 *      org-approved text — the most recent valid one is the best stand-in for a
 *      broken current. Reachable for EVERY skill that has ever had a version,
 *      regardless of which surface created it. A skill with no usable version
 *      at all resolves to null and the caller skips thread creation with a
 *      loud log, rather than dispatch an instruction nobody in the org ever
 *      approved.
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
  source: "repo-file" | "db-version" | "fallback-version";
  /**
   * The repo_skill_versions row id. Present for every DB tier; absent for a
   * repo-file override, which has no row — its provenance is the contentSha
   * plus the repo's own git history.
   */
  versionId?: string;
};

/**
 * How far tier 3 walks back through history looking for a valid body. The
 * walk exists only for the disaster path (broken current, nothing promoted);
 * a skill whose last 20 versions are ALL invalid has no business dispatching.
 */
const FALLBACK_HISTORY_LIMIT = 20;

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
  fetchRepoOverride,
}: {
  db: DB;
  organizationId: string | null | undefined;
  repoFullName: string;
  skillName: string;
  /** 'latest' follows currentVersionId; anything else is a version-id pin. */
  version: "latest" | string;
  /**
   * Optional tier 0 (#54 C5): fetch the repo-file override
   * (`.automata/skills/<skillName>.md` from the repo's DEFAULT branch — see
   * fetchRepoSkillOverride's pinned invariant). Injected as a thunk so this
   * module stays octokit-free and the tier is trivially testable.
   */
  fetchRepoOverride?: () => Promise<string | null>;
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

  // Tier 0: repo-file override — the repo's own committed skill wins over
  // every DB tier. Validated like everything else; a broken or absent file
  // falls through silently (absent) or loudly (broken) to the DB tiers.
  if (fetchRepoOverride) {
    const raw = await fetchRepoOverride();
    if (raw !== null) {
      const body = stripFrontmatter(raw);
      try {
        validateSkillBody(skillName, body, `repo-file override`);
        console.warn(
          `resolveReviewSkill: skill '${skillName}' (${repoFullName}) served ` +
            `the repo-file override (.automata/skills/${skillName}.md).`,
        );
        return {
          body,
          contentSha: computeContentSha(body),
          source: "repo-file",
        };
      } catch (err) {
        console.error(
          `resolveReviewSkill: repo-file override for skill '${skillName}' ` +
            `(${repoFullName}) failed validation — falling through to DB tiers:`,
          err,
        );
      }
    }
  }

  /**
   * Fetch one version by id and serve it iff it passes the skill's validator.
   * `serveWarning` marks the fallback tiers: serving anything but the
   * referenced version is logged loudly.
   */
  async function tryVersionId(
    versionId: string,
    label: string,
    serveWarning?: string,
  ): Promise<ResolvedSkill | null> {
    const candidate = await getSkillVersion({
      db,
      organizationId: organizationId!,
      versionId,
    });
    if (!candidate) {
      console.error(
        `resolveReviewSkill: skill '${skillName}' (${repoFullName}) ` +
          `references missing ${label} ${versionId}, falling back.`,
      );
      return null;
    }
    try {
      validateSkillBody(skillName, candidate.body, `${label} ${candidate.id}`);
    } catch (err) {
      console.error(
        `resolveReviewSkill: skill '${skillName}' (${repoFullName}) ${label} ` +
          `${candidate.id} failed validation, falling back:`,
        err,
      );
      return null;
    }
    if (serveWarning) console.warn(serveWarning);
    return {
      body: candidate.body,
      contentSha: candidate.contentSha,
      source: "db-version",
      versionId: candidate.id,
    };
  }

  // Tier 1: the referenced version. A pin resolves directly — the skill row
  // is only needed by the fallback tiers, so it is fetched lazily.
  let skill =
    version === "latest"
      ? await getRepoSkill({ db, organizationId, repoFullName, skillName })
      : undefined;
  const referencedVersionId =
    version !== "latest" ? version : skill?.currentVersionId;
  if (referencedVersionId) {
    const served = await tryVersionId(referencedVersionId, "version");
    if (served) return served;
  }
  if (version !== "latest") {
    skill = await getRepoSkill({ db, organizationId, repoFullName, skillName });
  }

  // No skill row means no versions exist (they hang off it) — skip the
  // fallback queries that are provably empty.
  if (!skill) {
    console.error(
      `resolveReviewSkill: skill '${skillName}' (${repoFullName}) is not ` +
        `configured for this repo — the caller must SKIP this run.`,
    );
    return null;
  }

  // Tier 2: last known good — only ever points at a body that produced a
  // healthy run, but re-validate anyway (never dispatch contract-less).
  if (skill.lastKnownGoodVersionId) {
    const served = await tryVersionId(
      skill.lastKnownGoodVersionId,
      "last-known-good",
      `resolveReviewSkill: skill '${skillName}' (${repoFullName}) served ` +
        `last-known-good version ${skill.lastKnownGoodVersionId}.`,
    );
    if (served) return served;
  }

  // Tier 3: walk history, newest first, for any version that still passes
  // validation. Rows already tried above just fail validation again and fall
  // through — no bookkeeping needed.
  const history = await listRecentSkillVersionsWithBodies({
    db,
    organizationId,
    repoFullName,
    skillName,
    limit: FALLBACK_HISTORY_LIMIT,
  });
  for (const candidate of history) {
    try {
      validateSkillBody(
        skillName,
        candidate.body,
        `fallback version ${candidate.id}`,
      );
    } catch {
      // Keep walking — the loud per-tier logs above already cover the
      // current/LKG failures; an invalid mid-history row needs no alarm.
      continue;
    }
    console.warn(
      `resolveReviewSkill: skill '${skillName}' (${repoFullName}) resolved ` +
        `to historical version ${candidate.id} (${candidate.source}, ` +
        `${candidate.createdAt.toISOString()}) — no usable ` +
        `current/last-known-good.`,
    );
    return {
      body: candidate.body,
      contentSha: candidate.contentSha,
      source: "fallback-version",
      versionId: candidate.id,
    };
  }

  console.error(
    `resolveReviewSkill: skill '${skillName}' (${repoFullName}) has no usable ` +
      `version at any tier — the caller must SKIP this run.`,
  );
  return null;
}
