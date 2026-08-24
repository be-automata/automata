"use client";

import React, { useState } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import type { SupersedePolicy } from "@terragon/shared/model/repo-review-settings";
import {
  DEFAULT_SUPERSEDE_POLICY,
  SUPERSEDE_POLICY_LABELS,
} from "@terragon/shared/model/repo-review-settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { PolicyRadioGroup } from "./policy-radio-group";

/**
 * #125 C6 — "Review & Automations": the org-wide supersede policy (what
 * happens when a commit lands during a running review) + per-repo overrides.
 * Full state table: skeleton / empty / human error (incl. no-active-org) /
 * success toast / concurrent-edit conflict with a Reload action. Full mobile
 * parity: the overrides render as stacked cards under 640px (grid classes),
 * radio cards and switches are 44px targets. Writes are permission-gated
 * server-side (org admin for the default; org- or repo-admin for overrides)
 * and surface the 403's human copy as-is.
 */
export function SupersedePolicySection() {
  const defaultQuery = useSupersedeDefaultQuery();
  const listQuery = useReviewSettingsQuery();
  const setDefault = useSetSupersedeDefaultMutation();
  const setOverride = useSetReviewSettingMutation({
    successMessage: "Repo override saved. Applies to new runs.",
  });
  const [conflict, setConflict] = useState(false);

  const stored = defaultQuery.data ?? null;
  const storedPolicy = stored?.supersedePolicy ?? null;
  const recheck = stored?.recheckOnComplete ?? false;

  function saveDefault(patch: {
    supersedePolicy?: SupersedePolicy | null;
    recheckOnComplete?: boolean;
  }) {
    setConflict(false);
    setDefault.mutate(
      { ...patch, expectedUpdatedAt: stored?.updatedAt },
      {
        onError: (error) => {
          if (error instanceof ConflictError) setConflict(true);
        },
      },
    );
  }

  const overrides = (listQuery.data ?? []).filter(
    (s) => s.supersedePolicy !== null,
  );

  return (
    <SettingsSection
      label="Review & Automations"
      description="What happens when a new commit lands while a review is still running. The org default applies to every repo without an override. Changes apply to new runs."
    >
      {defaultQuery.isLoading ? (
        <div className="grid gap-2" data-testid="supersede-skeleton">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : defaultQuery.isError ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Couldn&apos;t load the review policy</AlertTitle>
          <AlertDescription>
            {defaultQuery.error instanceof Error
              ? defaultQuery.error.message
              : "Something went wrong. Reload the page to try again."}
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {conflict && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Another admin just saved changes</AlertTitle>
              <AlertDescription className="flex items-center gap-2">
                Reload to see the latest before editing again.
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setConflict(false);
                    void defaultQuery.refetch();
                  }}
                >
                  Reload
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <PolicyRadioGroup
            value={storedPolicy}
            recheckOnComplete={recheck}
            disabled={setDefault.isPending}
            onSelect={(policy) => saveDefault({ supersedePolicy: policy })}
            onRecheckChange={(on) => saveDefault({ recheckOnComplete: on })}
          />
          <div className="mt-6">
            <h4 className="text-sm font-medium">Repo overrides</h4>
            {listQuery.isLoading ? (
              <Skeleton className="mt-2 h-12 w-full" />
            ) : overrides.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                All your repos use the org default. Set a repo&apos;s policy
                from the selector below its row in Review tolerance, or here
                once one differs.
              </p>
            ) : (
              <ul className="mt-2 grid gap-2">
                {overrides.map((s) => (
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
                        setOverride.mutate({
                          repoFullName: s.repoFullName,
                          patch: {
                            supersedePolicy: v as SupersedePolicy,
                            expectedUpdatedAt: s.updatedAt,
                          },
                        })
                      }
                      disabled={setOverride.isPending}
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
                      onClick={() =>
                        setOverride.mutate({
                          repoFullName: s.repoFullName,
                          patch: {
                            supersedePolicy: null,
                            expectedUpdatedAt: s.updatedAt,
                          },
                        })
                      }
                      disabled={setOverride.isPending}
                    >
                      <RotateCcw className="mr-1 h-3 w-3" aria-hidden />
                      Restore default
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </SettingsSection>
  );
}
