import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getTenantContextOrNull } from "@/lib/auth-server";
import { isOrgAdmin } from "@/lib/org-role";
import {
  getRepoReviewSetting,
  upsertRepoReviewSetting,
  ORG_DEFAULT_REPO_SENTINEL,
  RepoReviewSettingConflictError,
} from "@terragon/shared/model/repo-review-settings";
import { parseSupersedePatch } from "../supersede-route-shared";
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
 */

function toDto(row: {
  supersedePolicy: string | null;
  recheckOnComplete: boolean;
  reviewDraftPrs: boolean;
  updatedAt: Date;
}) {
  return {
    supersedePolicy: row.supersedePolicy,
    recheckOnComplete: row.recheckOnComplete,
    reviewDraftPrs: row.reviewDraftPrs,
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
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const supersede = parseSupersedePatch(body);
  if ("errorResponse" in supersede) return supersede.errorResponse;
  const patch: typeof supersede.patch & { reviewDraftPrs?: boolean } =
    supersede.patch;
  // Same local validation shape as the per-repo route — the shared parser
  // stays supersede-only on purpose (that route validates this field itself).
  if (body.reviewDraftPrs !== undefined) {
    if (typeof body.reviewDraftPrs !== "boolean") {
      return NextResponse.json(
        { error: "reviewDraftPrs must be a boolean" },
        { status: 400 },
      );
    }
    patch.reviewDraftPrs = body.reviewDraftPrs;
  }
  if (
    patch.supersedePolicy === undefined &&
    patch.recheckOnComplete === undefined &&
    patch.reviewDraftPrs === undefined
  ) {
    return NextResponse.json(
      {
        error:
          "provide supersedePolicy, recheckOnComplete and/or reviewDraftPrs",
      },
      { status: 400 },
    );
  }

  // Optimistic concurrency, enforced by the DATABASE in the write itself
  // (ON CONFLICT … DO UPDATE … WHERE updated_at = expected): two admins who
  // read the same version can never both win — the loser gets a 409, never
  // a silent last-write-wins.
  // `expectedUpdatedAt: null` is the FIRST-WRITE fence: the sentinel row is
  // created lazily, and two org admins racing to set the very first default
  // must not both get 200. ROW-level absence, not the per-family fence: this
  // route's GET returns the whole sentinel row, so the client sends null only
  // when the row is truly absent — and a family fence would let a draft-only
  // first write slip past a concurrent draft write (supersede_policy stays
  // NULL on such rows, hollowing the fence for both families).
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
    row = await upsertRepoReviewSetting({
      db,
      organizationId: ctx.organizationId,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
      patch,
      updatedByUserId: ctx.userId,
      expectedUpdatedAt,
      expectRowAbsent,
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
      changed: Object.keys(patch),
    },
  });
  return NextResponse.json({ setting: toDto(row) });
}
