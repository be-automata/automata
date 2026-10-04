import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { DB } from "@terragon/shared/db";
import { getTenantContextOrNull } from "@/lib/auth-server";
import {
  upsertRepoReviewSetting,
  removeRepoReviewSetting,
  RepoReviewSettingConflictError,
  getRepoReviewSetting,
} from "@terragon/shared/model/repo-review-settings";
import {
  parseReviewAgentPatch,
  parseReviewDraftPrs,
  parseSelfHealPatch,
  parseSupersedePatch,
  recordSelfHealSettingsChange,
  toRepoReviewSettingDto,
} from "../../review-settings-route-shared";
import {
  REVIEW_AGENT_FIELDS,
  type ReviewAgentField,
  type ReviewAgentFieldsPatch,
} from "@terragon/shared/model/review-agent-settings";
import {
  SELF_HEAL_FIELDS,
  type SelfHealField,
  type SelfHealFieldsPatch,
} from "@terragon/shared/model/self-heal-settings";
import { isOrgAdmin } from "@/lib/org-role";
import { checkRepoAdmin } from "@/lib/repo-admin";
import {
  BLOCK_TOLERANCES,
  isBlockTolerance,
} from "@terragon/review/severity-policy";
import { getPostHogServer } from "@/lib/posthog-server";

/**
 * PUT/DELETE /api/review-settings/[owner]/[repo]
 *
 * Set or clear a per-repo REQUESTED_CHANGES tolerance (ADR-036 review floor) for
 * the caller's active organization. Every mutation is fenced to the session's
 * active org — one org can never write another's override — and validated
 * against {@link BLOCK_TOLERANCES}. A PostHog event per mutation is the audit
 * trail (who/what/when), alongside the row's own `updatedByUserId`/`updatedAt`.
 */

function repoFromParams(owner: string, repo: string): string {
  return `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`;
}

/**
 * #125 C6 two-level permission for repo-level writes (all three settings of
 * the family, plus the phase 4 review-agent family): an ORG admin may write any repo's override; anyone else must
 * administer THAT repo on GitHub (caller's own token; fail-closed). Returns
 * a NextResponse to send, or null when allowed.
 */
