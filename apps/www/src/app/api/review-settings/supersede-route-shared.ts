import { NextResponse } from "next/server";
import {
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
 * Validate the reviewDraftPrs field of a PUT body — shared by both writers of
 * repo_review_settings (this module's charter: one copy so they can't drift).
 */
export function parseReviewDraftPrs(body: {
  reviewDraftPrs?: unknown;
}): { reviewDraftPrs?: boolean | null } | { errorResponse: NextResponse } {
  if (body.reviewDraftPrs === undefined) return {};
  if (
    body.reviewDraftPrs !== null &&
    typeof body.reviewDraftPrs !== "boolean"
  ) {
    return {
      errorResponse: NextResponse.json(
        { error: "reviewDraftPrs must be a boolean or null (null = inherit)" },
        { status: 400 },
      ),
    };
  }
  return { reviewDraftPrs: body.reviewDraftPrs };
}
