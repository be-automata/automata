import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getTenantContextOrNull } from "@/lib/auth-server";
import {
  listRepoReviewSettings,
  ORG_DEFAULT_REPO_SENTINEL,
} from "@terragon/shared/model/repo-review-settings";

/**
 * GET /api/review-settings
 *
 * Lists the calling user's active-organization per-repo REQUESTED_CHANGES
 * tolerance overrides (ADR-036 review floor). Fenced to the session's active
 * org — a user only ever sees their own org's overrides. Repos without a row
 * simply aren't listed (they use the locked `warning` default).
 */
export async function GET(): Promise<NextResponse> {
  const ctx = await getTenantContextOrNull();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ctx.organizationId) {
    // No active org → nothing to scope to. Return an empty set, not an error.
    return NextResponse.json({ settings: [] });
  }
  const rows = await listRepoReviewSettings({
    db,
    organizationId: ctx.organizationId,
  });
  return NextResponse.json({
    settings: rows
      // The org-default sentinel has its own endpoint (/api/review-settings/default).
      .filter((r) => r.repoFullName !== ORG_DEFAULT_REPO_SENTINEL)
      .map((r) => ({
        repoFullName: r.repoFullName,
        blockTolerance: r.blockTolerance,
        reviewDraftPrs: r.reviewDraftPrs,
        supersedePolicy: r.supersedePolicy,
        recheckOnComplete: r.recheckOnComplete,
        updatedAt: r.updatedAt,
      })),
  });
}
