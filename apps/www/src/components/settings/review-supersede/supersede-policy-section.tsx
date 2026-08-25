"use client";

import React, { useState } from "react";
import { AlertCircle, AlertTriangle, RotateCcw } from "lucide-react";
import type { SupersedePolicy } from "@terragon/shared/model/repo-review-settings";
import {
  DEFAULT_SUPERSEDE_POLICY,
  SUPERSEDE_POLICY_LABELS,
} from "@terragon/shared/model/repo-review-settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
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
import { PolicyRadioGroup } from "./policy-radio-group";

/**
 * #125 C6 — "Review & Automations": the org-wide supersede policy (what
 * happens when a commit lands during a running review) + per-repo overrides.
 *
 * Split into a PURE view (`SupersedePolicySectionView`, every state is a
 * prop — testable with renderToStaticMarkup) and a thin container that binds
 * the queries/mutations. State table: loading skeleton / human error /
 * conflict banner with Reload (BOTH the org default and a repo override
 * losing a race land here — never a silent last-write-wins) / empty
 * overrides / overrides list with Restore default. Mobile: overrides stack as
 * cards under 640px; radio cards, selects and switches are 44px targets.
 * Writes are permission-gated server-side (org admin for the default; org- or
 * repo-admin for overrides) and the 403's human copy is toasted as-is.
 */

export interface OverrideRow {
  repoFullName: string;
  supersedePolicy: string | null;
  recheckOnComplete: boolean;
  updatedAt: string;
}

export type SupersedeSectionState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      policy: SupersedePolicy | null;
      recheckOnComplete: boolean;
      /** Another admin saved between our read and write. */
      conflict: boolean;
      saving: boolean;
      overridesLoading: boolean;
      overrides: OverrideRow[];
      /** Repos the caller can add a FIRST override for (not yet overridden). */
      availableRepos: string[];
    };

export interface SupersedeSectionActions {
  onSelectPolicy: (policy: SupersedePolicy) => void;
  onRecheckChange: (on: boolean) => void;
  onOverridePolicy: (row: OverrideRow, policy: SupersedePolicy) => void;
  onOverrideRecheck: (row: OverrideRow, on: boolean) => void;
  onRestoreDefault: (row: OverrideRow) => void;
  onAddOverride: (repoFullName: string, policy: SupersedePolicy) => void;
  onReload: () => void;
}

