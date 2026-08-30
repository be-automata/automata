"use client";

import React, { useState } from "react";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { SettingsSection } from "@/components/settings/settings-row";
import {
  useSupersedeDefaultQuery,
  useSetSupersedeDefaultMutation,
} from "@/queries/supersede-policy-queries";
import { ConflictError } from "@/queries/error-from-response";

/**
 * Org-wide "Review draft PRs" default — a column on the SAME sentinel row
 * ('*') the supersede section edits, resolved at webhook intake as:
 * repo row → this sentinel → legacy automation filter → true.
 *
 * Shares the supersede section's query hooks — one cache entry for the
 * sentinel row; see supersede-policy-queries.ts for the coherency story.
 *
 * Storage is TRI-STATE: NULL means "no choice at this scope" and resolution
 * falls through to the legacy automation filter, then the system default
 * FALSE. Only an explicit true/false on the sentinel is an org-wide choice.
 */

/** Effective org default when neither the sentinel nor a legacy automation filter chose: drafts are skipped. */
export const EFFECTIVE_DRAFT_DEFAULT = false;

export type OrgDraftDefaultState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      /** Effective org-wide value (stored, or the system default false). */
      reviewDrafts: boolean;
      saving: boolean;
      /** A CAS write lost its race (either family — the row is shared). */
      conflict: boolean;
    };

export interface OrgDraftDefaultActions {
  onChange(reviewDrafts: boolean): void;
  onReload(): void;
}

export function OrgDraftDefaultCardView({
  state,
  actions,
}: {
  state: OrgDraftDefaultState;
  actions: OrgDraftDefaultActions;
}) {
  return (
    <SettingsSection
      label="Draft pull requests"
      description="Whether reviews run on pull requests that are still drafts. Applies to every repo; a repo's own draft switch overrides it. Changes apply to new pull request events."
    >
      {state.kind === "loading" && (
        <div className="space-y-2" data-testid="org-draft-skeleton">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-11 w-full" />
        </div>
      )}
      {state.kind === "error" && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Couldn&apos;t load the draft-PR policy</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      {state.kind === "ready" && (
        <div className="space-y-3">
          {state.conflict && (
            <Alert role="status" data-testid="org-draft-conflict">
              <AlertTriangle className="size-4" />
              <AlertTitle>Settings changed since you loaded them</AlertTitle>
              <AlertDescription className="flex items-center gap-3">
                <span>Reload to see the latest before editing again.</span>
                <Button size="sm" variant="outline" onClick={actions.onReload}>
                  Reload
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <div className="flex min-h-11 items-center justify-between gap-4 rounded-md border p-4">
            <div>
              <Label htmlFor="org-draft-default">Review draft PRs</Label>
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {state.reviewDrafts
                  ? "Draft PRs are reviewed as soon as they're opened or updated."
                  : "Draft PRs are skipped until they're marked ready for review."}
              </p>
            </div>
            <Switch
              id="org-draft-default"
              checked={state.reviewDrafts}
              disabled={state.saving}
              onCheckedChange={actions.onChange}
            />
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

/** Thin container: binds the SHARED sentinel-row query + mutation. */
export function OrgDraftDefaultCard() {
  const defaults = useSupersedeDefaultQuery();
  const setDefaults = useSetSupersedeDefaultMutation({
    successMessage: "Org default saved. Applies to new pull request events.",
  });
  const [conflict, setConflict] = useState(false);

  const state: OrgDraftDefaultState = defaults.isPending
    ? { kind: "loading" }
    : defaults.isError
      ? {
          kind: "error",
          message:
            defaults.error instanceof Error
              ? defaults.error.message
              : String(defaults.error),
        }
      : {
          kind: "ready",
          reviewDrafts:
            defaults.data?.reviewDraftPrs ?? EFFECTIVE_DRAFT_DEFAULT,
          saving: setDefaults.isPending,
          conflict,
        };

  const actions = buildOrgDraftActions({
    latest: defaults.data ?? null,
    mutate: setDefaults.mutate,
    setConflict,
    refetch: () => void defaults.refetch(),
  });

  return <OrgDraftDefaultCardView state={state} actions={actions} />;
}

/**
 * Container action wiring, exported for tests. A retry MUST clear a stale
 * conflict banner BEFORE mutating: once a write loses the CAS race, the next
 * toggle runs against freshly-invalidated data and can succeed — leaving the
 * "changed since you loaded" banner up after a successful save contradicts
 * the banner's own message. Same setConflict(false)-before-mutate ordering
 * as SupersedePolicySection.saveDefault, for the same reason.
 */
export function buildOrgDraftActions({
  latest,
  mutate,
  setConflict,
  refetch,
}: {
  latest: { updatedAt: string } | null;
  mutate: (
    input: { reviewDraftPrs: boolean; expectedUpdatedAt: string | null },
    options: { onError: (error: unknown) => void },
  ) => void;
  setConflict: (value: boolean) => void;
  refetch: () => void;
}): OrgDraftDefaultActions {
  return {
    onChange: (reviewDrafts) => {
      setConflict(false);
      mutate(
        {
          reviewDraftPrs: reviewDrafts,
          // First-write fence: null only when the sentinel row is truly absent.
          expectedUpdatedAt: latest ? latest.updatedAt : null,
        },
        {
          onError: (error) => {
            if (error instanceof ConflictError) setConflict(true);
          },
        },
      );
    },
    onReload: () => {
      setConflict(false);
      refetch();
    },
  };
}
