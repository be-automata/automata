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
 * Two fields are writable: `blockTolerance` and `cellWorkflowWrite` (the
 * per-org opt-in letting remote cells push to `.github/workflows`, #609; NULL
 * and false both mean off). `trustedAuthorThreshold` (the other axis on
 * `organizationReviewSettings`) is NOT exposed here — its selector/route
 * vocabulary belongs to #72 (org trust-threshold floor; merged —
 * `resolveComposedFloorPolicy` lives in
 * `packages/review/src/settings/review-floor-resolver.ts`) and #73, which
 * wires that resolver into `apps/www/src/server-lib/review/resolve-approve-floor.ts`
 * so verdicts actually read the org row. Do not add a `trustedAuthorThreshold`
 * field to this route ahead of that wiring landing.
 *
 * GET is open to any org member (a floor is something every member should be
 * able to see). PUT is gated to org admins/owners via {@link isOrgAdmin} —
 * a floor is org governance, not a per-member setting.
 *
 * NOTE: this floor is stored but not yet composed into review verdicts.
 * Enforcement at review time ships when #73 wires the composed resolver in.
 */

function toDto(row: {
  blockTolerance: string | null;
  cellWorkflowWrite: boolean | null;
  updatedAt: Date;
}) {
  return {
    blockTolerance: row.blockTolerance as BlockTolerance | null,
    // Raw nullable, like blockTolerance: NULL means "never set" (resolves off).
    cellWorkflowWrite: row.cellWorkflowWrite,
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

  let body: { blockTolerance?: unknown; cellWorkflowWrite?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  if (
    body.blockTolerance === undefined &&
    body.cellWorkflowWrite === undefined
  ) {
    return NextResponse.json(
      { error: "blockTolerance or cellWorkflowWrite is required" },
      { status: 400 },
    );
  }

  // null clears the floor (see upsertOrganizationReviewSetting doc). Any
  // other value must be a valid BlockTolerance.
  if (
    body.blockTolerance !== undefined &&
    body.blockTolerance !== null &&
    !isBlockTolerance(body.blockTolerance)
  ) {
    return NextResponse.json(
      {
        error: `blockTolerance must be null or one of ${BLOCK_TOLERANCES.join(", ")}`,
      },
      { status: 400 },
    );
  }

  if (
    body.cellWorkflowWrite !== undefined &&
    body.cellWorkflowWrite !== null &&
    typeof body.cellWorkflowWrite !== "boolean"
  ) {
    return NextResponse.json(
      { error: "cellWorkflowWrite must be a boolean or null" },
      { status: 400 },
    );
  }

  // Clear-via-null, never row delete: a delete would destroy the other axes
  // on the same row. An absent key is not written.
  // `removeOrganizationReviewSetting` must never be called from this route.
  const patch: {
    blockTolerance?: string | null;
    cellWorkflowWrite?: boolean | null;
  } = {};
  if (body.blockTolerance !== undefined) {
    patch.blockTolerance = body.blockTolerance;
  }
  if (body.cellWorkflowWrite !== undefined) {
    patch.cellWorkflowWrite = body.cellWorkflowWrite;
  }

  const row = await upsertOrganizationReviewSetting({
    db,
    organizationId: ctx.organizationId,
    patch,
    updatedByUserId: ctx.userId,
  });

  const posthog = getPostHogServer();
  if (body.blockTolerance !== undefined) {
    posthog.capture({
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
  }
  if (body.cellWorkflowWrite !== undefined) {
    posthog.capture({
      distinctId: ctx.userId,
      event: "org_cell_workflow_write_updated",
      properties: {
        organizationId: ctx.organizationId,
        cellWorkflowWrite: row.cellWorkflowWrite,
      },
    });
  }

  return NextResponse.json({ setting: toDto(row) });
}
