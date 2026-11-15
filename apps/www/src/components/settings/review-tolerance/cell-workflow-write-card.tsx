"use client";

import React from "react";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { SettingsSection } from "@/components/settings/settings-row";
import {
  useOrgReviewSettingsQuery,
  type OrgReviewSettingDto,
  useSetCellWorkflowWriteMutation,
} from "@/queries/org-review-settings-queries";

/**
 * Per-org opt-in letting remote cells push changes to `.github/workflows`
 * (#609). Stored tri-state like the other org columns: NULL and false both
 * mean off, only an explicit true is an opt-in.
 *
 * Like OrgFloorCard, this does not precompute the caller's role: a PUT from a
 * non-admin 403s server-side and the mutation's onError shows it as a toast.
 * The switch is disabled only while a save is in flight.
 */

export type CellWorkflowWriteState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; enabled: boolean; saving: boolean };

export function CellWorkflowWriteCardView({
  state,
  onChange,
}: {
  state: CellWorkflowWriteState;
  onChange(enabled: boolean): void;
}) {
  return (
    <SettingsSection
      label="Remote cell workflow changes"
      description="Whether agents running in remote sandboxes may push changes to CI workflow files. Off by default. The GitHub App installation must also grant Workflows read and write."
    >
      {state.kind === "loading" && (
        <div className="space-y-2" data-testid="cell-workflow-write-skeleton">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-11 w-full" />
        </div>
      )}
      {state.kind === "error" && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Couldn&apos;t load this setting</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      {state.kind === "ready" && (
        <div className="space-y-3">
          <div className="flex min-h-11 items-center justify-between gap-4 rounded-md border p-4">
            <div>
              <Label htmlFor="cell-workflow-write">
                Let remote cells change CI workflow files
              </Label>
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {state.enabled
                  ? "Remote cells can push changes to .github/workflows."
                  : "Pushes that change .github/workflows are rejected."}
              </p>
            </div>
            <Switch
              id="cell-workflow-write"
              checked={state.enabled}
              disabled={state.saving}
              onCheckedChange={onChange}
            />
          </div>
          <Alert data-testid="cell-workflow-write-warning">
            <AlertTriangle className="size-4" />
            <AlertTitle>Workflow files run with your CI secrets</AlertTitle>
            <AlertDescription>
              Turning this on lets an agent running in a remote sandbox push
              changes to .github/workflows, and those workflows then run in CI
              with the repository&apos;s secrets. Keep CI secrets in GitHub
              environments with required reviewers.
            </AlertDescription>
          </Alert>
        </div>
      )}
    </SettingsSection>
  );
}

/** Off unless the org explicitly opted in: no row, NULL and false all resolve off. */
export function cellWorkflowWriteEnabled(
  data: OrgReviewSettingDto | null | undefined,
): boolean {
  return data?.cellWorkflowWrite === true;
}

/** Thin container: binds the org review-settings query and the write mutation. */
export function CellWorkflowWriteCard() {
  const settings = useOrgReviewSettingsQuery();
  const setWrite = useSetCellWorkflowWriteMutation();

  const state: CellWorkflowWriteState = settings.isPending
    ? { kind: "loading" }
    : settings.isError
      ? {
          kind: "error",
          message:
            settings.error instanceof Error
              ? settings.error.message
              : String(settings.error),
        }
      : {
          kind: "ready",
          enabled: cellWorkflowWriteEnabled(settings.data),
          saving: setWrite.isPending,
        };

  return (
    <CellWorkflowWriteCardView
      state={state}
      onChange={(enabled) => setWrite.mutate({ cellWorkflowWrite: enabled })}
    />
  );
}
