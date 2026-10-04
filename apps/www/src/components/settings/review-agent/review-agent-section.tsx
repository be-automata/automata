"use client";

import React, { useMemo, useState } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";

import {
  DEFAULT_REVIEW_BATTERIES,
  DEFAULT_REVIEW_RUN_TESTS,
  REVIEW_BATTERY_PACK_IDS,
  REVIEW_BATTERY_PACK_LABELS,
  REVIEW_MODES,
  REVIEW_MODE_LABELS,
  effectiveReviewMode,
  pickReviewAgentFields,
  type ReviewAgentValues,
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
  ConflictBanner,
  RepoOverrideBadge,
  RepoPickerSelect,
} from "@/components/settings/review-settings-parts";
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
import {
  NO_REVIEW_AGENT_VALUES,
  NUMBER_FIELDS,
  REVIEW_AGENT_CLEAR_PATCH,
  availableReviewAgentRepos,
  draftFromValues,
  draftToPatch,
  firstWriteFence,
  reviewAgentOverrides,
  type NumberFieldSpec,
  type ReviewAgentDraft,
  type ReviewAgentOverrideRow,
  type ReviewAgentPatch,
} from "./review-agent-form";

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
 * banner with Reload. Writes are permission-gated server-side. The pure form
 * logic lives in review-agent-form.ts.
 */

export const CLASSIC_HINT =
  "Only used in orchestrated mode. Classic runs exactly as today.";
export const RUN_TESTS_NOTE =
  "Pull requests from forks or untrusted authors never run tests.";

const INHERIT = "inherit";

/** A Select whose first option is "Inherit (…)" (null); the rest are values. */
function InheritSelect<T extends string>({
  id,
  label,
  value,
  options,
  inheritLabel,
  disabled,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: T | null;
  options: readonly { value: T; label: string }[];
  inheritLabel: string;
  disabled: boolean;
  onChange: (value: T | null) => void;
  /** Hints rendered under the select. */
  children?: React.ReactNode;
}) {
  const shown =
    value === null
      ? inheritLabel
      : (options.find((option) => option.value === value)?.label ?? value);
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value ?? INHERIT}
        onValueChange={(v) =>
          onChange(options.find((option) => option.value === v)?.value ?? null)
        }
        disabled={disabled}
      >
        <SelectTrigger id={id} className="min-h-11 w-full sm:w-64">
          <SelectValue>{shown}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT}>{inheritLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {children}
    </div>
  );
}

