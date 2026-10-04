import isEqual from "fast-deep-equal";

import {
  REVIEW_AGENT_FIELDS,
  REVIEW_COMMAND_TIMEOUT_S_MAX,
  REVIEW_COMMAND_TIMEOUT_S_MIN,
  REVIEW_MAX_TURNS_MAX,
  REVIEW_MAX_TURNS_MIN,
  REVIEW_ORCHESTRATED_COMMAND_TIMEOUT_S_DEFAULT,
  findReviewAgentFieldError,
  type ReviewAgentValues,
  type ReviewBatteryPackId,
  type ReviewMode,
} from "@terragon/shared/model/review-agent-settings";
import {
  availableRepoNames,
  findSettingByRepo,
} from "@/lib/review-settings-rows";

/**
 * Pure form logic of the "Review agent" settings section: draft state, the
 * patch a Save sends, and the override-list helpers. No React here.
 */

/** A write: only the fields being changed; null clears (= inherit). */
export type ReviewAgentPatch = Partial<ReviewAgentValues>;

export interface ReviewAgentOverrideRow extends ReviewAgentValues {
  repoFullName: string;
  updatedAt: string;
}

/** "Restore default": clear all five fields back to inherit. */
export const REVIEW_AGENT_CLEAR_PATCH = {
  reviewMode: null,
  reviewBatteries: null,
  reviewRunTests: null,
  reviewCommandTimeoutS: null,
  reviewMaxTurns: null,
} as const satisfies ReviewAgentValues;

export const NO_REVIEW_AGENT_VALUES: ReviewAgentValues = {
  ...REVIEW_AGENT_CLEAR_PATCH,
};

export const MAX_TURNS_LABEL = "Max turns (lead agent)";
export const MAX_TURNS_NOTE =
  "Limits the lead reviewer's turns. Sub-agent turns are not counted, so this is not a cost limit.";

/** True when the row carries at least one review-agent override (an empty pack list counts). */
export function hasReviewAgentOverride(row: ReviewAgentValues): boolean {
  return REVIEW_AGENT_FIELDS.some((field) => row[field] !== null);
}

/** Rows carrying at least one review-agent override. */
export function reviewAgentOverrides<T extends ReviewAgentValues>(
  settings: readonly T[],
): T[] {
  return settings.filter(hasReviewAgentOverride);
}

/** Repos the "Add override" picker may offer (no review-agent override yet). */
export function availableReviewAgentRepos(
  repoFullNames: readonly string[],
  settings: readonly (ReviewAgentValues & { repoFullName: string })[],
): string[] {
  return availableRepoNames(repoFullNames, settings, hasReviewAgentOverride);
}

/**
 * The fence for a repo's first review-agent write: the row's version when a
 * row exists for another family, else null (the whole-row first-write fence).
 */
export function firstWriteFence(
  repoFullName: string,
  settings: readonly { repoFullName: string; updatedAt: string }[],
): string | null {
  return findSettingByRepo(settings, repoFullName)?.updatedAt ?? null;
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

/** Editable form state for one block (org default or one repo). */
export interface ReviewAgentDraft {
  reviewMode: ReviewMode | null;
  reviewBatteries: ReviewBatteryPackId[] | null;
  reviewRunTests: boolean | null;
  timeoutText: string;
  maxTurnsText: string;
}

export function draftFromValues(values: ReviewAgentValues): ReviewAgentDraft {
  return {
    reviewMode: values.reviewMode,
    reviewBatteries: values.reviewBatteries,
    reviewRunTests: values.reviewRunTests,
    timeoutText: values.reviewCommandTimeoutS?.toString() ?? "",
    maxTurnsText: values.reviewMaxTurns?.toString() ?? "",
  };
}

/** The two free-text number fields, driven by one table. */
export interface NumberFieldSpec {
  field: "reviewCommandTimeoutS" | "reviewMaxTurns";
  textKey: "timeoutText" | "maxTurnsText";
  errorKey: "timeoutError" | "maxTurnsError";
  idSuffix: string;
  label: string;
  note?: string;
  /** Shown as the placeholder when nothing is inherited; null = "unset". */
  systemDefault: number | null;
  /** Inline error copy for an invalid input. */
  error: string;
}

export const NUMBER_FIELDS: readonly NumberFieldSpec[] = [
  {
    field: "reviewCommandTimeoutS",
    textKey: "timeoutText",
    errorKey: "timeoutError",
    idSuffix: "timeout",
    label: "Command timeout (seconds)",
    systemDefault: REVIEW_ORCHESTRATED_COMMAND_TIMEOUT_S_DEFAULT,
    error: `${REVIEW_COMMAND_TIMEOUT_S_MIN}-${REVIEW_COMMAND_TIMEOUT_S_MAX} seconds`,
  },
  {
    field: "reviewMaxTurns",
    textKey: "maxTurnsText",
    errorKey: "maxTurnsError",
    idSuffix: "max-turns",
    label: MAX_TURNS_LABEL,
    note: MAX_TURNS_NOTE,
    systemDefault: null,
    error: `${REVIEW_MAX_TURNS_MIN}-${REVIEW_MAX_TURNS_MAX} turns`,
  },
];

/**
 * The patch a Save sends: only the fields that differ from the stored values.
 * Invalid number inputs (not a whole number, or out of range per the shared
 * validator) yield an inline error per field and are not sent.
 */
export function draftToPatch(
  draft: ReviewAgentDraft,
  stored: ReviewAgentValues,
): {
  patch: ReviewAgentPatch;
  timeoutError?: string;
  maxTurnsError?: string;
} {
  const patch: ReviewAgentPatch = {};
  if (draft.reviewMode !== stored.reviewMode) {
    patch.reviewMode = draft.reviewMode;
  }
  if (!isEqual(draft.reviewBatteries, stored.reviewBatteries)) {
    patch.reviewBatteries = draft.reviewBatteries;
  }
  if (draft.reviewRunTests !== stored.reviewRunTests) {
    patch.reviewRunTests = draft.reviewRunTests;
  }
  const errors: { timeoutError?: string; maxTurnsError?: string } = {};
  for (const spec of NUMBER_FIELDS) {
    const value = parseOptionalInt(draft[spec.textKey]);
    if (
      value === undefined ||
      findReviewAgentFieldError({ [spec.field]: value }) !== undefined
    ) {
      errors[spec.errorKey] = spec.error;
    } else if (value !== stored[spec.field]) {
      patch[spec.field] = value;
    }
  }
  return { patch, ...errors };
}
