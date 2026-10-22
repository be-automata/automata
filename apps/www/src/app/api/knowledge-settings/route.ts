import { NextRequest, NextResponse } from "next/server";

import {
  canSetKnowledgeBudget,
  getKnowledgeBudgetCeiling,
  getKnowledgeControls,
  getKnowledgeSpend,
  KnowledgeControlsConflictError,
  KnowledgeOffboardedError,
  updateKnowledgeControls,
  type KnowledgeControls,
} from "@terragon/shared/model/knowledge-controls";
import { listKnowledgeAdminActions } from "@terragon/shared/model/knowledge-admin-log";
import { getOrganizationById } from "@terragon/shared/model/organizations";

import { getTenantContextOrNull, isPlatformAdmin } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { isOrgAdmin } from "@/lib/org-role";
import { controlsToDto } from "@/server-lib/knowledge/controls-dto";
import { getPostHogServer } from "@/lib/posthog-server";

/**
 * GET/PUT /api/knowledge-settings
 *
 * Knowledge engine controls (kill switch, monthly budget) for the session's
 * ACTIVE organization. The org id comes only from the session, never from the
 * body or URL.
 *
 * GET is open to any org member. PUT: the kill switch needs an org admin; the
 * budget needs an org admin (within the platform ceiling) or a platform admin
 * (any value up to the absolute max, logged with via "platform_admin").
 */

export async function GET(): Promise<NextResponse> {
  const ctx = await getTenantContextOrNull();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ctx.organizationId) {
    return NextResponse.json({
      orgSlug: null,
      controls: null,
      spend: null,
      actions: [],
      viewer: { isOrgAdmin: false, isPlatformAdmin: false },
    });
  }
  const organizationId = ctx.organizationId;
  const [controls, spend, actions, org, orgAdmin, platformAdmin] =
    await Promise.all([
      getKnowledgeControls({ db, organizationId }),
      getKnowledgeSpend({ db, organizationId }),
      listKnowledgeAdminActions({ db, organizationId, limit: 20 }),
      getOrganizationById({ db, organizationId }),
      isOrgAdmin({ db, organizationId, userId: ctx.userId }),
      isPlatformAdmin(),
    ]);
  return NextResponse.json({
    orgSlug: org?.slug ?? null,
    controls: controlsToDto(controls),
    spend: {
      windowStart: spend.windowStart.toISOString(),
      capMicroUsd: spend.capMicroUsd,
      reservedMicroUsd: spend.reservedMicroUsd,
      spentMicroUsd: spend.spentMicroUsd,
      remainingMicroUsd: spend.remainingMicroUsd,
      atCap: spend.atCap,
      capAlertedAt: spend.capAlertedAt?.toISOString() ?? null,
    },
    actions: actions.map((a) => ({
      id: a.id,
      action: a.action,
      target: a.target,
      actorUserId: a.actorUserId,
      createdAt: a.createdAt.toISOString(),
    })),
    viewer: { isOrgAdmin: orgAdmin, isPlatformAdmin: platformAdmin },
  });
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
  const organizationId = ctx.organizationId;

  const [orgAdmin, platformAdmin] = await Promise.all([
    isOrgAdmin({ db, organizationId, userId: ctx.userId }),
    isPlatformAdmin(),
  ]);
  if (!orgAdmin && !platformAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const body = raw as Record<string, unknown>;

  const patch: { engine?: boolean; budgetMicroUsd?: number | null } = {};
  if (body.engine !== undefined) {
    if (typeof body.engine !== "boolean") {
      return NextResponse.json(
        { error: "engine must be a boolean" },
        { status: 400 },
      );
    }
    patch.engine = body.engine;
  }
  if (body.budgetMicroUsd !== undefined) {
    const b = body.budgetMicroUsd;
    if (
      b !== null &&
      !(typeof b === "number" && Number.isSafeInteger(b) && b >= 0)
    ) {
      return NextResponse.json(
        { error: "budgetMicroUsd must be null or a non-negative integer" },
        { status: 400 },
      );
    }
    patch.budgetMicroUsd = b;
  }
  if (patch.engine === undefined && patch.budgetMicroUsd === undefined) {
    return NextResponse.json({ error: "Empty patch" }, { status: 400 });
  }
  if (patch.engine !== undefined && !orgAdmin) {
    return NextResponse.json({ error: "org_admin_required" }, { status: 403 });
  }

  let expectedUpdatedAt: Date | null | undefined;
  if (body.expectedUpdatedAt === undefined) {
    expectedUpdatedAt = undefined;
  } else if (body.expectedUpdatedAt === null) {
    expectedUpdatedAt = null;
  } else if (typeof body.expectedUpdatedAt === "string") {
    const d = new Date(body.expectedUpdatedAt);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json(
        { error: "expectedUpdatedAt must be an ISO date" },
        { status: 400 },
      );
    }
    expectedUpdatedAt = d;
  } else {
    return NextResponse.json(
      { error: "expectedUpdatedAt must be an ISO date or null" },
      { status: 400 },
    );
  }

  // Log platform authority whenever the change needed it, even when the actor
  // is also an org admin (an above-ceiling raise is platform-only).
  let via: "org_admin" | "platform_admin" = orgAdmin
    ? "org_admin"
    : "platform_admin";
  if (patch.budgetMicroUsd !== undefined) {
    const [current, ceilingMicroUsd] = await Promise.all([
      getKnowledgeControls({ db, organizationId }),
      getKnowledgeBudgetCeiling(db),
    ]);
    const verdict = canSetKnowledgeBudget({
      next: patch.budgetMicroUsd,
      current: current.budgetMicroUsd,
      isPlatformAdmin: platformAdmin,
      ceilingMicroUsd,
    });
    if (!verdict.ok) {
      if (verdict.reason === "above_ceiling") {
        return NextResponse.json(
          { error: "budget_above_ceiling", ceilingMicroUsd },
          { status: 403 },
        );
      }
      return NextResponse.json({ error: "out_of_range" }, { status: 400 });
    }
    if (
      patch.budgetMicroUsd !== null &&
      patch.budgetMicroUsd > ceilingMicroUsd
    ) {
      via = "platform_admin";
    }
  }

  let controls: KnowledgeControls;
  try {
    controls = await updateKnowledgeControls({
      db,
      organizationId,
      actorUserId: ctx.userId,
      patch,
      expectedUpdatedAt,
      via,
    });
  } catch (error) {
    if (error instanceof KnowledgeControlsConflictError) {
      const current = await getKnowledgeControls({ db, organizationId });
      return NextResponse.json(
        {
          error: "conflict",
          currentUpdatedAt: current.updatedAt?.toISOString() ?? null,
        },
        { status: 409 },
      );
    }
    if (error instanceof KnowledgeOffboardedError) {
      return NextResponse.json({ error: "offboarded" }, { status: 409 });
    }
    throw error;
  }

  getPostHogServer().capture({
    distinctId: ctx.userId,
    event: "knowledge_controls_updated",
    properties: {
      organizationId,
      engine: patch.engine,
      budgetMicroUsd: patch.budgetMicroUsd,
    },
  });

  return NextResponse.json({ controls: controlsToDto(controls) });
}
