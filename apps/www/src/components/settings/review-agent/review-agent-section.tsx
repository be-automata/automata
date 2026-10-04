"use client";

import React, { useState } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";

import {
  DEFAULT_REVIEW_MODE,
  REVIEW_AGENT_FIELDS,
  REVIEW_BATTERY_PACK_IDS,
  REVIEW_COMMAND_TIMEOUT_S_MAX,
  REVIEW_COMMAND_TIMEOUT_S_MIN,
  REVIEW_MAX_TURNS_MAX,
  REVIEW_MAX_TURNS_MIN,
  REVIEW_MODES,
  isReviewMode,
  type ReviewBatteryPackId,
  type ReviewMode,
} from "@terragon/shared/model/review-agent-settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsSection } from "@/components/settings/settings-row";
import {
  useReviewSettingsQuery,
  useSetReviewSettingMutation,
} from "@/queries/review-settings-queries";
import {
  useSetSupersedeDefaultMutation,
  useSupersedeDefaultQuery,
} from "@/queries/supersede-policy-queries";
import { ConflictError } from "@/queries/error-from-response";
import { useUserReposQuery } from "@/queries/user-repo-queries";

/**
 * Phase 4 — "Review agent": the org-default review-agent settings (the '*'
 * sentinel row) and per-repo overrides. Every field offers "Inherit" (null).
 * Classic means exactly today's behaviour, so packs, run tests, timeout and
 * max turns only apply when the mode resolves to orchestrated — they are
 * disabled (values kept visible) under classic.
 *
 * Same shape as the supersede section: a PURE view (every state is a prop,
 * testable with renderToStaticMarkup), a model hook binding the queries and
 * mutations, and a thin container. A lost write race lands in one conflict
 * banner with Reload. Writes are permission-gated server-side.
 */

/** Short plain labels for the battery packs. */
export const REVIEW_BATTERY_PACK_LABELS: Record<ReviewBatteryPackId, string> = {
  "gstack-review": "gstack review",
  "somnio-review": "Somnio review",
  "gsd-reviewers": "GSD reviewers",
};

const REVIEW_MODE_LABELS: Record<ReviewMode, string> = {
  classic: "Classic",
  orchestrated: "Orchestrated",
};

export const MAX_TURNS_LABEL = "Max turns (lead agent)";
export const MAX_TURNS_NOTE =
  "Limits the lead reviewer's turns. Sub-agent turns are not counted, so this is not a cost limit.";
export const CLASSIC_HINT =
  "Only used in orchestrated mode. Classic runs exactly as today.";
export const RUN_TESTS_NOTE =
  "Pull requests from forks or untrusted authors never run tests.";

/** The orchestrated per-command timeout when nothing is set (seconds). */
const ORCHESTRATED_DEFAULT_TIMEOUT_S = 300;

/** The review-agent fields of a settings row (null = inherit). */
export interface ReviewAgentValues {
  reviewMode: ReviewMode | null;
  reviewBatteries: ReviewBatteryPackId[] | null;
  reviewRunTests: boolean | null;
  reviewCommandTimeoutS: number | null;
  reviewMaxTurns: number | null;
}

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
} as const;

const NO_VALUES: ReviewAgentValues = { ...REVIEW_AGENT_CLEAR_PATCH };

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

