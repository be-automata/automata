import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { DB } from "@terragon/shared/db";
import { getTenantContextOrNull } from "@/lib/auth-server";
import { isOrgAdmin } from "@/lib/org-role";
import {
  getRepoReviewSetting,
  upsertRepoReviewSetting,
  ORG_DEFAULT_REPO_SENTINEL,
  RepoReviewSettingConflictError,
} from "@terragon/shared/model/repo-review-settings";
import {
  parseReviewAgentPatch,
  parseReviewDraftPrs,
  parseSelfHealPatch,
  parseSupersedePatch,
  recordSelfHealSettingsChange,
} from "../review-settings-route-shared";
import {
  pickReviewAgentFields,
  type ReviewAgentField,
} from "@terragon/shared/model/review-agent-settings";
import {
  pickSelfHealFields,
  type SelfHealField,
} from "@terragon/shared/model/self-heal-settings";
import type { RepoReviewSetting } from "@terragon/shared/db/types";
import { getPostHogServer } from "@/lib/posthog-server";

/**
 * GET/PUT /api/review-settings/default (#125 C6)
 *
 * The organisation's DEFAULT supersede policy — the sentinel row
 * (`repoFullName = '*'`) the dispatch resolver falls back to when a repo has
 * no override. GET is open to any member of the active org; PUT is org
 * governance and requires an org admin/owner (isOrgAdmin — the same gate as
 * the org review floor). Writes carry optimistic concurrency: a PUT with a
 * stale `expectedUpdatedAt` gets 409 {error:"conflict", currentUpdatedAt} —
 * never a silent last-write-wins between two admins.
 *
 * Phase 4: the sentinel row also carries the org-default review-agent
 * settings (mode, battery packs, run tests, command timeout, max turns);
 * null = inherit the system default. Same admin gate, same fences.
 */

function toDto(row: RepoReviewSetting) {
  return {
    supersedePolicy: row.supersedePolicy,
    recheckOnComplete: row.recheckOnComplete,
    reviewDraftPrs: row.reviewDraftPrs,
    ...pickReviewAgentFields(row),
    ...pickSelfHealFields(row),
    updatedAt: row.updatedAt,
  };
}

export async function GET(): Promise<NextResponse> {
  const ctx = await getTenantContextOrNull();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ctx.organizationId) {
    return NextResponse.json({ setting: null });
  }
  const row = await getRepoReviewSetting({
    db,
    organizationId: ctx.organizationId,
    repoFullName: ORG_DEFAULT_REPO_SENTINEL,
  });
  return NextResponse.json({ setting: row ? toDto(row) : null });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const ctx = await getTenantContextOrNull();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ctx.organizationId) {
    return NextResponse.json(
      { error: "Select an organization first — this setting belongs to one." },
      { status: 400 },
    );
  }
  if (
    !(await isOrgAdmin({
      db,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
    }))
  ) {
    return NextResponse.json(
      {
        error:
          "Only organization admins can change the org-wide review policy.",
      },
      { status: 403 },
    );
  }

  let body: {
    supersedePolicy?: unknown;
    recheckOnComplete?: unknown;
    reviewDraftPrs?: unknown;
    expectedUpdatedAt?: unknown;
  } & Partial<Record<ReviewAgentField | SelfHealField, unknown>>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const supersede = parseSupersedePatch(body);
  if ("errorResponse" in supersede) return supersede.errorResponse;
  const drafts = parseReviewDraftPrs(body);
  if ("errorResponse" in drafts) return drafts.errorResponse;
  const reviewAgent = parseReviewAgentPatch(body);
  if ("errorResponse" in reviewAgent) return reviewAgent.errorResponse;
  const selfHeal = parseSelfHealPatch(body, { isOrgDefaultRow: true });
  if ("errorResponse" in selfHeal) return selfHeal.errorResponse;
  const patch = {
    ...supersede.patch,
    ...drafts,
    ...reviewAgent.patch,
    ...selfHeal.patch,
  };
  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      {
        error:
          "provide supersedePolicy, recheckOnComplete, reviewDraftPrs and/or a review-agent field or self-heal field",
      },
      { status: 400 },
    );
  }

  // Optimistic concurrency, enforced by the DATABASE in the write itself
  // (ON CONFLICT … DO UPDATE … WHERE updated_at = expected): two admins who
  // read the same version can never both win — the loser gets a 409, never
  // a silent last-write-wins.
  // `expectedUpdatedAt: null` = ROW-level first-write fence, not the
  // per-family one: this GET returns the whole sentinel row, so null means
  // the row is truly absent. See `expectRowAbsent` on upsertRepoReviewSetting.
  const expectRowAbsent = body.expectedUpdatedAt === null;
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string"
      ? new Date(body.expectedUpdatedAt)
      : undefined;
  if (expectedUpdatedAt && Number.isNaN(expectedUpdatedAt.getTime())) {
    return NextResponse.json(
      { error: "expectedUpdatedAt must be an ISO timestamp" },
      { status: 400 },
    );
  }
  let row;
  try {
    // One transaction: the settings write and its OBS-01 actor-log row land
    // together or not at all, so an applied change (the kill switch above all)
    // is never left unattributed, and a failed log never reports a 500 for a
    // write that already took effect.
    const organizationId = ctx.organizationId;
    const actorUserId = ctx.userId;
    row = await db.transaction(async (tx) => {
      const txDb = tx as unknown as DB;
      const written = await upsertRepoReviewSetting({
        db: txDb,
        organizationId,
        repoFullName: ORG_DEFAULT_REPO_SENTINEL,
        patch,
        updatedByUserId: actorUserId,
        expectedUpdatedAt,
        expectRowAbsent,
      });
      await recordSelfHealSettingsChange({
        db: txDb,
        organizationId,
        actorUserId,
        repoFullName: ORG_DEFAULT_REPO_SENTINEL,
        patch,
      });
      return written;
    });
  } catch (error) {
    if (error instanceof RepoReviewSettingConflictError) {
      const current = await getRepoReviewSetting({
        db,
        organizationId: ctx.organizationId,
        repoFullName: ORG_DEFAULT_REPO_SENTINEL,
      });
      return NextResponse.json(
        {
          error: "conflict",
          currentUpdatedAt: current?.updatedAt?.toISOString() ?? null,
        },
        { status: 409 },
      );
    }
    throw error;
  }
  getPostHogServer().capture({
    distinctId: ctx.userId,
    event: "supersede_policy_default_set",
    properties: {
      organizationId: ctx.organizationId,
      supersedePolicy: row.supersedePolicy,
      recheckOnComplete: row.recheckOnComplete,
      reviewDraftPrs: row.reviewDraftPrs,
      ...pickReviewAgentFields(row),
      changed: Object.keys(patch),
    },
  });
  return NextResponse.json({ setting: toDto(row) });
}
