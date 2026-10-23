/**
 * Review-agent settings (phase 4): the five admin-panel knobs that shape a
 * PR-review run — mode, battery packs, whether tests may run, the per-command
 * timeout and the lead reviewer's turn limit — plus, since phase 7, the
 * task-run packs (`taskBatteries`, see TASK PACKS below).
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
 * packs. `HARNESS_PACK_IDS` are the full upstream tool suites (gstack, GSD,
 * ruflo, the Somnio engineering plugin) a separate manifest (packages/worker/deploy/harness.json) installs;
 * the same deploy-assets test pins those two lists equal. The task setting
 * validates against `TASK_BATTERY_PACK_IDS` (manifest packs + harness packs);
 * a harness id is never a valid review pack.
 *
 * TASK PACKS (phase 7): `taskBatteries` is NOT a review knob. It names the
 * packs non-review runs (manual, scheduled and mention task runs) get, and it
 * shares this family only for storage, routes, DTOs and the override/remove
 * logic. Review resolution must iterate `REVIEW_ONLY_AGENT_FIELDS`, so an
 * invalid stored task value can never fail a review dispatch. System default:
 * none (`DEFAULT_TASK_BATTERIES`), i.e. today's task runs.
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

/**
 * The harness packs: full upstream tool suites (bin/, hooks, an MCP server for
 * ruflo) installed from harness.json, never from batteries.json. Task and PR
 * lanes only — the review setting rejects them and the worker never seeds
 * them into a review run.
 */
export const HARNESS_PACK_IDS = [
  "gstack",
  "gsd",
  "ruflo",
  "somnio-engineering",
] as const;
export type HarnessPackId = (typeof HARNESS_PACK_IDS)[number];

export function isHarnessPackId(value: unknown): value is HarnessPackId {
  return (
    typeof value === "string" &&
    (HARNESS_PACK_IDS as readonly string[]).includes(value)
  );
}

/** Every pack a task run may select: the manifest packs, then the harness packs. */
export const TASK_BATTERY_PACK_IDS = [
  ...BATTERY_PACK_IDS,
  ...HARNESS_PACK_IDS,
] as const;
export type TaskBatteryPackId = (typeof TASK_BATTERY_PACK_IDS)[number];

export function isTaskBatteryPackId(
  value: unknown,
): value is TaskBatteryPackId {
  return (
    typeof value === "string" &&
    (TASK_BATTERY_PACK_IDS as readonly string[]).includes(value)
  );
}

/**
 * Capabilities a pack can require of the control plane (phase 7). Mirrors
 * the manifest's `packs[].requires` closed set (batteries-manifest.ts
 * BATTERY_REQUIREMENTS + the installer preflight).
 */
export const BATTERY_REQUIREMENTS = ["github-read-token"] as const;
export type BatteryRequirement = (typeof BATTERY_REQUIREMENTS)[number];

/**
 * What each pack requires; pinned equal to batteries.json by deploy-assets.
 * Selecting a pack that requires `github-read-token` in the Admin panel IS the
 * opt-in (D1) for a read-only, single-repo, ≤1h GitHub App token on task runs
 * — never on review runs.
 */
export const BATTERY_PACK_REQUIRES: Record<
  BatteryPackId,
  readonly BatteryRequirement[]
> = {
  "gstack-review": [],
  "somnio-review": [],
  "gsd-reviewers": [],
  "somnio-skills": ["github-read-token"],
};

/**
 * True when any known id in `ids` requires `req`; unknown ids are ignored.
 * Harness ids require nothing (they are not in BATTERY_PACK_REQUIRES), so
 * they are ignored too.
 */
export function packsRequire(
  ids: readonly string[],
  req: BatteryRequirement,
): boolean {
  return ids.some(
    (id) => isBatteryPackId(id) && BATTERY_PACK_REQUIRES[id].includes(req),
  );
}

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

