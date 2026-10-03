/**
 * Review-agent settings (phase 4): the five admin-panel knobs that shape a
 * PR-review run — mode, battery packs, whether tests may run, the per-command
 * timeout and the lead reviewer's turn limit.
 *
 * STORAGE: nullable columns on `repo_review_settings`; NULL = inherit. The org
 * default is the existing '*' sentinel row (`ORG_DEFAULT_REPO_SENTINEL`) on
 * the same table — the supersedePolicy precedent, not a second table.
 * Precedence per field: repo row → '*' org-default row → system default.
 *
 * VALIDATION: values are stored as raw strings/ints and checked by
 * `findReviewAgentFieldError` at the write boundary AND at resolve time. An
 * unknown stored value at resolve time throws (supersede precedent); it never
 * degrades silently.
 *
 * `REVIEW_BATTERY_PACK_IDS` is the contract Phase 3's battery manifest must
 * match (Phase 3 adds that cross-check test).
 *
 * `reviewMaxTurns`: Limits the lead reviewer's turns. Sub-agent turns are not counted, so this is not a cost limit.
 *
 * This module imports nothing (no db, no drizzle) so client components can
 * import it.
 */

export const REVIEW_MODES = ["classic", "orchestrated"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/** Today's behaviour: one reviewer, no battery packs. */
export const DEFAULT_REVIEW_MODE: ReviewMode = "classic";

export function isReviewMode(value: unknown): value is ReviewMode {
  return (
    typeof value === "string" &&
    (REVIEW_MODES as readonly string[]).includes(value)
  );
}

export const REVIEW_BATTERY_PACK_IDS = [
  "gstack-review",
  "somnio-review",
  "gsd-reviewers",
] as const;
export type ReviewBatteryPackId = (typeof REVIEW_BATTERY_PACK_IDS)[number];

export function isReviewBatteryPackId(
  value: unknown,
): value is ReviewBatteryPackId {
  return (
    typeof value === "string" &&
    (REVIEW_BATTERY_PACK_IDS as readonly string[]).includes(value)
  );
}

export const REVIEW_COMMAND_TIMEOUT_S_MIN = 60;
export const REVIEW_COMMAND_TIMEOUT_S_MAX = 600;
export const REVIEW_MAX_TURNS_MIN = 1;
export const REVIEW_MAX_TURNS_MAX = 500;

export const REVIEW_AGENT_FIELDS = [
  "reviewMode",
  "reviewBatteries",
  "reviewRunTests",
  "reviewCommandTimeoutS",
  "reviewMaxTurns",
] as const;
export type ReviewAgentField = (typeof REVIEW_AGENT_FIELDS)[number];

/** A write patch for the review-agent family; `null` clears (= inherit). */
export interface ReviewAgentFieldsPatch {
  reviewMode?: string | null;
  reviewBatteries?: string[] | null;
  reviewRunTests?: boolean | null;
  reviewCommandTimeoutS?: number | null;
  reviewMaxTurns?: number | null;
}

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function findBatteriesError(value: unknown): string | undefined {
  const allowed = REVIEW_BATTERY_PACK_IDS.join(", ");
  if (!Array.isArray(value)) {
    return `reviewBatteries must be a list of pack ids (${allowed}), or null (inherit)`;
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (!isReviewBatteryPackId(item)) {
      return `reviewBatteries has an unknown pack id ${JSON.stringify(item)}; allowed: ${allowed}`;
    }
    if (seen.has(item)) {
      return `reviewBatteries has a duplicate pack id "${item}"`;
    }
    seen.add(item);
  }
  return undefined;
}

function findFieldError(
  field: ReviewAgentField,
  value: unknown,
): string | undefined {
  switch (field) {
    case "reviewMode":
      return isReviewMode(value)
        ? undefined
        : `reviewMode must be one of ${REVIEW_MODES.join(", ")}, or null (inherit)`;
    case "reviewBatteries":
      return findBatteriesError(value);
    case "reviewRunTests":
      return typeof value === "boolean"
        ? undefined
        : "reviewRunTests must be true or false, or null (inherit)";
    case "reviewCommandTimeoutS":
      return isIntegerInRange(
        value,
        REVIEW_COMMAND_TIMEOUT_S_MIN,
        REVIEW_COMMAND_TIMEOUT_S_MAX,
      )
        ? undefined
        : `reviewCommandTimeoutS must be an integer from ${REVIEW_COMMAND_TIMEOUT_S_MIN} to ${REVIEW_COMMAND_TIMEOUT_S_MAX}, or null (inherit)`;
    case "reviewMaxTurns":
      return isIntegerInRange(value, REVIEW_MAX_TURNS_MIN, REVIEW_MAX_TURNS_MAX)
        ? undefined
        : `reviewMaxTurns must be an integer from ${REVIEW_MAX_TURNS_MIN} to ${REVIEW_MAX_TURNS_MAX}, or null (inherit)`;
  }
}

/**
 * The one validator for the review-agent family (write boundary, routes and
 * resolver). Checks only the review-agent keys present (not undefined) in
 * `patch`; other keys are ignored. `null` is always valid (= inherit).
 * Returns the first error, or undefined when every present field is valid.
 */
export function findReviewAgentFieldError(
  patch: Record<string, unknown>,
): string | undefined {
  for (const field of REVIEW_AGENT_FIELDS) {
    const value = patch[field];
    if (value === undefined || value === null) {
      continue;
    }
    const error = findFieldError(field, value);
    if (error !== undefined) {
      return error;
    }
  }
  return undefined;
}
