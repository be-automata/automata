import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getTenantContextOrNull } from "@/lib/auth-server";
import {
  getRepoReviewSetting,
  upsertRepoReviewSetting,
  removeRepoReviewSetting,
  isSupersedePolicy,
  SUPERSEDE_POLICIES,
} from "@terragon/shared/model/repo-review-settings";
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
 * the family): an ORG admin may write any repo's override; anyone else must
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
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const patch: {
    blockTolerance?: string;
    reviewDraftPrs?: boolean;
    supersedePolicy?: string | null;
    recheckOnComplete?: boolean;
  } = {};
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
  if (body.reviewDraftPrs !== undefined) {
    if (typeof body.reviewDraftPrs !== "boolean") {
      return NextResponse.json(
        { error: "reviewDraftPrs must be a boolean" },
        { status: 400 },
      );
    }
    patch.reviewDraftPrs = body.reviewDraftPrs;
  }
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
    patch.blockTolerance === undefined &&
    patch.reviewDraftPrs === undefined &&
    patch.supersedePolicy === undefined &&
    patch.recheckOnComplete === undefined
  ) {
    return NextResponse.json(
      {
        error:
          "provide blockTolerance, reviewDraftPrs, supersedePolicy and/or recheckOnComplete",
      },
      { status: 400 },
    );
  }

  const { owner, repo } = await params;
  const repoFullName = repoFromParams(owner, repo);

  // #125 C6: two-level permission — previously ANY member with an active org
  // could write. Applies to all three settings of the family.
  const denied = await requireRepoWriteAccess({
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    repoFullName,
  });
  if (denied) return denied;

  // Optimistic concurrency: a PUT carrying a stale expectedUpdatedAt gets a
  // 409 — never a silent last-write-wins between two admins.
  if (body.expectedUpdatedAt !== undefined) {
    const existing = await getRepoReviewSetting({
      db,
      organizationId: ctx.organizationId,
      repoFullName,
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
    repoFullName,
    patch,
    updatedByUserId: ctx.userId,
  });

  getPostHogServer().capture({
    distinctId: ctx.userId,
    event: "review_tolerance_set",
    properties: {
      organizationId: ctx.organizationId,
      repoFullName: row.repoFullName,
      blockTolerance: row.blockTolerance,
      reviewDraftPrs: row.reviewDraftPrs,
    },
  });

  return NextResponse.json({
    setting: {
      repoFullName: row.repoFullName,
      blockTolerance: row.blockTolerance,
      reviewDraftPrs: row.reviewDraftPrs,
      supersedePolicy: row.supersedePolicy,
      recheckOnComplete: row.recheckOnComplete,
      updatedAt: row.updatedAt,
    },
  });
}

export async function DELETE(
  _request: NextRequest,
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

  const removed = await removeRepoReviewSetting({
    db,
    organizationId: ctx.organizationId,
    repoFullName,
  });

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
