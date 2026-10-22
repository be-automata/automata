import { NextRequest, NextResponse } from "next/server";

import {
  clearKnowledgeOffboard,
  offboardKnowledge,
} from "@terragon/shared/model/knowledge-controls";
import { getOrganizationById } from "@terragon/shared/model/organizations";

import { getTenantContextOrNull } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { isOrgAdmin } from "@/lib/org-role";
import { getPostHogServer } from "@/lib/posthog-server";

import { controlsToDto } from "@/server-lib/knowledge/controls-dto";

/**
 * POST /api/knowledge-settings/offboard
 *
 * Org admins only (a platform admin who is not an org admin is refused).
 * `{ action: "offboard", confirm: <org slug> }` forces the engine Off and
 * starts the purge grace period; `{ action: "undo" }` clears the mark.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
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

  const admin = await isOrgAdmin({
    db,
    organizationId,
    userId: ctx.userId,
  });
  if (!admin) {
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

  let controls;
  if (body.action === "offboard") {
    const org = await getOrganizationById({ db, organizationId });
    if (!org || typeof body.confirm !== "string" || body.confirm !== org.slug) {
      return NextResponse.json(
        { error: "confirmation_mismatch" },
        { status: 400 },
      );
    }
    controls = await offboardKnowledge({
      db,
      organizationId,
      actorUserId: ctx.userId,
    });
  } else if (body.action === "undo") {
    controls = await clearKnowledgeOffboard({
      db,
      organizationId,
      actorUserId: ctx.userId,
    });
  } else {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  getPostHogServer().capture({
    distinctId: ctx.userId,
    event: "knowledge_offboard_changed",
    properties: { organizationId, action: body.action },
  });

  return NextResponse.json({ controls: controlsToDto(controls) });
}