/** One free-text number field from the NUMBER_FIELDS table. */
function NumberField({
  idPrefix,
  spec,
  text,
  inherited,
  error,
  disabled,
  onChange,
}: {
  idPrefix: string;
  spec: NumberFieldSpec;
  text: string;
  inherited: ReviewAgentValues | null;
  error: string | undefined;
  disabled: boolean;
  onChange: (text: string) => void;
}) {
  const id = `${idPrefix}-${spec.idSuffix}`;
  const placeholder = inherited?.[spec.field] ?? spec.systemDefault;
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{spec.label}</Label>
      <Input
        id={id}
        inputMode="numeric"
        className="min-h-11"
        value={text}
        placeholder={placeholder === null ? "unset" : String(placeholder)}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-invalid={error !== undefined}
      />
      {spec.note !== undefined && (
        <p className="text-xs text-muted-foreground">{spec.note}</p>
      )}
      {error !== undefined && (
        <p className="text-xs text-destructive" data-testid={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

const MODE_OPTIONS = REVIEW_MODES.map((value) => ({
  value,
  label: REVIEW_MODE_LABELS[value],
}));

const RUN_TESTS_OPTIONS = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const;

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
  const inheritedMode: ReviewMode = effectiveReviewMode(
    null,
    inherited?.reviewMode,
  );
  const mode = effectiveReviewMode(draft.reviewMode, inheritedMode);
  const orchestratedOnlyDisabled = disabled || mode === "classic";
  const inheritedBatteries = inherited?.reviewBatteries ?? [
    ...DEFAULT_REVIEW_BATTERIES,
  ];
  const shownBatteries = draft.reviewBatteries ?? inheritedBatteries;
  const inheritedRunTests =
    inherited?.reviewRunTests ?? DEFAULT_REVIEW_RUN_TESTS;
  const result = draftToPatch(draft, stored);
  const { patch } = result;
  const canSave =
    !disabled &&
    !saveBlocked &&
    NUMBER_FIELDS.every((spec) => result[spec.errorKey] === undefined) &&
    Object.keys(patch).length > 0;

  function togglePack(id: ReviewBatteryPackId, on: boolean) {
    const next = REVIEW_BATTERY_PACK_IDS.filter((pack) =>
      pack === id ? on : shownBatteries.includes(pack),
    );
    onChange({ ...draft, reviewBatteries: next });
  }

  return (
    <div className="grid gap-4" data-testid={`${idPrefix}-fields`}>
      <InheritSelect
        id={`${idPrefix}-mode`}
        label="Mode"
        value={draft.reviewMode}
        options={MODE_OPTIONS}
        inheritLabel={`Inherit (${REVIEW_MODE_LABELS[inheritedMode].toLowerCase()})`}
        disabled={disabled}
        onChange={(reviewMode) => onChange({ ...draft, reviewMode })}
      >
        {mode === "classic" && (
          <p
            className="text-xs text-muted-foreground"
            data-testid={`${idPrefix}-classic-hint`}
          >
            {CLASSIC_HINT}
          </p>
        )}
      </InheritSelect>

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

      <InheritSelect
        id={`${idPrefix}-run-tests`}
        label="Run tests"
        value={
          draft.reviewRunTests === null
            ? null
            : draft.reviewRunTests
              ? "on"
              : "off"
        }
        options={RUN_TESTS_OPTIONS}
        inheritLabel={`Inherit (${inheritedRunTests ? "on" : "off"})`}
        disabled={orchestratedOnlyDisabled}
        onChange={(v) =>
          onChange({ ...draft, reviewRunTests: v === null ? null : v === "on" })
        }
      >
        <p className="text-xs text-muted-foreground">{RUN_TESTS_NOTE}</p>
      </InheritSelect>

      <div className="grid gap-4 sm:grid-cols-2">
        {NUMBER_FIELDS.map((spec) => (
          <NumberField
            key={spec.field}
            idPrefix={idPrefix}
            spec={spec}
            text={draft[spec.textKey]}
            inherited={inherited}
            error={result[spec.errorKey]}
            disabled={orchestratedOnlyDisabled}
            onChange={(text) => onChange({ ...draft, [spec.textKey]: text })}
          />
        ))}
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
            <ConflictBanner
              testId="review-agent-conflict"
              onReload={actions.onReload}
            />
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
                      <RepoOverrideBadge />
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
  const [draft, setDraft] = useState(() =>
    draftFromValues(NO_REVIEW_AGENT_VALUES),
  );
  if (repos.length === 0) return null;
  return (
    <div
      className="mt-3 grid gap-3 rounded-md border border-dashed p-3"
      data-testid="review-agent-add-override"
    >
      <RepoPickerSelect
        repos={repos}
        value={repo}
        onChange={setRepo}
        disabled={disabled}
        ariaLabel="Repository to add a review agent override for"
      />
      <ReviewAgentFieldsView
        idPrefix="review-agent-add"
        scope="repo"
        draft={draft}
        stored={NO_REVIEW_AGENT_VALUES}
        inherited={inherited}
        disabled={disabled}
        saveLabel="Add override"
        saveBlocked={repo === ""}
        onChange={setDraft}
        onSave={(patch) => {
          onAdd(repo, patch);
          setRepo("");
          setDraft(draftFromValues(NO_REVIEW_AGENT_VALUES));
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
  const list = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const visibleRepos = reposQuery.data?.repos;
  const overrides = useMemo(() => reviewAgentOverrides(list), [list]);
  const availableRepos = useMemo(
    () =>
      availableReviewAgentRepos(
        (visibleRepos ?? []).map((r) => r.full_name),
        list,
      ),
    [visibleRepos, list],
  );

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
            ? pickReviewAgentFields(stored)
            : NO_REVIEW_AGENT_VALUES,
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
          overrides,
          availableRepos,
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