export function SupersedePolicySectionView({
  state,
  actions,
}: {
  state: SupersedeSectionState;
  actions: SupersedeSectionActions;
}) {
  return (
    <SettingsSection
      label="Review & Automations"
      description="What happens when a new commit lands while a review is still running. The org default applies to every repo without an override. Changes apply to new runs."
    >
      {state.kind === "loading" ? (
        <div className="grid gap-2" data-testid="supersede-skeleton">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : state.kind === "error" ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Couldn&apos;t load the review policy</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : (
        <>
          {state.conflict && (
            <Alert role="status" data-testid="supersede-conflict">
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
          <PolicyRadioGroup
            value={state.policy}
            recheckOnComplete={state.recheckOnComplete}
            disabled={state.saving}
            onSelect={actions.onSelectPolicy}
            onRecheckChange={actions.onRecheckChange}
          />
          <div className="mt-6">
            <h4 className="text-sm font-medium">Repo overrides</h4>
            {state.overridesLoading ? (
              <Skeleton className="mt-2 h-12 w-full" />
            ) : state.overrides.length === 0 ? (
              <p
                className="mt-2 text-sm text-muted-foreground"
                data-testid="supersede-overrides-empty"
              >
                All your repos use the org default. Add an override below to
                give one repo its own policy.
              </p>
            ) : (
              <ul className="mt-2 grid gap-2">
                {state.overrides.map((s) => (
                  <li
                    key={s.repoFullName}
                    className="grid grid-cols-1 items-center gap-2 rounded-md border p-3 sm:grid-cols-[1fr_auto_auto_auto]"
                  >
                    <span className="truncate font-mono text-sm">
                      {s.repoFullName}
                    </span>
                    <span className="w-fit rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      Repo override
                    </span>
                    <Select
                      value={s.supersedePolicy ?? DEFAULT_SUPERSEDE_POLICY}
                      onValueChange={(v) =>
                        actions.onOverridePolicy(s, v as SupersedePolicy)
                      }
                      disabled={state.saving}
                    >
                      <SelectTrigger
                        className="min-h-11 w-full sm:w-64"
                        aria-label={`Supersede policy for ${s.repoFullName}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(
                          Object.entries(SUPERSEDE_POLICY_LABELS) as [
                            SupersedePolicy,
                            string,
                          ][]
                        ).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-11 justify-self-start sm:justify-self-auto"
                      onClick={() => actions.onRestoreDefault(s)}
                      disabled={state.saving}
                    >
                      <RotateCcw className="mr-1 h-3 w-3" aria-hidden />
                      Restore default
                    </Button>
                    {s.supersedePolicy === "complete-run-discard" && (
                      <div
                        className="sm:col-span-4"
                        aria-live="polite"
                        data-testid="override-discard-warning"
                      >
                        <p className="flex items-start gap-1 text-xs text-amber-600 dark:text-amber-500">
                          <AlertTriangle
                            className="mt-0.5 h-3 w-3 shrink-0"
                            aria-hidden
                          />
                          <span>
                            Commits pushed to {s.repoFullName} during a review
                            will get no feedback unless re-verification is on.
                          </span>
                        </p>
                        <div className="mt-2 flex min-h-11 items-center gap-2">
                          <Switch
                            id={`override-recheck-${s.repoFullName}`}
                            checked={s.recheckOnComplete}
                            onCheckedChange={(on) =>
                              actions.onOverrideRecheck(s, on)
                            }
                            disabled={state.saving}
                          />
                          <Label
                            htmlFor={`override-recheck-${s.repoFullName}`}
                            className="text-xs"
                          >
                            Re-verify the newest commit when the running review
                            finishes
                          </Label>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!state.overridesLoading && (
              <AddOverrideRow
                repos={state.availableRepos}
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

/**
 * The only way to create a repo's FIRST override: pick a repo the caller can
 * see (GitHub App installations), pick a policy, Add. Repos that already have
 * an override are edited in the list above instead.
 */
function AddOverrideRow({
  repos,
  disabled,
  onAdd,
}: {
  repos: string[];
  disabled: boolean;
  onAdd: (repoFullName: string, policy: SupersedePolicy) => void;
}) {
  const [repo, setRepo] = useState<string>("");
  const [policy, setPolicy] = useState<SupersedePolicy>(
    DEFAULT_SUPERSEDE_POLICY,
  );
  if (repos.length === 0) return null;
  return (
    <div
      className="mt-3 grid grid-cols-1 items-center gap-2 rounded-md border border-dashed p-3 sm:grid-cols-[1fr_auto_auto]"
      data-testid="supersede-add-override"
    >
      <Select value={repo} onValueChange={setRepo} disabled={disabled}>
        <SelectTrigger
          className="min-h-11 w-full"
          aria-label="Repository to add an override for"
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
      <Select
        value={policy}
        onValueChange={(v) => setPolicy(v as SupersedePolicy)}
        disabled={disabled}
      >
        <SelectTrigger
          className="min-h-11 w-full sm:w-64"
          aria-label="Policy for the new override"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(
            Object.entries(SUPERSEDE_POLICY_LABELS) as [
              SupersedePolicy,
              string,
            ][]
          ).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        className="min-h-11"
        disabled={disabled || !repo}
        onClick={() => {
          onAdd(repo, policy);
          setRepo("");
        }}
      >
        Add override
      </Button>
    </div>
  );
}

/** Thin container: binds the queries/mutations to the pure view. */
export function SupersedePolicySection() {
  const defaultQuery = useSupersedeDefaultQuery();
  const listQuery = useReviewSettingsQuery();
  const reposQuery = useUserReposQuery();
  const setDefault = useSetSupersedeDefaultMutation();
  const setOverride = useSetReviewSettingMutation({
    successMessage: "Repo override saved. Applies to new runs.",
  });
  // Restore default clears the override, so it must not claim one was saved.
  const restoreOverride = useSetReviewSettingMutation({
    successMessage:
      "Repo override removed. The org default applies to new runs.",
  });
  const [conflict, setConflict] = useState(false);

  const stored = defaultQuery.data ?? null;

  // Both writers route a lost race into the same banner — the org default
  // and the per-repo override alike (the hooks deliberately do NOT toast a
  // ConflictError; this is the one place that renders it).
  const onConflict = (error: unknown) => {
    if (error instanceof ConflictError) setConflict(true);
  };

  function saveDefault(patch: {
    supersedePolicy?: SupersedePolicy | null;
    recheckOnComplete?: boolean;
  }) {
    setConflict(false);
    setDefault.mutate(
      { ...patch, expectedUpdatedAt: stored?.updatedAt },
      { onError: onConflict },
    );
  }

  function saveOverride(
    row: OverrideRow,
    patch: {
      supersedePolicy?: SupersedePolicy | null;
      recheckOnComplete?: boolean;
    },
    mutation: typeof setOverride = setOverride,
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

  const state: SupersedeSectionState = defaultQuery.isLoading
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
          policy: stored?.supersedePolicy ?? null,
          recheckOnComplete: stored?.recheckOnComplete ?? false,
          conflict,
          // Every writer must be here. `saving` disables the whole section,
          // and `restoreOverride` is a SEPARATE mutation instance (it carries
          // its own toast copy), so omitting it left the controls live during
          // a restore: a double-click fired two PUTs with the same
          // `expectedUpdatedAt`, the second lost the DB CAS race, and the 409
          // surfaced as "Another admin just saved changes" for a conflict the
          // user had with themselves.
          saving:
            setDefault.isPending ||
            setOverride.isPending ||
            restoreOverride.isPending,
          overridesLoading: listQuery.isLoading,
          overrides: (listQuery.data ?? []).filter(
            (s) => s.supersedePolicy !== null,
          ),
          availableRepos: (reposQuery.data?.repos ?? [])
            .map((r) => r.full_name)
            .filter(
              (name) =>
                !(listQuery.data ?? []).some(
                  (s) => s.repoFullName === name && s.supersedePolicy !== null,
                ),
            )
            .sort(),
        };

  return (
    <SupersedePolicySectionView
      state={state}
      actions={{
        onSelectPolicy: (policy) => saveDefault({ supersedePolicy: policy }),
        onRecheckChange: (on) => saveDefault({ recheckOnComplete: on }),
        onOverridePolicy: (row, policy) =>
          saveOverride(row, { supersedePolicy: policy }),
        onOverrideRecheck: (row, on) =>
          saveOverride(row, { recheckOnComplete: on }),
        onRestoreDefault: (row) =>
          saveOverride(row, { supersedePolicy: null }, restoreOverride),
        onAddOverride: (repoFullName, policy) => {
          setConflict(false);
          setOverride.mutate(
            { repoFullName, patch: { supersedePolicy: policy } },
            { onError: onConflict },
          );
        },
        onReload: () => {
          setConflict(false);
          void defaultQuery.refetch();
          void listQuery.refetch();
        },
      }}
    />
  );
}
