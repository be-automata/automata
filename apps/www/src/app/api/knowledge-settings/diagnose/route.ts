import { NextRequest, NextResponse } from "next/server";

import { forKnowledge } from "@terragon/shared/model/knowledge-access";

import { getTenantContextOrNull, isPlatformAdmin } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { isOrgAdmin } from "@/lib/org-role";
import { getPostHogServer } from "@/lib/posthog-server";
import {
  GithubDeliveriesError,
  listRepoWebhookDeliveries,
} from "@/server-lib/knowledge/github-deliveries";

/**
 * POST /api/knowledge-settings/diagnose
 *
 * Org admin or platform admin, on demand only (the settings GET never calls
 * GitHub). `{ repoFullName }` must be one of the session org's onboarded
 * repos; returns that repo's recent App webhook deliveries as metadata.
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
  const repoFullName = (raw as Record<string, unknown>).repoFullName;
  if (typeof repoFullName !== "string" || repoFullName === "") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const rows = await forKnowledge({
    db,
    organizationId,
  }).admin.listRepoStatus();
  const wanted = repoFullName.toLowerCase();
  if (!rows.some((r) => r.repoFullName === wanted)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let deliveries;
  try {
    deliveries = await listRepoWebhookDeliveries({ repoFullName: wanted });
  } catch (error) {
    if (error instanceof GithubDeliveriesError) {
      return NextResponse.json(
        { error: "github_unavailable" },
        { status: 502 },
      );
    }
    throw error;
  }

  getPostHogServer().capture({
    distinctId: ctx.userId,
    event: "knowledge_repo_diagnosed",
    properties: { organizationId },
  });

  return NextResponse.json({ deliveries });
}
