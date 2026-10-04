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
 * PACK IDS: `BATTERY_PACK_IDS` is every pack the battery manifest
 * (packages/worker/deploy/batteries.json) installs, in manifest order; the
 * worker's deploy-assets test pins the two lists equal. `REVIEW_BATTERY_PACK_IDS`
 * is the review setting's allowed subset and stays exactly the three review
 * packs. The phase 7 task setting validates against `BATTERY_PACK_IDS`.
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

/** Every pack the battery manifest installs: the review packs, then the task-only packs. */
export const BATTERY_PACK_IDS = [
  ...REVIEW_BATTERY_PACK_IDS,
  "somnio-skills",
] as const;
export type BatteryPackId = (typeof BATTERY_PACK_IDS)[number];

export function isBatteryPackId(value: unknown): value is BatteryPackId {
  return (
    typeof value === "string" &&
    (BATTERY_PACK_IDS as readonly string[]).includes(value)
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

/**
 * A write patch for the review-agent family; `null` clears (= inherit).
 * A `type` (not an interface) so patches that include it stay assignable to
 * `Record<string, unknown>` for {@link findReviewAgentFieldError}.
 */
export type ReviewAgentFieldsPatch = {
  reviewMode?: string | null;
  reviewBatteries?: string[] | null;
  reviewRunTests?: boolean | null;
  reviewCommandTimeoutS?: number | null;
  reviewMaxTurns?: number | null;
};

/** The review-agent fields of a settings row, typed (null = inherit). */
export interface ReviewAgentValues {
  reviewMode: ReviewMode | null;
  reviewBatteries: ReviewBatteryPackId[] | null;
  reviewRunTests: boolean | null;
  reviewCommandTimeoutS: number | null;
  reviewMaxTurns: number | null;
}

/** System defaults — what an all-inherit (repo and org) field resolves to. */
export const REVIEW_CLASSIC_COMMAND_TIMEOUT_S = 60;
export const REVIEW_ORCHESTRATED_COMMAND_TIMEOUT_S_DEFAULT = 300;
export const DEFAULT_REVIEW_BATTERIES: readonly ReviewBatteryPackId[] =
  REVIEW_BATTERY_PACK_IDS;
export const DEFAULT_REVIEW_RUN_TESTS = false;

/** The one human wording per mode (SUPERSEDE_POLICY_LABELS precedent). */
export const REVIEW_MODE_LABELS: Record<ReviewMode, string> = {
  classic: "Classic",
  orchestrated: "Orchestrated",
};

/** Short plain labels for the battery packs. */
export const REVIEW_BATTERY_PACK_LABELS: Record<ReviewBatteryPackId, string> = {
  "gstack-review": "gstack review",
  "somnio-review": "Somnio review",
  "gsd-reviewers": "GSD reviewers",
};

/** Short plain labels for every battery pack (the task setting offers all of them). */
export const BATTERY_PACK_LABELS: Record<BatteryPackId, string> = {
  ...REVIEW_BATTERY_PACK_LABELS,
  "somnio-skills": "Somnio skills (DORA, health, security)",
};

/** The five review-agent fields of any row-shaped object, nothing else. */
export function pickReviewAgentFields<
  T extends Record<ReviewAgentField, unknown>,
>(row: T): Pick<T, ReviewAgentField> {
  const picked: Partial<Pick<T, ReviewAgentField>> = {};
  for (const field of REVIEW_AGENT_FIELDS) {
    Object.assign(picked, { [field]: row[field] });
  }
  // Every key of REVIEW_AGENT_FIELDS was assigned by the loop above.
  return picked as Pick<T, ReviewAgentField>;
}

/** The mode a run would use: repo value → org value → system default. */
export function effectiveReviewMode(
  repoValue: string | null | undefined,
  orgValue: string | null | undefined,
): ReviewMode {
  if (isReviewMode(repoValue)) return repoValue;
  if (isReviewMode(orgValue)) return orgValue;
  return DEFAULT_REVIEW_MODE;
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

/**
 * Type-guard form of {@link findReviewAgentFieldError}: true when every
 * review-agent key present in `patch` holds a valid value (or null).
 */
export function isValidReviewAgentPatch(
  patch: Record<string, unknown>,
): patch is Record<string, unknown> & ReviewAgentFieldsPatch {
  return findReviewAgentFieldError(patch) === undefined;
}
