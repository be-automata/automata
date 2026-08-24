import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getTenantContextOrNull } from "@/lib/auth-server";
import { isOrgAdmin } from "@/lib/org-role";
import {
  getRepoReviewSetting,
  upsertRepoReviewSetting,
  isSupersedePolicy,
  ORG_DEFAULT_REPO_SENTINEL,
  SUPERSEDE_POLICIES,
} from "@terragon/shared/model/repo-review-settings";
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
  updatedAt: Date;
}) {
  return {
    supersedePolicy: row.supersedePolicy,
    recheckOnComplete: row.recheckOnComplete,
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
    expectedUpdatedAt?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const patch: {
    supersedePolicy?: string | null;
    recheckOnComplete?: boolean;
  } = {};
  if (body.supersedePolicy !== undefined) {
    if (
      body.supersedePolicy !== null &&
      !(
        typeof body.supersedePolicy === "string" &&
        isSupersedePolicy(body.supersedePolicy)
      )
    ) {
      return NextResponse.json(
        {
          error: `supersedePolicy must be null or one of ${SUPERSEDE_POLICIES.join(", ")}`,
        },
        { status: 400 },
      );
    }
    patch.supersedePolicy = body.supersedePolicy;
  }
  if (body.recheckOnComplete !== undefined) {
    if (typeof body.recheckOnComplete !== "boolean") {
      return NextResponse.json(
        { error: "recheckOnComplete must be a boolean" },
        { status: 400 },
      );
    }
    patch.recheckOnComplete = body.recheckOnComplete;
  }
  if (
    patch.supersedePolicy === undefined &&
    patch.recheckOnComplete === undefined
  ) {
    return NextResponse.json(
      { error: "provide supersedePolicy and/or recheckOnComplete" },
      { status: 400 },
    );
  }

  // Optimistic concurrency: two admins editing at once must never silently
  // last-write-win.
  if (body.expectedUpdatedAt !== undefined) {
    const existing = await getRepoReviewSetting({
      db,
      organizationId: ctx.organizationId,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
    });
    const current = existing?.updatedAt?.toISOString() ?? null;
    if (current !== null && current !== body.expectedUpdatedAt) {
      return NextResponse.json(
        { error: "conflict", currentUpdatedAt: current },
        { status: 409 },
      );
    }
  }

  const row = await upsertRepoReviewSetting({
    db,
    organizationId: ctx.organizationId,
    repoFullName: ORG_DEFAULT_REPO_SENTINEL,
    patch,
    updatedByUserId: ctx.userId,
  });
  getPostHogServer().capture({
    distinctId: ctx.userId,
    event: "supersede_policy_default_set",
    properties: {
      organizationId: ctx.organizationId,
      supersedePolicy: row.supersedePolicy,
      recheckOnComplete: row.recheckOnComplete,
    },
  });
  return NextResponse.json({ setting: toDto(row) });
}
