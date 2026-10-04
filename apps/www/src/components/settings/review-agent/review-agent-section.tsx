"use client";

import {
  DEFAULT_REVIEW_MODE,
  REVIEW_AGENT_FIELDS,
  isReviewMode,
  type ReviewBatteryPackId,
  type ReviewMode,
} from "@terragon/shared/model/review-agent-settings";

/**
 * Phase 4 — "Review agent": the org-default review-agent settings (the '*'
 * sentinel row) and per-repo overrides. Every field offers "Inherit" (null).
 * Classic means exactly today's behaviour, so packs, run tests, timeout and
 * max turns only apply when the mode resolves to orchestrated.
 */

/** Short plain labels for the battery packs. */
export const REVIEW_BATTERY_PACK_LABELS: Record<ReviewBatteryPackId, string> = {
  "gstack-review": "gstack review",
  "somnio-review": "Somnio review",
  "gsd-reviewers": "GSD reviewers",
};

export const MAX_TURNS_LABEL = "Max turns (lead agent)";
export const MAX_TURNS_NOTE =
  "Limits the lead reviewer's turns. Sub-agent turns are not counted, so this is not a cost limit.";
export const CLASSIC_HINT =
  "Only used in orchestrated mode. Classic runs exactly as today.";
export const RUN_TESTS_NOTE =
  "Pull requests from forks or untrusted authors never run tests.";

/** The review-agent fields of a settings row (null = inherit). */
export interface ReviewAgentValues {
  reviewMode: ReviewMode | null;
  reviewBatteries: ReviewBatteryPackId[] | null;
  reviewRunTests: boolean | null;
  reviewCommandTimeoutS: number | null;
  reviewMaxTurns: number | null;
}

/** "Restore default": clear all five fields back to inherit. */
export const REVIEW_AGENT_CLEAR_PATCH = {
  reviewMode: null,
  reviewBatteries: null,
  reviewRunTests: null,
  reviewCommandTimeoutS: null,
  reviewMaxTurns: null,
} as const;

/** The mode a run would use: repo value → org value → system default. */
export function effectiveReviewMode(
  repoValue: string | null | undefined,
  orgValue: string | null | undefined,
): ReviewMode {
  if (isReviewMode(repoValue)) return repoValue;
  if (isReviewMode(orgValue)) return orgValue;
  return DEFAULT_REVIEW_MODE;
}

function hasReviewAgentOverride(row: ReviewAgentValues): boolean {
  return REVIEW_AGENT_FIELDS.some((field) => row[field] !== null);
}

/** Rows carrying at least one review-agent override (an empty pack list counts). */
export function reviewAgentOverrides<T extends ReviewAgentValues>(
  settings: readonly T[],
): T[] {
  return settings.filter(hasReviewAgentOverride);
}

/**
 * Repos the "Add override" picker may offer: every visible repo minus those
 * that already carry a review-agent override. Slugs compare lowercased, as
 * the model stores them.
 */
export function availableReviewAgentRepos(
  repoFullNames: readonly string[],
  settings: readonly (ReviewAgentValues & { repoFullName: string })[],
): string[] {
  const taken = new Set(
    reviewAgentOverrides(settings).map((s) => s.repoFullName.toLowerCase()),
  );
  return repoFullNames.filter((name) => !taken.has(name.toLowerCase())).sort();
}

/**
 * The fence for a repo's first review-agent write: the row's version when a
 * row exists for another family, else null (the whole-row first-write fence).
 */
export function firstWriteFence(
  repoFullName: string,
  settings: readonly { repoFullName: string; updatedAt: string }[],
): string | null {
  const key = repoFullName.toLowerCase();
  const row = settings.find((s) => s.repoFullName.toLowerCase() === key);
  return row ? row.updatedAt : null;
}

/**
 * Parse a number input: empty → null (inherit); a whole number → that
 * number; anything else → undefined (invalid — do not save).
 */
export function parseOptionalInt(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}
