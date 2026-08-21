import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getTenantContextOrNull } from "@/lib/auth-server";
import { isOrgAdmin } from "@/lib/org-role";
import {
  getOrganizationReviewSetting,
  upsertOrganizationReviewSetting,
} from "@terragon/shared/model/organization-review-settings";
import {
  BLOCK_TOLERANCES,
  isBlockTolerance,
  type BlockTolerance,
} from "@terragon/review/severity-policy";
import { getPostHogServer } from "@/lib/posthog-server";

/**
 * GET/PUT /api/org-review-settings
 *
 * Org-wide `blockTolerance` review floor (ADR-005 §4): the loosest tolerance
 * repos in this organization may configure. Every read/write is fenced to the
 * session's ACTIVE organization — the org id is never accepted from the
 * request body, only from the session.
 *
 * `blockTolerance` ONLY. `trustedAuthorThreshold` (the other axis on
 * `organizationReviewSettings`) is NOT exposed here — its selector/route
 * vocabulary belongs to #72 (org trust-threshold floor) and #73 (resolver
 * that composes both floors into verdicts), which are unmerged as of this
 * route. Do not add a `trustedAuthorThreshold` field to this route ahead of
 * those tickets landing.
 *
 * GET is open to any org member (a floor is something every member should be
 * able to see). PUT is gated to org admins/owners via {@link isOrgAdmin} —
 * a floor is org governance, not a per-member setting.
 *
 * NOTE: this floor is stored but not yet composed into review verdicts.
 * Enforcement at review time ships with the org-floor resolver (#73).
 */

function toDto(row: { blockTolerance: string | null; updatedAt: Date }) {
  return {
    blockTolerance: row.blockTolerance as BlockTolerance | null,
    updatedAt: row.updatedAt,
  };
}

export async function GET(): Promise<NextResponse> {
  const ctx = await getTenantContextOrNull();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ctx.organizationId) {
    // No active org → nothing to scope to. Lenient, mirrors
    // /api/review-settings/route.ts.
    return NextResponse.json({ setting: null });
  }

  const row = await getOrganizationReviewSetting({
    db,
    organizationId: ctx.organizationId,
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
      { error: "No active organization" },
      { status: 400 },
    );
  }

  const admin = await isOrgAdmin({
    db,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
  });
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { blockTolerance?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  if (body.blockTolerance === undefined) {
    return NextResponse.json(
      { error: "blockTolerance is required" },
      { status: 400 },
    );
  }

  // null clears the floor (see upsertOrganizationReviewSetting doc). Any
  // other value must be a valid BlockTolerance.
  if (body.blockTolerance !== null && !isBlockTolerance(body.blockTolerance)) {
    return NextResponse.json(
      {
        error: `blockTolerance must be null or one of ${BLOCK_TOLERANCES.join(", ")}`,
      },
      { status: 400 },
    );
  }

  // Clear-via-null, never row delete: a delete would destroy the
  // `trustedAuthorThreshold` axis on the same row once #72/#73 write it.
  // `removeOrganizationReviewSetting` must never be called from this route.
  const patch: { blockTolerance: string | null } = {
    blockTolerance: body.blockTolerance,
  };

  const row = await upsertOrganizationReviewSetting({
    db,
    organizationId: ctx.organizationId,
    patch,
    updatedByUserId: ctx.userId,
  });

  getPostHogServer().capture({
    distinctId: ctx.userId,
    event:
      body.blockTolerance === null
        ? "org_review_floor_cleared"
        : "org_review_floor_set",
    properties: {
      organizationId: ctx.organizationId,
      blockTolerance: row.blockTolerance,
    },
  });

  return NextResponse.json({ setting: toDto(row) });
}
