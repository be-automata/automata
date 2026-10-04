import { NextResponse } from "next/server";
import {
  isSupersedePolicy,
  SUPERSEDE_POLICIES,
} from "@terragon/shared/model/repo-review-settings";
import type { RepoReviewSetting } from "@terragon/shared/db/types";
import {
  REVIEW_AGENT_FIELDS,
  findReviewAgentFieldError,
  isValidReviewAgentPatch,
  pickReviewAgentFields,
  type ReviewAgentFieldsPatch,
} from "@terragon/shared/model/review-agent-settings";
import {
  SELF_HEAL_FIELDS,
  findSelfHealFieldError,
  pickSelfHealFields,
  type SelfHealFieldsPatch,
} from "@terragon/shared/model/self-heal-settings";
import { recordSelfHealAdminAction } from "@terragon/shared/model/self-heal-admin-log";
import type { DB } from "@terragon/shared/db";

/**
 * #125 C6 pieces shared by the two writers of the repo_review_settings table
 * (the per-repo route and the org-default sentinel route). Both the accepted
 * values and the 409 body shape are protocol with the client's ConflictError
 * parser — one copy here so they can't drift. Phase 4: this module also owns
 * the review-agent family's body parsing for both writers and the per-repo
 * row DTO shared by the list and per-repo routes.
 */

/** The wire shape of one per-repo row (GET list and PUT response). */
export function toRepoReviewSettingDto(row: RepoReviewSetting) {
  return {
    repoFullName: row.repoFullName,
    blockTolerance: row.blockTolerance,
    reviewDraftPrs: row.reviewDraftPrs,
    supersedePolicy: row.supersedePolicy,
    recheckOnComplete: row.recheckOnComplete,
    ...pickReviewAgentFields(row),
    ...pickSelfHealFields(row),
    updatedAt: row.updatedAt,
  };
}

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

/**
 * Validate the review-agent fields of a PUT body (phase 4). Copies only the
 * review-agent keys that are present; null clears (= inherit). Returns the
 * patch or a 400 naming the first invalid field.
 */
export function parseReviewAgentPatch(
  body: Record<string, unknown>,
): { patch: ReviewAgentFieldsPatch } | { errorResponse: NextResponse } {
  const raw: Record<string, unknown> = {};
  for (const field of REVIEW_AGENT_FIELDS) {
    if (body[field] !== undefined) {
      raw[field] = body[field];
    }
  }
  if (!isValidReviewAgentPatch(raw)) {
    return {
      errorResponse: NextResponse.json(
        { error: findReviewAgentFieldError(raw) },
        { status: 400 },
      ),
    };
  }
  return { patch: raw };
}

/**
 * Validate the self-heal fields of a PUT body (phase 8, D1). Copies only the
 * self-heal keys that are present; null clears (= inherit). The kill switch is
 * accepted on the org-default row only, and any gate-command key is rejected
 * as unknown: the loop never takes a command from the settings API.
 */
export function parseSelfHealPatch(
  body: Record<string, unknown>,
  options: { isOrgDefaultRow: boolean },
): { patch: SelfHealFieldsPatch } | { errorResponse: NextResponse } {
  const unknownKey = Object.keys(body).find((key) =>
    key.toLowerCase().includes("gatecommand"),
  );
  if (unknownKey !== undefined) {
    return {
      errorResponse: NextResponse.json(
        { error: `unknown field: ${unknownKey}` },
        { status: 400 },
      ),
    };
  }
  const raw: Record<string, unknown> = {};
  for (const field of SELF_HEAL_FIELDS) {
    if (body[field] !== undefined) {
      raw[field] = body[field];
    }
  }
  const error = findSelfHealFieldError(raw, options);
  if (error !== undefined) {
    return {
      errorResponse: NextResponse.json({ error }, { status: 400 }),
    };
  }
  return { patch: raw };
}

/**
 * Attribute a self-heal settings change (OBS-01): one admin-log row per
 * accepted write that touches at least one self-heal field. Logs the changed
 * field names only, never values. No-op for patches without a self-heal key.
 */
export async function recordSelfHealSettingsChange({
  db,
  organizationId,
  actorUserId,
  repoFullName,
  patch,
}: {
  db: DB;
  organizationId: string;
  actorUserId: string;
  repoFullName: string;
  patch: Record<string, unknown>;
}): Promise<void> {
  const fields = SELF_HEAL_FIELDS.filter((field) => field in patch);
  if (fields.length === 0) return;
  await recordSelfHealAdminAction({
    db,
    organizationId,
    actorUserId,
    action: fields.includes("selfHealKillSwitch")
      ? "kill_switch"
      : "settings_change",
    target: { repoFullName, fields },
  });
}
