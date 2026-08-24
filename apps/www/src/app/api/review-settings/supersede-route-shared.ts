import { NextResponse } from "next/server";
import type { DB } from "@terragon/shared/db";
import {
  getRepoReviewSetting,
  isSupersedePolicy,
  SUPERSEDE_POLICIES,
} from "@terragon/shared/model/repo-review-settings";

/**
 * #125 C6 pieces shared by the two writers of the repo_review_settings table
 * (the per-repo route and the org-default sentinel route). Both the accepted
 * values and the 409 body shape are protocol with the client's ConflictError
 * parser — one copy here so they can't drift.
 */

export type SupersedePatch = {
  supersedePolicy?: string | null;
  recheckOnComplete?: boolean;
};

/** Validate the supersede fields of a PUT body. Returns the patch or a 400. */
export function parseSupersedePatch(body: {
  supersedePolicy?: unknown;
  recheckOnComplete?: unknown;
}): { patch: SupersedePatch } | { errorResponse: NextResponse } {
  const patch: SupersedePatch = {};
  if (body.supersedePolicy !== undefined) {
    if (
      body.supersedePolicy !== null &&
      !(
        typeof body.supersedePolicy === "string" &&
        isSupersedePolicy(body.supersedePolicy)
      )
    ) {
      return {
        errorResponse: NextResponse.json(
          {
            error: `supersedePolicy must be null or one of ${SUPERSEDE_POLICIES.join(", ")}`,
          },
          { status: 400 },
        ),
      };
    }
    patch.supersedePolicy = body.supersedePolicy;
  }
  if (body.recheckOnComplete !== undefined) {
    if (typeof body.recheckOnComplete !== "boolean") {
      return {
        errorResponse: NextResponse.json(
          { error: "recheckOnComplete must be a boolean" },
          { status: 400 },
        ),
      };
    }
    patch.recheckOnComplete = body.recheckOnComplete;
  }
  return { patch };
}

/**
 * Optimistic concurrency: a write carrying a stale expectedUpdatedAt gets a
 * 409 {error:"conflict", currentUpdatedAt} — never a silent last-write-wins
 * between two admins. Returns the 409 to send, or null when the write may
 * proceed.
 */
export async function checkExpectedUpdatedAt({
  db,
  organizationId,
  repoFullName,
  expectedUpdatedAt,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  expectedUpdatedAt: unknown;
}): Promise<NextResponse | null> {
  if (expectedUpdatedAt === undefined) return null;
  const existing = await getRepoReviewSetting({
    db,
    organizationId,
    repoFullName,
  });
  const current = existing?.updatedAt?.toISOString() ?? null;
  if (current !== null && current !== expectedUpdatedAt) {
    return NextResponse.json(
      { error: "conflict", currentUpdatedAt: current },
      { status: 409 },
    );
  }
  return null;
}
