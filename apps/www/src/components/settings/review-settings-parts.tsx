"use client";

import React from "react";
import { AlertCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Pieces shared by the review-settings sections (supersede policy, review
 * agent): the one conflict banner a lost write race lands in, the
 * "Repo override" pill and the "Add override" repository picker.
 */

/** The "Repo override" pill on an override row. */
export function RepoOverrideBadge() {
  return (
    <Badge
      variant="outline"
      className="w-fit px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground"
    >
      Repo override
    </Badge>
  );
}

/** Another admin saved between our read and write: Reload, never overwrite. */
export function ConflictBanner({
  testId,
  onReload,
}: {
  testId: string;
  onReload: () => void;
}) {
  return (
    <Alert role="status" data-testid={testId}>
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Another admin just saved changes</AlertTitle>
      <AlertDescription className="flex items-center gap-2">
        Your change was not applied. Reload to see the latest before editing
        again.
        <Button size="sm" variant="outline" onClick={onReload}>
          Reload
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** Pick the repository a FIRST override is added for. */
export function RepoPickerSelect({
  repos,
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  repos: readonly string[];
  value: string;
  onChange: (repoFullName: string) => void;
  disabled: boolean;
  ariaLabel: string;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="min-h-11 w-full" aria-label={ariaLabel}>
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
  );
}
