/**
 * Self-heal settings (phase 8): the settings-panel knobs that govern the
 * audit-findings -> issues loop. Eleven nullable columns on
 * `repo_review_settings`; NULL = inherit, the '*' row is the org default, and
 * the system default mode is "off".
 *
 * The family gates CONTROL-PLANE effects only (whether and how fast the
 * platform writes issues and starts fix runs). It is never shipped to the
 * worker. Nothing here is read from env vars (D1).
 *
 * The kill switch is monotone and org-only: it may be set on the '*' row and
 * nowhere else (ADR-005 floor precedent), so a repo row can never lift an
 * org-level stop.
 *
 * There is deliberately no gate-command field (GATE-01: admin-supplied shell
 * commands are a remote-code surface; the gate runs on the repo's own CI) and
 * no spend/cost field (operator decision: no spend limits).
 *
 * This module imports nothing (no db, no drizzle) so client components can
 * import it.
 */

export const SELF_HEAL_MODES = ["off", "dry-run", "on"] as const;
export type SelfHealMode = (typeof SELF_HEAL_MODES)[number];

export const SELF_HEAL_SEVERITIES = ["low", "medium", "high"] as const;
export type SelfHealSeverity = (typeof SELF_HEAL_SEVERITIES)[number];

export const SELF_HEAL_FIELDS = [
  "selfHealMode",
  "selfHealKillSwitch",
  "selfHealMaxOpenIssues",
  "selfHealMaxAttempts",
  "selfHealCooldownMin",
  "selfHealMinSeverity",
  "selfHealAutoLabel",
  "selfHealAbsentAudits",
  "selfHealMaxDiffLines",
  "selfHealPrExpiryDays",
  "selfHealRunWindow",
] as const;
export type SelfHealField = (typeof SELF_HEAL_FIELDS)[number];

export interface SelfHealRange {
  min: number;
  max: number;
}

export const SELF_HEAL_BOUNDS = {
  maxOpenIssues: { min: 1, max: 20 },
  maxAttempts: { min: 1, max: 5 },
  cooldownMin: { min: 0, max: 10080 },
  absentAudits: { min: 1, max: 5 },
  maxDiffLines: { min: 10, max: 2000 },
  prExpiryDays: { min: 1, max: 30 },
} as const satisfies Record<string, SelfHealRange>;

export const SELF_HEAL_DEFAULTS = {
  mode: "off",
  killSwitch: false,
  maxOpenIssues: 3,
  maxAttempts: 2,
  cooldownMin: 360,
  minSeverity: "medium",
  autoLabel: false,
  absentAudits: 2,
  maxDiffLines: 300,
  prExpiryDays: 7,
  runWindow: "02:00-06:00",
} as const satisfies {
  mode: SelfHealMode;
  killSwitch: boolean;
  maxOpenIssues: number;
  maxAttempts: number;
  cooldownMin: number;
  minSeverity: SelfHealSeverity;
  autoLabel: boolean;
  absentAudits: number;
  maxDiffLines: number;
  prExpiryDays: number;
  runWindow: string;
};

/** A write patch; `null` clears (= inherit). */
export type SelfHealFieldsPatch = {
  selfHealMode?: string | null;
  selfHealKillSwitch?: boolean | null;
  selfHealMaxOpenIssues?: number | null;
  selfHealMaxAttempts?: number | null;
  selfHealCooldownMin?: number | null;
  selfHealMinSeverity?: string | null;
  selfHealAutoLabel?: boolean | null;
  selfHealAbsentAudits?: number | null;
  selfHealMaxDiffLines?: number | null;
  selfHealPrExpiryDays?: number | null;
  selfHealRunWindow?: string | null;
};

/** The self-heal fields of a settings row, typed (null = inherit). */
export interface SelfHealValues {
  selfHealMode: SelfHealMode | null;
  selfHealKillSwitch: boolean | null;
  selfHealMaxOpenIssues: number | null;
  selfHealMaxAttempts: number | null;
  selfHealCooldownMin: number | null;
  selfHealMinSeverity: SelfHealSeverity | null;
  selfHealAutoLabel: boolean | null;
  selfHealAbsentAudits: number | null;
  selfHealMaxDiffLines: number | null;
  selfHealPrExpiryDays: number | null;
  selfHealRunWindow: string | null;
}

/** Clears every self-heal field (all inherit). */
export const SELF_HEAL_CLEAR_PATCH: { [K in SelfHealField]: null } = {
  selfHealMode: null,
  selfHealKillSwitch: null,
  selfHealMaxOpenIssues: null,
  selfHealMaxAttempts: null,
  selfHealCooldownMin: null,
  selfHealMinSeverity: null,
  selfHealAutoLabel: null,
  selfHealAbsentAudits: null,
  selfHealMaxDiffLines: null,
  selfHealPrExpiryDays: null,
  selfHealRunWindow: null,
};

export function isSelfHealMode(value: unknown): value is SelfHealMode {
  return (
    typeof value === "string" &&
    (SELF_HEAL_MODES as readonly string[]).includes(value)
  );
}

