"use client";

import type { BlockTolerance } from "@terragon/review/severity-policy";
import { AlertCircle, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsSection } from "@/components/settings/settings-row";
import {
  useOrgReviewSettingsQuery,
  useSetOrgReviewSettingMutation,
} from "@/queries/org-review-settings-queries";
import { ToleranceRadioCard } from "./tolerance-radio-card";
import { TOLERANCE_ORDER } from "./constants";

/**
 * Org-wide review floor selector (ADR-005 §4). Governance intent only —
 * setting this stores the floor, it does not yet change any verdict.
 * Enforcement at review time ships with the org-floor resolver (#73).
 *
 * GET is open to any org member; a PUT from a non-admin 403s server-side.
 * This component doesn't try to precompute the caller's role client-side —
 * it attempts the write and surfaces the 403 as a toast (via the mutation's
 * onError), which keeps this simple and still correct since the seam is the
 * source of truth per ADR-005 §5.
 */
export function OrgFloorCard() {
  const settingQuery = useOrgReviewSettingsQuery();
  const setMutation = useSetOrgReviewSettingMutation();

  const stored = settingQuery.data?.blockTolerance ?? null;
  const isMutating = setMutation.isPending;

  function select(tolerance: BlockTolerance): void {
    if (tolerance === stored) return;
    setMutation.mutate({ blockTolerance: tolerance });
  }

  function clear(): void {
    if (stored === null) return;
    setMutation.mutate({ blockTolerance: null });
  }

  return (
    <SettingsSection
      label="Organization Review Floor"
      description="Sets the loosest review tolerance repos in this organization may configure. Enforcement of the floor at review time ships with the org-floor resolver."
    >
      {settingQuery.isError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Couldn&apos;t load the organization floor</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>
              {settingQuery.error instanceof Error
                ? settingQuery.error.message
                : "Unknown error"}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void settingQuery.refetch()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {settingQuery.isLoading && (
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 w-full rounded-md" />
          ))}
        </div>
      )}

      {!settingQuery.isLoading && !settingQuery.isError && (
        <div className="flex flex-col gap-3">
          <div
            role="radiogroup"
            aria-label="Organization review floor"
            className="grid gap-3 sm:grid-cols-3"
          >
            {TOLERANCE_ORDER.map((tolerance) => (
              <ToleranceRadioCard
                key={tolerance}
                tolerance={tolerance}
                selected={stored === tolerance}
                isPersisted={stored === tolerance}
                disabled={isMutating}
                onSelect={select}
              />
            ))}
          </div>

          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground">
              {stored === null
                ? "No floor set — repos may configure any tolerance."
                : `Repos may only be as strict as or stricter than "${stored}".`}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isMutating || stored === null}
              onClick={clear}
            >
              {isMutating && <Loader2 className="h-3 w-3 animate-spin" />}
              No floor
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