/** The review knobs proper; review resolution iterates exactly these. */
export const REVIEW_ONLY_AGENT_FIELDS = [
  "reviewMode",
  "reviewBatteries",
  "reviewRunTests",
  "reviewCommandTimeoutS",
  "reviewMaxTurns",
] as const;
export type ReviewOnlyAgentField = (typeof REVIEW_ONLY_AGENT_FIELDS)[number];

/** The task-run packs field (phase 7); see the module docblock. */
export const TASK_AGENT_FIELD = "taskBatteries";

/** The whole family as stored, routed and cleared: review knobs + task packs. */
export const REVIEW_AGENT_FIELDS = [
  ...REVIEW_ONLY_AGENT_FIELDS,
  TASK_AGENT_FIELD,
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
  taskBatteries?: string[] | null;
};

/** The review-agent fields of a settings row, typed (null = inherit). */
export interface ReviewAgentValues {
  reviewMode: ReviewMode | null;
  reviewBatteries: ReviewBatteryPackId[] | null;
  reviewRunTests: boolean | null;
  reviewCommandTimeoutS: number | null;
  reviewMaxTurns: number | null;
  taskBatteries: TaskBatteryPackId[] | null;
}

/** System defaults — what an all-inherit (repo and org) field resolves to. */
export const REVIEW_CLASSIC_COMMAND_TIMEOUT_S = 60;
export const REVIEW_ORCHESTRATED_COMMAND_TIMEOUT_S_DEFAULT = 300;
export const DEFAULT_REVIEW_BATTERIES: readonly ReviewBatteryPackId[] =
  REVIEW_BATTERY_PACK_IDS;
export const DEFAULT_REVIEW_RUN_TESTS = false;
/** Task runs get no packs unless a repo or '*' row says otherwise (today). */
export const DEFAULT_TASK_BATTERIES: readonly TaskBatteryPackId[] = [];

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

/** Short plain labels for every manifest battery pack. */
export const BATTERY_PACK_LABELS: Record<BatteryPackId, string> = {
  ...REVIEW_BATTERY_PACK_LABELS,
  "somnio-skills": "Somnio skills (DORA, Flutter, React, security)",
};

/** Short plain labels for the harness packs. */
export const HARNESS_PACK_LABELS: Record<HarnessPackId, string> = {
  gstack: "gstack (full suite)",
  gsd: "GSD (full suite)",
  ruflo: "ruflo (MCP memory and tasks)",
  "somnio-engineering":
    "Somnio engineering plugin (dev-execution, UAT, YouTrack)",
};

/** Short plain labels for every pack the task setting offers. */
export const TASK_BATTERY_PACK_LABELS: Record<TaskBatteryPackId, string> = {
  ...BATTERY_PACK_LABELS,
  ...HARNESS_PACK_LABELS,
};

/** The review-agent family fields (REVIEW_AGENT_FIELDS) of any row-shaped object, nothing else. */
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

/**
 * A pack-id list setting: an array of distinct ids drawn from `allowedIds`.
 * Shared by the review packs (`reviewBatteries`) and the task packs
 * (`taskBatteries`); the field name prefixes every message.
 */
function findPackListError(
  field: "reviewBatteries" | "taskBatteries",
  value: unknown,
  allowedIds: readonly string[],
  isId: (item: unknown) => boolean,
): string | undefined {
  const allowed = allowedIds.join(", ");
  if (!Array.isArray(value)) {
    return `${field} must be a list of pack ids (${allowed}), or null (inherit)`;
  }
  const seen = new Set<unknown>();
  for (const item of value) {
    if (!isId(item)) {
      return `${field} has an unknown pack id ${JSON.stringify(item)}; allowed: ${allowed}`;
    }
    if (seen.has(item)) {
      return `${field} has a duplicate pack id "${String(item)}"`;
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
      return findPackListError(
        field,
        value,
        REVIEW_BATTERY_PACK_IDS,
        isReviewBatteryPackId,
      );
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
    case "taskBatteries":
      return findPackListError(
        field,
        value,
        TASK_BATTERY_PACK_IDS,
        isTaskBatteryPackId,
      );
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
