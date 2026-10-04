"use client";

import React, { useMemo, useState } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";

import {
  SELF_HEAL_DEFAULTS,
  SELF_HEAL_MODES,
  SELF_HEAL_SEVERITIES,
  pickSelfHealFields,
  type SelfHealField,
  type SelfHealMode,
  type SelfHealSeverity,
  type SelfHealValues,
} from "@terragon/shared/model/self-heal-settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsSection } from "@/components/settings/settings-row";
import {
  ConflictBanner,
  RepoOverrideBadge,
  RepoPickerSelect,
} from "@/components/settings/review-settings-parts";
import { InheritSelect } from "@/components/settings/review-agent/review-agent-section";
import { SelfHealActivity } from "./self-heal-activity";
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
  availableRepoNames,
  findSettingByRepo,
} from "@/lib/review-settings-rows";
import {
  INHERIT,
  NO_SELF_HEAL_VALUES,
  SELF_HEAL_CLEAR_PATCH,
  SELF_HEAL_NUMBER_SPECS,
  changedSelfHealFields,
  hasSelfHealOverride,
  selfHealDraftFromValues,
  selfHealDraftToPatch,
  selfHealOverrides,
  type OnOff,
  type SelfHealDraft,
  type SelfHealOverrideRow,
  type SelfHealPatch,
} from "./self-heal-form";

/**
 * Phase 8 — "Self-heal": the org-default self-heal settings (the '*' sentinel
 * row) and per-repo overrides. Every field offers "Inherit" (null). The kill
 * switch exists at org scope only (KILL-01). There is no gate-command control
 * and no spend control by design.
 *
 * Same shape as the review-agent section: a PURE view (every state is a prop,
 * testable with renderToStaticMarkup), a model hook binding the queries and
 * mutations, and a thin container.
 */

export const SELF_HEAL_ON_PRECONDITIONS_NOTE =
  "On files issues on GitHub. It also needs: the selfHealLoop flag on (admin page) and the GitHub App with issues: write. Branch protection is optional. Nothing is ever merged automatically.";

export const KILL_SWITCH_NOTE =
  "Stops every self-heal effect for every repo in this organization";

const MODE_LABELS: Record<SelfHealMode, string> = {
  off: "Off",
  "dry-run": "Dry-run",
  on: "On",
};
const SEVERITY_LABELS: Record<SelfHealSeverity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};
const MODE_OPTIONS = SELF_HEAL_MODES.map((value) => ({
  value,
  label: MODE_LABELS[value],
}));
const SEVERITY_OPTIONS = SELF_HEAL_SEVERITIES.map((value) => ({
  value,
  label: SEVERITY_LABELS[value],
}));
const KILL_SWITCH_OPTIONS = [
  { value: "on", label: "On (stopped)" },
  { value: "off", label: "Off" },
] as const;
const AUTO_LABEL_OPTIONS = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const;

function onOffOrNull(value: OnOff | typeof INHERIT): OnOff | null {
  return value === INHERIT ? null : value;
}

function onOffLabel(value: boolean): string {
  return value ? "On" : "Off";
}

