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
 * Shares the supersede section's query hooks ON PURPOSE: one cache entry for
 * the sentinel row means both sections always hold the same `updatedAt`, so
 * they cannot 409 each other out of staleness — a residual 409 is a genuine
 * concurrent write, which is exactly what the conflict banner is for.
 *
 * Storage is NOT NULL: a sentinel row that exists carries an authoritative
 * value (implicit true counts as a choice). No stored row = effective true.
 */

/** Effective org default when no sentinel row exists. */
export const EFFECTIVE_DRAFT_DEFAULT = true;

export type OrgDraftDefaultState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      /** Effective org-wide value (stored, or the system default true). */
      reviewDrafts: boolean;
      /** ONE predicate over every mutation instance in this card. */
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
  const setDefaults = useSetSupersedeDefaultMutation();
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

  const actions: OrgDraftDefaultActions = {
    onChange: (reviewDrafts) => {
      setDefaults.mutate(
        {
          reviewDraftPrs: reviewDrafts,
          // First-write fence: null only when the sentinel row is truly
          // absent (this GET returns the whole row, both families).
          expectedUpdatedAt: defaults.data ? defaults.data.updatedAt : null,
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
      void defaults.refetch();
    },
  };

  return <OrgDraftDefaultCardView state={state} actions={actions} />;
}