export function isSelfHealSeverity(value: unknown): value is SelfHealSeverity {
  return (
    typeof value === "string" &&
    (SELF_HEAL_SEVERITIES as readonly string[]).includes(value)
  );
}

export function severityRank(severity: SelfHealSeverity): 0 | 1 | 2 {
  switch (severity) {
    case "low":
      return 0;
    case "medium":
      return 1;
    case "high":
      return 2;
  }
}

const RUN_WINDOW_PATTERN =
  /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** Parses "HH:MM-HH:MM" (UTC). Null when malformed or start equals end. */
export function parseRunWindow(
  value: string,
): { startMin: number; endMin: number } | null {
  const match = RUN_WINDOW_PATTERN.exec(value);
  if (match === null) return null;
  const startMin = Number(match[1]) * 60 + Number(match[2]);
  const endMin = Number(match[3]) * 60 + Number(match[4]);
  if (startMin === endMin) return null;
  return { startMin, endMin };
}

/** True when `now` (UTC) falls in the window; wrap-aware, end exclusive. */
export function isInRunWindow(window: string, now: Date): boolean {
  const parsed = parseRunWindow(window);
  if (parsed === null) return false;
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (parsed.startMin < parsed.endMin) {
    return minute >= parsed.startMin && minute < parsed.endMin;
  }
  return minute >= parsed.startMin || minute < parsed.endMin;
}

function isIntegerInRange(value: unknown, range: SelfHealRange): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= range.min &&
    value <= range.max
  );
}

function integerError(
  field: SelfHealField,
  value: unknown,
  range: SelfHealRange,
): string | undefined {
  return isIntegerInRange(value, range)
    ? undefined
    : `${field} must be an integer from ${range.min} to ${range.max}, or null (inherit)`;
}

function booleanError(
  field: SelfHealField,
  value: unknown,
): string | undefined {
  return typeof value === "boolean"
    ? undefined
    : `${field} must be true or false, or null (inherit)`;
}

function findFieldError(
  field: SelfHealField,
  value: unknown,
  isOrgDefaultRow: boolean,
): string | undefined {
  switch (field) {
    case "selfHealMode":
      return isSelfHealMode(value)
        ? undefined
        : `selfHealMode must be one of ${SELF_HEAL_MODES.join(", ")}, or null (inherit)`;
    case "selfHealKillSwitch": {
      const error = booleanError(field, value);
      if (error !== undefined) return error;
      return isOrgDefaultRow
        ? undefined
        : "selfHealKillSwitch is an org-level setting; set it on the org default";
    }
    case "selfHealMaxOpenIssues":
      return integerError(field, value, SELF_HEAL_BOUNDS.maxOpenIssues);
    case "selfHealMaxAttempts":
      return integerError(field, value, SELF_HEAL_BOUNDS.maxAttempts);
    case "selfHealCooldownMin":
      return integerError(field, value, SELF_HEAL_BOUNDS.cooldownMin);
    case "selfHealMinSeverity":
      return isSelfHealSeverity(value)
        ? undefined
        : `selfHealMinSeverity must be one of ${SELF_HEAL_SEVERITIES.join(", ")}, or null (inherit)`;
    case "selfHealAutoLabel":
      return booleanError(field, value);
    case "selfHealAbsentAudits":
      return integerError(field, value, SELF_HEAL_BOUNDS.absentAudits);
    case "selfHealMaxDiffLines":
      return integerError(field, value, SELF_HEAL_BOUNDS.maxDiffLines);
    case "selfHealPrExpiryDays":
      return integerError(field, value, SELF_HEAL_BOUNDS.prExpiryDays);
    case "selfHealRunWindow":
      return typeof value === "string" && parseRunWindow(value) !== null
        ? undefined
        : 'selfHealRunWindow must be "HH:MM-HH:MM" (UTC, start and end differ; wrap-around allowed), or null (inherit)';
  }
}

/**
 * The one validator for the self-heal family. Checks only the self-heal keys
 * present (not undefined, not null) in `patch`; other keys are ignored.
 * Returns the first error naming the field, or undefined when all are valid.
 */
export function findSelfHealFieldError(
  patch: Record<string, unknown>,
  options: { isOrgDefaultRow: boolean },
): string | undefined {
  for (const field of SELF_HEAL_FIELDS) {
    const value = patch[field];
    if (value === undefined || value === null) {
      continue;
    }
    const error = findFieldError(field, value, options.isOrgDefaultRow);
    if (error !== undefined) {
      return error;
    }
  }
  return undefined;
}

/** The self-heal fields of any row-shaped object, nothing else. */
export function pickSelfHealFields(
  row: Record<SelfHealField, unknown>,
): SelfHealValues {
  const picked: Record<string, unknown> = {};
  for (const field of SELF_HEAL_FIELDS) {
    picked[field] = row[field] ?? null;
  }
  // Every key of SELF_HEAL_FIELDS was assigned by the loop above; stored
  // values were validated at the write boundary.
  return picked as unknown as SelfHealValues;
}