/** The text input of one number or window field. */
function TextField({
  id,
  label,
  note,
  value,
  placeholder,
  error,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  note?: string;
  value: string;
  placeholder: string;
  error: string | undefined;
  disabled: boolean;
  onChange: (text: string) => void;
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className="min-h-11"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-invalid={error !== undefined}
      />
      {note !== undefined && (
        <p className="text-xs text-muted-foreground">{note}</p>
      )}
      {error !== undefined && (
        <p className="text-xs text-destructive" data-testid={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

const NUMBER_LABELS = {
  selfHealMaxOpenIssues: "Max open issues",
  selfHealMaxAttempts: "Max attempts per finding",
  selfHealCooldownMin: "Cooldown (minutes)",
  selfHealAbsentAudits:
    "Rubric findings: audits absent before needs-human-approve",
  selfHealMaxDiffLines: "Max fix diff lines",
  selfHealPrExpiryDays: "Unreviewed fix PR expiry (days)",
} as const;

const SYSTEM_DEFAULT_BY_FIELD = {
  selfHealMaxOpenIssues: SELF_HEAL_DEFAULTS.maxOpenIssues,
  selfHealMaxAttempts: SELF_HEAL_DEFAULTS.maxAttempts,
  selfHealCooldownMin: SELF_HEAL_DEFAULTS.cooldownMin,
  selfHealAbsentAudits: SELF_HEAL_DEFAULTS.absentAudits,
  selfHealMaxDiffLines: SELF_HEAL_DEFAULTS.maxDiffLines,
  selfHealPrExpiryDays: SELF_HEAL_DEFAULTS.prExpiryDays,
} as const;

/** "Inherit (system default: X)" at org scope, "Inherit (org default: X)" at repo scope. */
function inheritLabel(scope: "org" | "repo", shown: string): string {
  return scope === "org"
    ? `Inherit (system default: ${shown})`
    : `Inherit (org default: ${shown})`;
}

/**
 * The fields for one block. Pure: the draft is a prop. `values` is the stored
 * block; `orgValues` is what a repo "Inherit" resolves to (null at org scope).
 * The kill switch renders at org scope only.
 */
export function SelfHealFieldsView({
  idPrefix = "self-heal",
  scope,
  values,
  orgValues,
  draft,
  onChange,
  disabled,
  saveLabel,
  saveBlocked = false,
  onSave,
}: {
  idPrefix?: string;
  scope: "org" | "repo";
  values: SelfHealValues;
  orgValues: SelfHealValues | null;
  draft: SelfHealDraft;
  onChange: (draft: SelfHealDraft) => void;
  disabled: boolean;
  saveLabel?: string;
  /** Extra reason the Save button stays disabled (e.g. no repo picked). */
  saveBlocked?: boolean;
  onSave?: (patch: SelfHealPatch) => void;
}) {
  const inherited = scope === "repo" ? orgValues : null;
  const result = selfHealDraftToPatch(draft, { scope });
  const error = "error" in result ? result.error : undefined;
  const patch =
    "patch" in result ? changedSelfHealFields(result.patch, values) : {};
  const canSave =
    onSave !== undefined &&
    !disabled &&
    !saveBlocked &&
    error === undefined &&
    Object.keys(patch).length > 0;

  const inheritedMode = inherited?.selfHealMode ?? SELF_HEAL_DEFAULTS.mode;
  const inheritedSeverity =
    inherited?.selfHealMinSeverity ?? SELF_HEAL_DEFAULTS.minSeverity;
  const inheritedAutoLabel =
    inherited?.selfHealAutoLabel ?? SELF_HEAL_DEFAULTS.autoLabel;
  const inheritedKill = SELF_HEAL_DEFAULTS.killSwitch;

  const fieldError = (field: SelfHealField) =>
    error !== undefined && error.field === field ? error.message : undefined;

  return (
    <div className="grid gap-4" data-testid={`${idPrefix}-fields`}>
      <InheritSelect
        id={`${idPrefix}-mode`}
        label="Mode"
        value={draft.mode === INHERIT ? null : draft.mode}
        options={MODE_OPTIONS}
        inheritLabel={inheritLabel(scope, MODE_LABELS[inheritedMode])}
        disabled={disabled}
        onChange={(mode) => onChange({ ...draft, mode: mode ?? INHERIT })}
      >
        <p
          className="text-xs text-muted-foreground"
          data-testid={`${idPrefix}-on-note`}
        >
          {SELF_HEAL_ON_PRECONDITIONS_NOTE}
        </p>
      </InheritSelect>

      {scope === "org" && (
        <InheritSelect
          id={`${idPrefix}-kill-switch`}
          label="Kill switch"
          value={onOffOrNull(draft.killSwitch)}
          options={KILL_SWITCH_OPTIONS}
          inheritLabel={inheritLabel(scope, onOffLabel(inheritedKill))}
          disabled={disabled}
          onChange={(v) => onChange({ ...draft, killSwitch: v ?? INHERIT })}
        >
          <p className="text-xs text-muted-foreground">{KILL_SWITCH_NOTE}</p>
        </InheritSelect>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {SELF_HEAL_NUMBER_SPECS.slice(0, 3).map((spec) => (
          <TextField
            key={spec.field}
            id={`${idPrefix}-${spec.draftKey}`}
            label={NUMBER_LABELS[spec.field]}
            value={draft[spec.draftKey]}
            placeholder={String(
              inherited?.[spec.field] ?? SYSTEM_DEFAULT_BY_FIELD[spec.field],
            )}
            error={fieldError(spec.field)}
            disabled={disabled}
            onChange={(text) => onChange({ ...draft, [spec.draftKey]: text })}
          />
        ))}
      </div>

      <InheritSelect
        id={`${idPrefix}-min-severity`}
        label="Minimum severity"
        value={draft.minSeverity === INHERIT ? null : draft.minSeverity}
        options={SEVERITY_OPTIONS}
        inheritLabel={inheritLabel(scope, SEVERITY_LABELS[inheritedSeverity])}
        disabled={disabled}
        onChange={(v) => onChange({ ...draft, minSeverity: v ?? INHERIT })}
      />

      <InheritSelect
        id={`${idPrefix}-auto-label`}
        label="Auto-label new issues for fixing"
        value={onOffOrNull(draft.autoLabel)}
        options={AUTO_LABEL_OPTIONS}
        inheritLabel={inheritLabel(scope, onOffLabel(inheritedAutoLabel))}
        disabled={disabled}
        onChange={(v) => onChange({ ...draft, autoLabel: v ?? INHERIT })}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {SELF_HEAL_NUMBER_SPECS.slice(3).map((spec) => (
          <TextField
            key={spec.field}
            id={`${idPrefix}-${spec.draftKey}`}
            label={NUMBER_LABELS[spec.field]}
            value={draft[spec.draftKey]}
            placeholder={String(
              inherited?.[spec.field] ?? SYSTEM_DEFAULT_BY_FIELD[spec.field],
            )}
            error={fieldError(spec.field)}
            disabled={disabled}
            onChange={(text) => onChange({ ...draft, [spec.draftKey]: text })}
          />
        ))}
      </div>

      <TextField
        id={`${idPrefix}-run-window`}
        label="Run window (UTC, HH:MM-HH:MM)"
        value={draft.runWindow}
        placeholder={
          inherited?.selfHealRunWindow ?? SELF_HEAL_DEFAULTS.runWindow
        }
        error={fieldError("selfHealRunWindow")}
        disabled={disabled}
        onChange={(runWindow) => onChange({ ...draft, runWindow })}
      />

      {onSave !== undefined && (
        <div>
          <Button
            size="sm"
            className="min-h-11"
            id={`${idPrefix}-save`}
            disabled={!canSave}
            onClick={() => onSave(patch)}
          >
            {saveLabel ?? "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Stateful wrapper: holds the draft for one block. Remount (key) on new data. */
function SelfHealEditor({
  idPrefix,
  scope,
  stored,
  orgValues,
  disabled,
  saveLabel,
  onSave,
}: {
  idPrefix: string;
  scope: "org" | "repo";
  stored: SelfHealValues;
  orgValues: SelfHealValues | null;
  disabled: boolean;
  saveLabel: string;
  onSave: (patch: SelfHealPatch) => void;
}) {
  const [draft, setDraft] = useState(() => selfHealDraftFromValues(stored));
  return (
    <SelfHealFieldsView
      idPrefix={idPrefix}
      scope={scope}
      values={stored}
      orgValues={orgValues}
      draft={draft}
      onChange={setDraft}
      disabled={disabled}
      saveLabel={saveLabel}
      onSave={onSave}
    />
  );
}

export type SelfHealSectionState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      orgDefault: SelfHealValues;
      orgDefaultVersion: string | null;
      conflict: boolean;
      saving: boolean;
      overridesLoading: boolean;
      overrides: SelfHealOverrideRow[];
      availableRepos: string[];
    };

export interface SelfHealSectionActions {
  onSaveDefault: (patch: SelfHealPatch) => void;
  onSaveOverride: (row: SelfHealOverrideRow, patch: SelfHealPatch) => void;
  onRestoreDefault: (row: SelfHealOverrideRow) => void;
  onAddOverride: (repoFullName: string, patch: SelfHealPatch) => void;
  onReload: () => void;
}

export function SelfHealSectionView({
  state,
  actions,
  activity,
}: {
  state: SelfHealSectionState;
  actions: SelfHealSectionActions;
  /** Activity card, rendered once the settings are ready (container-provided). */
  activity?: React.ReactNode;
}) {
  return (
    <SettingsSection
      label="Self-heal"
      description="Turns audit findings into issues and fix attempts. Repos inherit the org default unless overridden; the default is Off. Changes apply to new self-heal cycles."
    >
      {state.kind === "loading" ? (
        <div className="grid gap-2" data-testid="self-heal-skeleton">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : state.kind === "error" ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Couldn&apos;t load the self-heal settings</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : (
        <>
          {state.conflict && (
            <ConflictBanner
              testId="self-heal-conflict"
              onReload={actions.onReload}
            />
          )}
          <div className="rounded-md border p-3">
            <h4 className="mb-3 text-sm font-medium">Org default</h4>
            <SelfHealEditor
              key={state.orgDefaultVersion ?? "none"}
              idPrefix="self-heal-org"
              scope="org"
              stored={state.orgDefault}
              orgValues={null}
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
                data-testid="self-heal-overrides-empty"
              >
                All your repos use the org default. Add an override below to
                give one repo its own self-heal settings.
              </p>
            ) : (
              <ul className="mt-2 grid gap-2">
                {state.overrides.map((row) => (
                  <li
                    key={row.repoFullName}
                    className="grid gap-3 rounded-md border p-3"
                    data-testid="self-heal-override"
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
                    <SelfHealEditor
                      key={row.updatedAt}
                      idPrefix={`self-heal-repo-${row.repoFullName}`}
                      scope="repo"
                      stored={row}
                      orgValues={state.orgDefault}
                      disabled={state.saving}
                      saveLabel="Save override"
                      onSave={(patch) => actions.onSaveOverride(row, patch)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {!state.overridesLoading && (
              <AddSelfHealOverride
                repos={state.availableRepos}
                orgValues={state.orgDefault}
                disabled={state.saving}
                onAdd={actions.onAddOverride}
              />
            )}
          </div>
          {activity}
        </>
      )}
    </SettingsSection>
  );
}

/** Create a repo's FIRST self-heal override: pick a repo, set fields, Add. */
function AddSelfHealOverride({
  repos,
  orgValues,
  disabled,
  onAdd,
}: {
  repos: string[];
  orgValues: SelfHealValues;
  disabled: boolean;
  onAdd: (repoFullName: string, patch: SelfHealPatch) => void;
}) {
  const [repo, setRepo] = useState("");
  const [draft, setDraft] = useState(() =>
    selfHealDraftFromValues(NO_SELF_HEAL_VALUES),
  );
  if (repos.length === 0) return null;
  return (
    <div
      className="mt-3 grid gap-3 rounded-md border border-dashed p-3"
      data-testid="self-heal-add-override"
    >
      <RepoPickerSelect
        repos={repos}
        value={repo}
        onChange={setRepo}
        disabled={disabled}
        ariaLabel="Repository to add a self-heal override for"
      />
      <SelfHealFieldsView
        idPrefix="self-heal-add"
        scope="repo"
        values={NO_SELF_HEAL_VALUES}
        orgValues={orgValues}
        draft={draft}
        onChange={setDraft}
        disabled={disabled}
        saveLabel="Add override"
        saveBlocked={repo === ""}
        onSave={(patch) => {
          onAdd(repo, patch);
          setRepo("");
          setDraft(selfHealDraftFromValues(NO_SELF_HEAL_VALUES));
        }}
      />
    </div>
  );
}

/** Binds the queries/mutations; returns the view's state and actions. */
export function useSelfHealSectionModel(): {
  state: SelfHealSectionState;
  actions: SelfHealSectionActions;
} {
  const defaultQuery = useSupersedeDefaultQuery();
  const listQuery = useReviewSettingsQuery();
  const reposQuery = useUserReposQuery();
  const setDefault = useSetSupersedeDefaultMutation({
    successMessage: "Org self-heal default saved. Applies to new cycles.",
  });
  const setOverride = useSetReviewSettingMutation({
    successMessage: "Repo override saved. Applies to new self-heal cycles.",
  });
  const restoreOverride = useSetReviewSettingMutation({
    successMessage:
      "Repo override removed. The org default applies to new self-heal cycles.",
  });
  const [conflict, setConflict] = useState(false);

  const stored = defaultQuery.data ?? null;
  const list = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const visibleRepos = reposQuery.data?.repos;
  const overrides = useMemo(() => selfHealOverrides(list), [list]);
  const availableRepos = useMemo(
    () =>
      availableRepoNames(
        (visibleRepos ?? []).map((r) => r.full_name),
        list,
        hasSelfHealOverride,
      ),
    [visibleRepos, list],
  );

  const onConflict = (error: unknown) => {
    if (error instanceof ConflictError) setConflict(true);
  };

  function saveOverride(
    row: SelfHealOverrideRow,
    patch: SelfHealPatch,
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

  const state: SelfHealSectionState = defaultQuery.isLoading
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
          orgDefault: stored ? pickSelfHealFields(stored) : NO_SELF_HEAL_VALUES,
          orgDefaultVersion: stored?.updatedAt ?? null,
          conflict,
          // Every writer must be here, or a double-click self-409s.
          saving:
            setDefault.isPending ||
            setOverride.isPending ||
            restoreOverride.isPending,
          overridesLoading: listQuery.isLoading,
          overrides,
          availableRepos,
        };

  const actions: SelfHealSectionActions = {
    onSaveDefault: (patch) => {
      setConflict(false);
      setDefault.mutate(
        { ...patch, expectedUpdatedAt: stored ? stored.updatedAt : null },
        { onError: onConflict },
      );
    },
    onSaveOverride: (row, patch) => saveOverride(row, patch, setOverride),
    // Clears only the self-heal family; no other family is touched.
    onRestoreDefault: (row) =>
      saveOverride(row, SELF_HEAL_CLEAR_PATCH, restoreOverride),
    onAddOverride: (repoFullName, patch) => {
      setConflict(false);
      setOverride.mutate(
        {
          repoFullName,
          patch: {
            ...patch,
            expectedUpdatedAt:
              findSettingByRepo(list, repoFullName)?.updatedAt ?? null,
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

/**
 * Activity block: a repo picker over the caller's repos, the picked repo's
 * activity card and the org-scope Drain control (which works with no repo).
 */
export function SelfHealActivityPanel() {
  const reposQuery = useUserReposQuery();
  const [repo, setRepo] = useState("");
  const repos = useMemo(
    () => (reposQuery.data?.repos ?? []).map((r) => r.full_name),
    [reposQuery.data],
  );
  return (
    <div className="mt-6 grid gap-3" data-testid="self-heal-activity-panel">
      <h4 className="text-sm font-medium">Activity</h4>
      {repos.length > 0 && (
        <RepoPickerSelect
          repos={repos}
          value={repo}
          onChange={setRepo}
          disabled={false}
          ariaLabel="Repository to show self-heal activity for"
        />
      )}
      <SelfHealActivity repoFullName={repo === "" ? null : repo} scope="org" />
    </div>
  );
}

/** Thin container: binds the model to the pure view. */
export function SelfHealSection() {
  const { state, actions } = useSelfHealSectionModel();
  return (
    <SelfHealSectionView
      state={state}
      actions={actions}
      activity={<SelfHealActivityPanel />}
    />
  );
}