function sameList(
  a: readonly string[] | null,
  b: readonly string[] | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export const TIMEOUT_ERROR = `${REVIEW_COMMAND_TIMEOUT_S_MIN}-${REVIEW_COMMAND_TIMEOUT_S_MAX} seconds`;
export const MAX_TURNS_ERROR = `${REVIEW_MAX_TURNS_MIN}-${REVIEW_MAX_TURNS_MAX} turns`;

function parseRanged(
  text: string,
  min: number,
  max: number,
): number | null | undefined {
  const value = parseOptionalInt(text);
  if (value === null || value === undefined) return value;
  return value >= min && value <= max ? value : undefined;
}

/**
 * The patch a Save sends: only the fields that differ from the stored values.
 * Invalid number inputs yield an inline error per field and no save.
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
  if (!sameList(draft.reviewBatteries, stored.reviewBatteries)) {
    patch.reviewBatteries = draft.reviewBatteries;
  }
  if (draft.reviewRunTests !== stored.reviewRunTests) {
    patch.reviewRunTests = draft.reviewRunTests;
  }
  const timeout = parseRanged(
    draft.timeoutText,
    REVIEW_COMMAND_TIMEOUT_S_MIN,
    REVIEW_COMMAND_TIMEOUT_S_MAX,
  );
  const maxTurns = parseRanged(
    draft.maxTurnsText,
    REVIEW_MAX_TURNS_MIN,
    REVIEW_MAX_TURNS_MAX,
  );
  if (timeout !== undefined && timeout !== stored.reviewCommandTimeoutS) {
    patch.reviewCommandTimeoutS = timeout;
  }
  if (maxTurns !== undefined && maxTurns !== stored.reviewMaxTurns) {
    patch.reviewMaxTurns = maxTurns;
  }
  return {
    patch,
    ...(timeout === undefined ? { timeoutError: TIMEOUT_ERROR } : {}),
    ...(maxTurns === undefined ? { maxTurnsError: MAX_TURNS_ERROR } : {}),
  };
}

const INHERIT = "inherit";

/**
 * The five fields for one block. Pure: the draft is a prop. `inherited` is
 * what an "Inherit" choice resolves to — the org default for a repo row,
 * null (system defaults) for the org block.
 */
export function ReviewAgentFieldsView({
  idPrefix,
  scope,
  draft,
  stored,
  inherited,
  disabled,
  saveLabel,
  saveBlocked = false,
  onChange,
  onSave,
}: {
  idPrefix: string;
  scope: "org" | "repo";
  draft: ReviewAgentDraft;
  stored: ReviewAgentValues;
  inherited: ReviewAgentValues | null;
  disabled: boolean;
  saveLabel: string;
  /** Extra reason the Save button stays disabled (e.g. no repo picked). */
  saveBlocked?: boolean;
  onChange: (draft: ReviewAgentDraft) => void;
  onSave: (patch: ReviewAgentPatch) => void;
}) {
  const inheritedMode = effectiveReviewMode(null, inherited?.reviewMode);
  const mode = effectiveReviewMode(draft.reviewMode, inheritedMode);
  const orchestratedOnlyDisabled = disabled || mode === "classic";
  const inheritedBatteries = inherited?.reviewBatteries ?? [
    ...REVIEW_BATTERY_PACK_IDS,
  ];
  const shownBatteries = draft.reviewBatteries ?? inheritedBatteries;
  const inheritedRunTests = inherited?.reviewRunTests ?? false;
  const { patch, timeoutError, maxTurnsError } = draftToPatch(draft, stored);
  const canSave =
    !disabled &&
    !saveBlocked &&
    timeoutError === undefined &&
    maxTurnsError === undefined &&
    Object.keys(patch).length > 0;

  const modeLabel =
    draft.reviewMode === null
      ? `Inherit (${REVIEW_MODE_LABELS[inheritedMode].toLowerCase()})`
      : REVIEW_MODE_LABELS[draft.reviewMode];
  const runTestsLabel =
    draft.reviewRunTests === null
      ? `Inherit (${inheritedRunTests ? "on" : "off"})`
      : draft.reviewRunTests
        ? "On"
        : "Off";

  function togglePack(id: ReviewBatteryPackId, on: boolean) {
    const next = REVIEW_BATTERY_PACK_IDS.filter((pack) =>
      pack === id ? on : shownBatteries.includes(pack),
    );
    onChange({ ...draft, reviewBatteries: next });
  }

  return (
    <div className="grid gap-4" data-testid={`${idPrefix}-fields`}>
      <div className="grid gap-1">
        <Label htmlFor={`${idPrefix}-mode`}>Mode</Label>
        <Select
          value={draft.reviewMode ?? INHERIT}
          onValueChange={(v) =>
            onChange({ ...draft, reviewMode: isReviewMode(v) ? v : null })
          }
          disabled={disabled}
        >
          <SelectTrigger
            id={`${idPrefix}-mode`}
            className="min-h-11 w-full sm:w-64"
          >
            <SelectValue>{modeLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>
              {`Inherit (${REVIEW_MODE_LABELS[inheritedMode].toLowerCase()})`}
            </SelectItem>
            {REVIEW_MODES.map((value) => (
              <SelectItem key={value} value={value}>
                {REVIEW_MODE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {mode === "classic" && (
          <p
            className="text-xs text-muted-foreground"
            data-testid={`${idPrefix}-classic-hint`}
          >
            {CLASSIC_HINT}
          </p>
        )}
      </div>

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Review packs</legend>
        <div className="flex min-h-11 items-center gap-2">
          <Checkbox
            id={`${idPrefix}-packs-inherit`}
            checked={draft.reviewBatteries === null}
            onCheckedChange={(on) =>
              onChange({
                ...draft,
                reviewBatteries: on === true ? null : [...inheritedBatteries],
              })
            }
            disabled={orchestratedOnlyDisabled}
          />
          <Label htmlFor={`${idPrefix}-packs-inherit`} className="text-sm">
            {scope === "org" ? "Inherit (all packs)" : "Inherit (org default)"}
          </Label>
        </div>
        {REVIEW_BATTERY_PACK_IDS.map((id) => (
          <div key={id} className="flex min-h-11 items-center gap-2">
            <Checkbox
              id={`${idPrefix}-pack-${id}`}
              checked={shownBatteries.includes(id)}
              onCheckedChange={(on) => togglePack(id, on === true)}
              disabled={orchestratedOnlyDisabled}
            />
            <Label htmlFor={`${idPrefix}-pack-${id}`} className="text-sm">
              {REVIEW_BATTERY_PACK_LABELS[id]}
            </Label>
          </div>
        ))}
      </fieldset>

      <div className="grid gap-1">
        <Label htmlFor={`${idPrefix}-run-tests`}>Run tests</Label>
        <Select
          value={
            draft.reviewRunTests === null
              ? INHERIT
              : draft.reviewRunTests
                ? "on"
                : "off"
          }
          onValueChange={(v) =>
            onChange({
              ...draft,
              reviewRunTests: v === INHERIT ? null : v === "on",
            })
          }
          disabled={orchestratedOnlyDisabled}
        >
          <SelectTrigger
            id={`${idPrefix}-run-tests`}
            className="min-h-11 w-full sm:w-64"
          >
            <SelectValue>{runTestsLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>
              {`Inherit (${inheritedRunTests ? "on" : "off"})`}
            </SelectItem>
            <SelectItem value="on">On</SelectItem>
            <SelectItem value="off">Off</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{RUN_TESTS_NOTE}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label htmlFor={`${idPrefix}-timeout`}>
            Command timeout (seconds)
          </Label>
          <Input
            id={`${idPrefix}-timeout`}
            inputMode="numeric"
            className="min-h-11"
            value={draft.timeoutText}
            placeholder={String(
              inherited?.reviewCommandTimeoutS ??
                ORCHESTRATED_DEFAULT_TIMEOUT_S,
            )}
            onChange={(e) =>
              onChange({ ...draft, timeoutText: e.target.value })
            }
            disabled={orchestratedOnlyDisabled}
            aria-invalid={timeoutError !== undefined}
          />
          {timeoutError !== undefined && (
            <p
              className="text-xs text-destructive"
              data-testid={`${idPrefix}-timeout-error`}
            >
              {timeoutError}
            </p>
          )}
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${idPrefix}-max-turns`}>{MAX_TURNS_LABEL}</Label>
          <Input
            id={`${idPrefix}-max-turns`}
            inputMode="numeric"
            className="min-h-11"
            value={draft.maxTurnsText}
            placeholder={
              inherited?.reviewMaxTurns != null
                ? String(inherited.reviewMaxTurns)
                : "unset"
            }
            onChange={(e) =>
              onChange({ ...draft, maxTurnsText: e.target.value })
            }
            disabled={orchestratedOnlyDisabled}
            aria-invalid={maxTurnsError !== undefined}
          />
          <p className="text-xs text-muted-foreground">{MAX_TURNS_NOTE}</p>
          {maxTurnsError !== undefined && (
            <p
              className="text-xs text-destructive"
              data-testid={`${idPrefix}-max-turns-error`}
            >
              {maxTurnsError}
            </p>
          )}
        </div>
      </div>

      <div>
        <Button
          size="sm"
          className="min-h-11"
          id={`${idPrefix}-save`}
          disabled={!canSave}
          onClick={() => onSave(patch)}
        >
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

/** Stateful wrapper: holds the draft for one block. Remount (key) on new data. */
function ReviewAgentEditor({
  idPrefix,
  scope,
  stored,
  inherited,
  disabled,
  saveLabel,
  onSave,
}: {
  idPrefix: string;
  scope: "org" | "repo";
  stored: ReviewAgentValues;
  inherited: ReviewAgentValues | null;
  disabled: boolean;
  saveLabel: string;
  onSave: (patch: ReviewAgentPatch) => void;
}) {
  const [draft, setDraft] = useState(() => draftFromValues(stored));
  return (
    <ReviewAgentFieldsView
      idPrefix={idPrefix}
      scope={scope}
      draft={draft}
      stored={stored}
      inherited={inherited}
      disabled={disabled}
      saveLabel={saveLabel}
      onChange={setDraft}
      onSave={onSave}
    />
  );
}

export type ReviewAgentSectionState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      orgDefault: ReviewAgentValues;
      /** Version of the stored org-default row, for remounting the editor. */
      orgDefaultVersion: string | null;
      /** Another admin saved between our read and write. */
      conflict: boolean;
      saving: boolean;
      overridesLoading: boolean;
      overrides: ReviewAgentOverrideRow[];
      /** Repos the caller can add a FIRST review-agent override for. */
      availableRepos: string[];
    };

export interface ReviewAgentSectionActions {
  onSaveDefault: (patch: ReviewAgentPatch) => void;
  onSaveOverride: (
    row: ReviewAgentOverrideRow,
    patch: ReviewAgentPatch,
  ) => void;
  onRestoreDefault: (row: ReviewAgentOverrideRow) => void;
  onAddOverride: (repoFullName: string, patch: ReviewAgentPatch) => void;
  onReload: () => void;
}

export function ReviewAgentSectionView({
  state,
  actions,
}: {
  state: ReviewAgentSectionState;
  actions: ReviewAgentSectionActions;
}) {
  return (
    <SettingsSection
      label="Review agent"
      description="How the PR review agent runs. Repos inherit the org default unless overridden. Changes apply to new review runs."
    >
      {state.kind === "loading" ? (
        <div className="grid gap-2" data-testid="review-agent-skeleton">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : state.kind === "error" ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Couldn&apos;t load the review agent settings</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : (
        <>
          {state.conflict && (
            <Alert role="status" data-testid="review-agent-conflict">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Another admin just saved changes</AlertTitle>
              <AlertDescription className="flex items-center gap-2">
                Your change was not applied. Reload to see the latest before
                editing again.
                <Button size="sm" variant="outline" onClick={actions.onReload}>
                  Reload
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <div className="rounded-md border p-3">
            <h4 className="mb-3 text-sm font-medium">Org default</h4>
            <ReviewAgentEditor
              key={state.orgDefaultVersion ?? "none"}
              idPrefix="review-agent-org"
              scope="org"
              stored={state.orgDefault}
              inherited={null}
              disabled={state.saving}
              saveLabel="Save org default"
              onSave={actions.onSaveDefault}
            />
          </div>
          <div className="mt-6">
            <h4 className="text-sm font-medium">Repo overrides</h4>
            {state.overridesLoading ? (
              <Skeleton className="mt-2 h-12 w-full" />
            ) : state.overrides.length === 0 ? (
              <p
                className="mt-2 text-sm text-muted-foreground"
                data-testid="review-agent-overrides-empty"
              >
                All your repos use the org default. Add an override below to
                give one repo its own review agent settings.
              </p>
            ) : (
              <ul className="mt-2 grid gap-2">
                {state.overrides.map((row) => (
                  <li
                    key={row.repoFullName}
                    className="grid gap-3 rounded-md border p-3"
                    data-testid="review-agent-override"
                  >
                    <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_auto_auto]">
                      <span className="truncate font-mono text-sm">
                        {row.repoFullName}
                      </span>
                      <span className="w-fit rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        Repo override
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-11 justify-self-start sm:justify-self-auto"
                        onClick={() => actions.onRestoreDefault(row)}
                        disabled={state.saving}
                      >
                        <RotateCcw className="mr-1 h-3 w-3" aria-hidden />
                        Restore default
                      </Button>
                    </div>
                    <ReviewAgentEditor
                      key={row.updatedAt}
                      idPrefix={`review-agent-repo-${row.repoFullName}`}
                      scope="repo"
                      stored={row}
                      inherited={state.orgDefault}
                      disabled={state.saving}
                      saveLabel="Save override"
                      onSave={(patch) => actions.onSaveOverride(row, patch)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {!state.overridesLoading && (
              <AddReviewAgentOverride
                repos={state.availableRepos}
                inherited={state.orgDefault}
                disabled={state.saving}
                onAdd={actions.onAddOverride}
              />
            )}
          </div>
        </>
      )}
    </SettingsSection>
  );
}

/** Create a repo's FIRST review-agent override: pick a repo, set fields, Add. */
function AddReviewAgentOverride({
  repos,
  inherited,
  disabled,
  onAdd,
}: {
  repos: string[];
  inherited: ReviewAgentValues;
  disabled: boolean;
  onAdd: (repoFullName: string, patch: ReviewAgentPatch) => void;
}) {
  const [repo, setRepo] = useState("");
  const [draft, setDraft] = useState(() => draftFromValues(NO_VALUES));
  if (repos.length === 0) return null;
  return (
    <div
      className="mt-3 grid gap-3 rounded-md border border-dashed p-3"
      data-testid="review-agent-add-override"
    >
      <Select value={repo} onValueChange={setRepo} disabled={disabled}>
        <SelectTrigger
          className="min-h-11 w-full"
          aria-label="Repository to add a review agent override for"
        >
          <SelectValue placeholder="Choose a repository…" />
        </SelectTrigger>
        <SelectContent>
          {repos.map((r) => (
            <SelectItem key={r} value={r}>
              {r}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ReviewAgentFieldsView
        idPrefix="review-agent-add"
        scope="repo"
        draft={draft}
        stored={NO_VALUES}
        inherited={inherited}
        disabled={disabled}
        saveLabel="Add override"
        saveBlocked={repo === ""}
        onChange={setDraft}
        onSave={(patch) => {
          onAdd(repo, patch);
          setRepo("");
          setDraft(draftFromValues(NO_VALUES));
        }}
      />
    </div>
  );
}

/** Binds the queries/mutations; returns the view's state and actions. */
export function useReviewAgentSectionModel(): {
  state: ReviewAgentSectionState;
  actions: ReviewAgentSectionActions;
} {
  const defaultQuery = useSupersedeDefaultQuery();
  const listQuery = useReviewSettingsQuery();
  const reposQuery = useUserReposQuery();
  const setDefault = useSetSupersedeDefaultMutation({
    successMessage:
      "Org review agent default saved. Applies to new review runs.",
  });
  const setOverride = useSetReviewSettingMutation({
    successMessage: "Repo override saved. Applies to new review runs.",
  });
  // Restore default clears the override, so it must not claim one was saved.
  const restoreOverride = useSetReviewSettingMutation({
    successMessage:
      "Repo override removed. The org default applies to new review runs.",
  });
  const [conflict, setConflict] = useState(false);

  const stored = defaultQuery.data ?? null;
  const list = listQuery.data ?? [];

  const onConflict = (error: unknown) => {
    if (error instanceof ConflictError) setConflict(true);
  };

  function saveOverride(
    row: ReviewAgentOverrideRow,
    patch: ReviewAgentPatch,
    mutation: typeof setOverride,
  ) {
    setConflict(false);
    mutation.mutate(
      {
        repoFullName: row.repoFullName,
        patch: { ...patch, expectedUpdatedAt: row.updatedAt },
      },
      { onError: onConflict },
    );
  }

  const state: ReviewAgentSectionState = defaultQuery.isLoading
    ? { kind: "loading" }
    : defaultQuery.isError
      ? {
          kind: "error",
          message:
            defaultQuery.error instanceof Error
              ? defaultQuery.error.message
              : "Something went wrong. Reload the page to try again.",
        }
      : {
          kind: "ready",
          orgDefault: stored
            ? {
                reviewMode: stored.reviewMode,
                reviewBatteries: stored.reviewBatteries,
                reviewRunTests: stored.reviewRunTests,
                reviewCommandTimeoutS: stored.reviewCommandTimeoutS,
                reviewMaxTurns: stored.reviewMaxTurns,
              }
            : NO_VALUES,
          orgDefaultVersion: stored?.updatedAt ?? null,
          conflict,
          // Every writer must be here: a separate mutation instance left out
          // keeps the controls live during its write, and a double-click then
          // self-409s (the supersede section's lesson).
          saving:
            setDefault.isPending ||
            setOverride.isPending ||
            restoreOverride.isPending,
          overridesLoading: listQuery.isLoading,
          overrides: reviewAgentOverrides(list),
          availableRepos: availableReviewAgentRepos(
            (reposQuery.data?.repos ?? []).map((r) => r.full_name),
            list,
          ),
        };

  const actions: ReviewAgentSectionActions = {
    onSaveDefault: (patch) => {
      setConflict(false);
      setDefault.mutate(
        // No stored default yet ⇒ the null first-write fence.
        { ...patch, expectedUpdatedAt: stored ? stored.updatedAt : null },
        { onError: onConflict },
      );
    },
    onSaveOverride: (row, patch) => saveOverride(row, patch, setOverride),
    onRestoreDefault: (row) =>
      saveOverride(row, REVIEW_AGENT_CLEAR_PATCH, restoreOverride),
    onAddOverride: (repoFullName, patch) => {
      setConflict(false);
      setOverride.mutate(
        {
          repoFullName,
          // Row exists for another family → its version; no row → null, the
          // whole-row first-write fence.
          patch: {
            ...patch,
            expectedUpdatedAt: firstWriteFence(repoFullName, list),
          },
        },
        { onError: onConflict },
      );
    },
    onReload: () => {
      setConflict(false);
      void defaultQuery.refetch();
      void listQuery.refetch();
    },
  };

  return { state, actions };
}

/** Thin container: binds the model to the pure view. */
export function ReviewAgentSection() {
  const { state, actions } = useReviewAgentSectionModel();
  return <ReviewAgentSectionView state={state} actions={actions} />;
}
