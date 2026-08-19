import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getTenantContextOrNull } from "@/lib/auth-server";
import {
  createRepoSkillVersion,
  getRepoSkill,
  getSkillVersion,
  listSkillVersions,
} from "@terragon/shared/model/repo-skills";
import { validateSkillBody } from "@/server-lib/review/review-skill";
import { getPostHogServer } from "@/lib/posthog-server";

/**
 * GET/PUT /api/repo-skills/[owner]/[repo]/[skill]
 *
 * The API edit surface for live repo skills (issue #54 C4). GET returns the
 * current version (body + provenance) and the version-history metadata; PUT
 * appends a version and moves the live pointer — the next automation run picks
 * it up with no seed script and no redeploy (the resolver reads Neon live).
 *
 * Fencing mirrors /api/review-settings (owner decision D4: any org member):
 * every read and write is scoped to the session's active organization, so one
 * org can never read or write another's skill. PUT validates with THE shared
 * per-skill registry (`validateSkillBody`, review-skill.ts) — the same rules
 * the resolver applies at dispatch — and rejects a failing body with 422
 * BEFORE any write, so a saved version can never be one the resolver would
 * refuse. `source: "api"` marks provenance; the dashboard writes through
 * server actions with `source: "dashboard"` instead.
 */

function repoFromParams(owner: string, repo: string): string {
  return `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`;
}

export async function GET(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ owner: string; repo: string; skill: string }> },
): Promise<NextResponse> {
  const ctx = await getTenantContextOrNull();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ctx.organizationId) {
    return NextResponse.json(
      { error: "No active organization" },
      { status: 400 },
    );
  }

  const { owner, repo, skill: skillParam } = await params;
  const repoFullName = repoFromParams(owner, repo);
  const skillName = decodeURIComponent(skillParam);

  const skill = await getRepoSkill({
    db,
    organizationId: ctx.organizationId,
    repoFullName,
    skillName,
  });
  if (!skill) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }

  const [current, versions] = await Promise.all([
    skill.currentVersionId
      ? getSkillVersion({
          db,
          organizationId: ctx.organizationId,
          versionId: skill.currentVersionId,
        })
      : Promise.resolve(undefined),
    listSkillVersions({
      db,
      organizationId: ctx.organizationId,
      repoFullName,
      skillName,
    }),
  ]);

  return NextResponse.json({
    skill: {
      repoFullName: skill.repoFullName,
      skillName: skill.skillName,
      // The full body ONLY for the current version; history is metadata-only
      // (bodies are multi-KB — fetch one on demand, not all on every read).
      current: current
        ? {
            versionId: current.id,
            body: current.body,
            contentSha: current.contentSha,
            source: current.source,
            createdAt: current.createdAt,
          }
        : null,
      versions: versions.map((v) => ({
        id: v.id,
        contentSha: v.contentSha,
        source: v.source,
        createdByUserId: v.createdByUserId,
        createdAt: v.createdAt,
      })),
    },
  });
}

export async function PUT(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ owner: string; repo: string; skill: string }> },
): Promise<NextResponse> {
  const ctx = await getTenantContextOrNull();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ctx.organizationId) {
    return NextResponse.json(
      { error: "No active organization" },
      { status: 400 },
    );
  }

  let payload: { body?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (typeof payload.body !== "string") {
    return NextResponse.json(
      { error: "body must be a string" },
      { status: 400 },
    );
  }

  const { owner, repo, skill: skillParam } = await params;
  const repoFullName = repoFromParams(owner, repo);
  const skillName = decodeURIComponent(skillParam);

  // Write-boundary contract check — the SAME registry the resolver uses at
  // dispatch. 422 (not 400): the request is well-formed; the CONTENT fails the
  // skill's semantic contract. The validator's message names what's missing.
  try {
    validateSkillBody(skillName, payload.body, "API PUT");
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 422 },
    );
  }

  const { skill, version } = await createRepoSkillVersion({
    db,
    organizationId: ctx.organizationId,
    repoFullName,
    skillName,
    body: payload.body,
    source: "api",
    createdByUserId: ctx.userId,
  });

  // Audit trail (who/what/when) alongside the version row's own provenance.
  // Never the body — sha + ids are enough to trace, and skill text can be big.
  getPostHogServer().capture({
    distinctId: ctx.userId,
    event: "repo_skill_version_created",
    properties: {
      organizationId: ctx.organizationId,
      repoFullName: skill.repoFullName,
      skillName: skill.skillName,
      versionId: version.id,
      contentSha: version.contentSha,
      source: "api",
    },
  });

  return NextResponse.json({
    version: {
      versionId: version.id,
      contentSha: version.contentSha,
      source: version.source,
      createdAt: version.createdAt,
    },
  });
}