async function requireRepoWriteAccess({
  userId,
  organizationId,
  repoFullName,
}: {
  userId: string;
  organizationId: string;
  repoFullName: string;
}): Promise<NextResponse | null> {
  if (await isOrgAdmin({ db, organizationId, userId })) return null;
  const repoCheck = await checkRepoAdmin({ userId, repoFullName });
  if (repoCheck === "admin") return null;
  if (repoCheck === "lookup-failed") {
    return NextResponse.json(
      {
        error:
          "We couldn't verify your permission on GitHub for this repository. Try again in a moment.",
      },
      { status: 403 },
    );
  }
  return NextResponse.json(
    {
      error:
        "Only organization admins or admins of this repository can change its review settings.",
    },
    { status: 403 },
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; repo: string }> },
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

  let body: {
    blockTolerance?: unknown;
    reviewDraftPrs?: unknown;
    supersedePolicy?: unknown;
    recheckOnComplete?: unknown;
    expectedUpdatedAt?: unknown;
  } & Partial<Record<ReviewAgentField | SelfHealField, unknown>>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const patch: {
    blockTolerance?: string;
    reviewDraftPrs?: boolean | null;
    supersedePolicy?: string | null;
    recheckOnComplete?: boolean;
  } & ReviewAgentFieldsPatch &
    SelfHealFieldsPatch = {};
  if (body.blockTolerance !== undefined) {
    if (!isBlockTolerance(body.blockTolerance)) {
      return NextResponse.json(
        {
          error: `blockTolerance must be one of ${BLOCK_TOLERANCES.join(", ")}`,
        },
        { status: 400 },
      );
    }
    patch.blockTolerance = body.blockTolerance;
  }
  const drafts = parseReviewDraftPrs(body);
  if ("errorResponse" in drafts) return drafts.errorResponse;
  if (drafts.reviewDraftPrs !== undefined)
    patch.reviewDraftPrs = drafts.reviewDraftPrs;
  const supersede = parseSupersedePatch(body);
  if ("errorResponse" in supersede) return supersede.errorResponse;
  Object.assign(patch, supersede.patch);
  const reviewAgent = parseReviewAgentPatch(body);
  if ("errorResponse" in reviewAgent) return reviewAgent.errorResponse;
  Object.assign(patch, reviewAgent.patch);
  const selfHeal = parseSelfHealPatch(body, { isOrgDefaultRow: false });
  if ("errorResponse" in selfHeal) return selfHeal.errorResponse;
  Object.assign(patch, selfHeal.patch);
  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      {
        error:
          "provide blockTolerance, reviewDraftPrs, supersedePolicy, recheckOnComplete and/or a review-agent field or self-heal field",
      },
      { status: 400 },
    );
  }

  const { owner, repo } = await params;
  const repoFullName = repoFromParams(owner, repo);

  // #125 C6: two-level permission — previously ANY member with an active org
  // could write. Applies to all three settings of the family and to the
  // phase 4 review-agent family.
  const denied = await requireRepoWriteAccess({
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    repoFullName,
  });
  if (denied) return denied;

  // Optimistic concurrency, enforced by the DATABASE in the write itself
  // (ON CONFLICT … DO UPDATE … WHERE updated_at = expected): two admins who
  // read the same version can never both win — the loser gets a 409, never
  // a silent last-write-wins.
  // `expectedUpdatedAt: null` is the FIRST-WRITE fence: the caller read "no
  // override yet" and the write must only apply while that is still true.
  // Phase 4: a review-agent-only first write is sent only when the repo has
  // no row at all, so it takes the whole-row fence — the per-family
  // supersede fence would let a racing review-agent first write slip
  // through. Exactly one fence is ever passed.
  const firstWrite = body.expectedUpdatedAt === null;
  const reviewAgentOnly = Object.keys(patch).every(
    (key) =>
      (REVIEW_AGENT_FIELDS as readonly string[]).includes(key) ||
      (SELF_HEAL_FIELDS as readonly string[]).includes(key),
  );
  const expectRowAbsent = firstWrite && reviewAgentOnly ? true : undefined;
  const expectAbsentSupersedeOverride =
    firstWrite && !reviewAgentOnly ? true : undefined;
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
        repoFullName,
        patch,
        updatedByUserId: actorUserId,
        expectedUpdatedAt,
        expectAbsentSupersedeOverride,
        expectRowAbsent,
      });
      await recordSelfHealSettingsChange({
        db: txDb,
        organizationId,
        actorUserId,
        repoFullName: written.repoFullName,
        patch,
      });
      return written;
    });
  } catch (error) {
    if (error instanceof RepoReviewSettingConflictError) {
      const current = await getRepoReviewSetting({
        db,
        organizationId: ctx.organizationId,
        repoFullName: repoFullName,
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
    event: "review_tolerance_set",
    properties: {
      organizationId: ctx.organizationId,
      repoFullName: row.repoFullName,
      blockTolerance: row.blockTolerance,
      reviewDraftPrs: row.reviewDraftPrs,
      supersedePolicy: row.supersedePolicy,
      recheckOnComplete: row.recheckOnComplete,
      // What THIS write changed — the audit trail must show the delta, not
      // just the resulting row.
      changed: Object.keys(patch),
    },
  });

  return NextResponse.json({ setting: toRepoReviewSettingDto(row) });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; repo: string }> },
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

  const { owner, repo } = await params;
  const repoFullName = repoFromParams(owner, repo);

  const denied = await requireRepoWriteAccess({
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    repoFullName,
  });
  if (denied) return denied;

  // Optional CAS on the reset path too (?expectedUpdatedAt=<iso>).
  const expectedRaw = request.nextUrl.searchParams.get("expectedUpdatedAt");
  const expectedUpdatedAt = expectedRaw ? new Date(expectedRaw) : undefined;
  if (expectedUpdatedAt && Number.isNaN(expectedUpdatedAt.getTime())) {
    return NextResponse.json(
      { error: "expectedUpdatedAt must be an ISO timestamp" },
      { status: 400 },
    );
  }
  const { removed, conflict } = await removeRepoReviewSetting({
    db,
    organizationId: ctx.organizationId,
    repoFullName,
    expectedUpdatedAt,
  });
  if (conflict) {
    // Same 409 shape as PUT (review-settings-route-shared.ts): the client's
    // ConflictError parser reads currentUpdatedAt on every conflict.
    const current = await getRepoReviewSetting({
      db,
      organizationId: ctx.organizationId,
      repoFullName,
    });
    return NextResponse.json(
      {
        error: "conflict",
        currentUpdatedAt: current?.updatedAt?.toISOString() ?? null,
      },
      { status: 409 },
    );
  }

  getPostHogServer().capture({
    distinctId: ctx.userId,
    event: "review_tolerance_cleared",
    properties: {
      organizationId: ctx.organizationId,
      repoFullName: repoFullName.toLowerCase(),
      removed,
    },
  });

  return NextResponse.json({ removed });
}
