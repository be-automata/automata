import {
  SELF_HEAL_BOUNDS,
  SELF_HEAL_CLEAR_PATCH,
  SELF_HEAL_FIELDS,
  parseRunWindow,
  type SelfHealField,
  type SelfHealMode,
  type SelfHealRange,
  type SelfHealSeverity,
  type SelfHealValues,
} from "@terragon/shared/model/self-heal-settings";

/**
 * Pure form logic of the "Self-heal" settings section (phase 8, D1): draft
 * state and the patch a Save sends. No React here. There is deliberately no
 * gate-command and no spend field (GATE-01, no spend limits).
 */

export { SELF_HEAL_CLEAR_PATCH };

/** A write: only the fields being changed; null clears (= inherit). */
export type SelfHealPatch = Partial<SelfHealValues>;

export interface SelfHealOverrideRow extends SelfHealValues {
  repoFullName: string;
  updatedAt: string;
}

export const INHERIT = "inherit";
export type Inherit = typeof INHERIT;
export type OnOff = "on" | "off";

/** Editable form state for one block. Numbers and the window are text. */
export interface SelfHealDraft {
  mode: SelfHealMode | Inherit;
  killSwitch: OnOff | Inherit;
  maxOpenIssues: string;
  maxAttempts: string;
  cooldownMin: string;
  minSeverity: SelfHealSeverity | Inherit;
  autoLabel: OnOff | Inherit;
  absentAudits: string;
  maxDiffLines: string;
  prExpiryDays: string;
  runWindow: string;
}

export interface SelfHealFieldError {
  field: SelfHealField;
  message: string;
}

export type SelfHealDraftResult =
  | { patch: SelfHealPatch }
  | { error: SelfHealFieldError };

function boolToDraft(value: boolean | null): OnOff | Inherit {
  return value === null ? INHERIT : value ? "on" : "off";
}

function draftToBool(value: OnOff | Inherit): boolean | null {
  return value === INHERIT ? null : value === "on";
}

export function selfHealDraftFromValues(values: SelfHealValues): SelfHealDraft {
  return {
    mode: values.selfHealMode ?? INHERIT,
    killSwitch: boolToDraft(values.selfHealKillSwitch),
    maxOpenIssues: values.selfHealMaxOpenIssues?.toString() ?? "",
    maxAttempts: values.selfHealMaxAttempts?.toString() ?? "",
    cooldownMin: values.selfHealCooldownMin?.toString() ?? "",
    minSeverity: values.selfHealMinSeverity ?? INHERIT,
    autoLabel: boolToDraft(values.selfHealAutoLabel),
    absentAudits: values.selfHealAbsentAudits?.toString() ?? "",
    maxDiffLines: values.selfHealMaxDiffLines?.toString() ?? "",
    prExpiryDays: values.selfHealPrExpiryDays?.toString() ?? "",
    runWindow: values.selfHealRunWindow ?? "",
  };
}

export const NO_SELF_HEAL_VALUES: SelfHealValues = { ...SELF_HEAL_CLEAR_PATCH };

type NumberDraftKey =
  | "maxOpenIssues"
  | "maxAttempts"
  | "cooldownMin"
  | "absentAudits"
  | "maxDiffLines"
  | "prExpiryDays";

interface NumberSpec {
  draftKey: NumberDraftKey;
  field: SelfHealField &
    (
      | "selfHealMaxOpenIssues"
      | "selfHealMaxAttempts"
      | "selfHealCooldownMin"
      | "selfHealAbsentAudits"
      | "selfHealMaxDiffLines"
      | "selfHealPrExpiryDays"
    );
  range: SelfHealRange;
}

export const SELF_HEAL_NUMBER_SPECS: readonly NumberSpec[] = [
  {
    draftKey: "maxOpenIssues",
    field: "selfHealMaxOpenIssues",
    range: SELF_HEAL_BOUNDS.maxOpenIssues,
  },
  {
    draftKey: "maxAttempts",
    field: "selfHealMaxAttempts",
    range: SELF_HEAL_BOUNDS.maxAttempts,
  },
  {
    draftKey: "cooldownMin",
    field: "selfHealCooldownMin",
    range: SELF_HEAL_BOUNDS.cooldownMin,
  },
  {
    draftKey: "absentAudits",
    field: "selfHealAbsentAudits",
    range: SELF_HEAL_BOUNDS.absentAudits,
  },
  {
    draftKey: "maxDiffLines",
    field: "selfHealMaxDiffLines",
    range: SELF_HEAL_BOUNDS.maxDiffLines,
  },
  {
    draftKey: "prExpiryDays",
    field: "selfHealPrExpiryDays",
    range: SELF_HEAL_BOUNDS.prExpiryDays,
  },
];

export const RUN_WINDOW_ERROR =
  "Use HH:MM-HH:MM (UTC); start and end must differ";

export function rangeError(range: SelfHealRange): string {
  return `${range.min}-${range.max}`;
}

/** Empty -> null (inherit); a whole number in range -> it; else undefined. */
function parseBoundedInt(
  text: string,
  range: SelfHealRange,
): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= range.min && value <= range.max ? value : undefined;
}

/**
 * The patch a Save sends: every self-heal field (inherit -> null). The org
 * scope may carry the kill switch; the repo scope never does (KILL-01).
 * An out-of-range number or malformed window yields a field error instead.
 */
export function selfHealDraftToPatch(
  draft: SelfHealDraft,
  options: { scope: "org" | "repo" },
): SelfHealDraftResult {
  const patch: SelfHealPatch = {
    selfHealMode: draft.mode === INHERIT ? null : draft.mode,
    selfHealMinSeverity:
      draft.minSeverity === INHERIT ? null : draft.minSeverity,
    selfHealAutoLabel: draftToBool(draft.autoLabel),
  };
  if (options.scope === "org") {
    patch.selfHealKillSwitch = draftToBool(draft.killSwitch);
  }
  for (const spec of SELF_HEAL_NUMBER_SPECS) {
    const value = parseBoundedInt(draft[spec.draftKey], spec.range);
    if (value === undefined) {
      return {
        error: { field: spec.field, message: rangeError(spec.range) },
      };
    }
    patch[spec.field] = value;
  }
  const window = draft.runWindow.trim();
  if (window === "") {
    patch.selfHealRunWindow = null;
  } else if (parseRunWindow(window) === null) {
    return { error: { field: "selfHealRunWindow", message: RUN_WINDOW_ERROR } };
  } else {
    patch.selfHealRunWindow = window;
  }
  return { patch };
}

/** The fields of `patch` that differ from `stored` (a Save sends only these). */
export function changedSelfHealFields(
  patch: SelfHealPatch,
  stored: SelfHealValues,
): SelfHealPatch {
  const changed: Record<string, unknown> = {};
  for (const field of SELF_HEAL_FIELDS) {
    const next = patch[field];
    if (next !== undefined && next !== stored[field]) {
      changed[field] = next;
    }
  }
  return changed;
}

/** True when the row carries at least one self-heal override. */
export function hasSelfHealOverride(values: SelfHealValues): boolean {
  return SELF_HEAL_FIELDS.some((field) => values[field] !== null);
}

/** Rows carrying at least one self-heal override. */
export function selfHealOverrides<T extends SelfHealValues>(
  settings: readonly T[],
): T[] {
  return settings.filter(hasSelfHealOverride);
}
