"use server";

import { db } from "@/lib/db";
import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import {
  createRepoSkillVersion,
  getRepoSkill,
  getSkillVersion,
  listRepoSkills,
  listSkillVersions,
  revertSkillToVersion,
  type RepoSkillVersionMeta,
} from "@terragon/shared/model/repo-skills";
import { validateSkillBody } from "@/server-lib/review/review-skill";
import { getPostHogServer } from "@/lib/posthog-server";
import { UserFacingError } from "@/lib/server-actions";

/**
 * Dashboard edit surface for live repo skills (issue #54 C4) — the server-action
 * twin of /api/repo-skills. Every action is fenced to the session's active org
 * (owner decision D4: any org member edits; `createdByUserId` + the append-only
 * version history are the audit trail). Saves run THE shared per-skill validator
 * (`validateSkillBody` — the same registry the resolver applies at dispatch)
 * BEFORE any write, so a stored version can never be one the resolver would
 * refuse and silently fall back from. `source: "dashboard"` marks provenance
 * (the API route and skill-push.ts write `"api"` instead).
 */

async function requireOrg(): Promise<string> {
  const tenant = await getTenantContextOrNull();
  if (!tenant?.organizationId) {
    throw new UserFacingError("No active organization");
  }
  return tenant.organizationId;
}

export type RepoSkillListItem = {
  repoFullName: string;
  skillName: string;
  current: {
    versionId: string;
    contentSha: string;
    source: string;
    createdAt: Date;
  } | null;
};

export const listRepoSkillsAction = userOnlyAction(
  async function listRepoSkillsAction(
    _userId: string,
  ): Promise<RepoSkillListItem[]> {
    const organizationId = await requireOrg();
    const skills = await listRepoSkills({ db, organizationId });
    return Promise.all(
      skills.map(async (skill) => {
        const current = skill.currentVersionId
          ? await getSkillVersion({
              db,
              organizationId,
              versionId: skill.currentVersionId,
            })
          : undefined;
        return {
          repoFullName: skill.repoFullName,
          skillName: skill.skillName,
          current: current
            ? {
                versionId: current.id,
                contentSha: current.contentSha,
                source: current.source,
                createdAt: current.createdAt,
              }
            : null,
        };
      }),
    );
  },
  { defaultErrorMessage: "Failed to load skills" },
);

export type RepoSkillDetail = {
  repoFullName: string;
  skillName: string;
  current: {
    versionId: string;
    body: string;
    contentSha: string;
    source: string;
    createdAt: Date;
  } | null;
  versions: RepoSkillVersionMeta[];
};

export const getRepoSkillDetailAction = userOnlyAction(
  async function getRepoSkillDetailAction(
    _userId: string,
    { repoFullName, skillName }: { repoFullName: string; skillName: string },
  ): Promise<RepoSkillDetail> {
    const organizationId = await requireOrg();
    const skill = await getRepoSkill({
      db,
      organizationId,
      repoFullName,
      skillName,
    });
    if (!skill) {
      throw new UserFacingError("Skill not found");
    }
    const [current, versions] = await Promise.all([
      skill.currentVersionId
        ? getSkillVersion({
            db,
            organizationId,
            versionId: skill.currentVersionId,
          })
        : Promise.resolve(undefined),
      listSkillVersions({ db, organizationId, repoFullName, skillName }),
    ]);
    return {
      repoFullName: skill.repoFullName,
      skillName: skill.skillName,
      current: current
        ? {
            versionId: current.id,
            body: current.body,
            contentSha: current.contentSha,
            source: current.source,
            createdAt: current.createdAt,
          }
        : null,
      versions,
    };
  },
  { defaultErrorMessage: "Failed to load skill" },
);

export const saveRepoSkillAction = userOnlyAction(
  async function saveRepoSkillAction(
    userId: string,
    {
      repoFullName,
      skillName,
      body,
    }: { repoFullName: string; skillName: string; body: string },
  ): Promise<{ versionId: string; contentSha: string }> {
    const organizationId = await requireOrg();
    // Write-boundary contract check — surface the validator's own message so
    // the editor shows WHAT is missing (e.g. the fenced-json verdict contract).
    try {
      validateSkillBody(skillName, body, "dashboard editor");
    } catch (err) {
      throw new UserFacingError(
        err instanceof Error ? err.message : String(err),
      );
    }
    const { version } = await createRepoSkillVersion({
      db,
      organizationId,
      repoFullName,
      skillName,
      body,
      source: "dashboard",
      createdByUserId: userId,
    });
    // Audit event: sha + ids only, never the (multi-KB) body.
    getPostHogServer().capture({
      distinctId: userId,
      event: "repo_skill_version_created",
      properties: {
        organizationId,
        repoFullName,
        skillName,
        versionId: version.id,
        contentSha: version.contentSha,
        source: "dashboard",
      },
    });
    return { versionId: version.id, contentSha: version.contentSha };
  },
  { defaultErrorMessage: "Failed to save skill" },
);

export const revertRepoSkillAction = userOnlyAction(
  async function revertRepoSkillAction(
    userId: string,
    {
      repoFullName,
      skillName,
      versionId,
    }: { repoFullName: string; skillName: string; versionId: string },
  ): Promise<{ currentVersionId: string }> {
    const organizationId = await requireOrg();
    const reverted = await revertSkillToVersion({
      db,
      organizationId,
      repoFullName,
      skillName,
      versionId,
    });
    // undefined = the version does not belong to this (org, repo, skill) —
    // the model's fencing already refused; report it, change nothing.
    if (!reverted?.currentVersionId) {
      throw new UserFacingError("Version not found for this skill");
    }
    getPostHogServer().capture({
      distinctId: userId,
      event: "repo_skill_reverted",
      properties: { organizationId, repoFullName, skillName, versionId },
    });
    return { currentVersionId: reverted.currentVersionId };
  },
  { defaultErrorMessage: "Failed to revert skill" },
);
