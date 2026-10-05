"use client";

import { useState } from "react";
import { IssueTriggerConfig } from "@terragon/shared/automations";
import { FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RepoSelector } from "../repo-branch-selector";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";

function parseLabelList(raw: string): string[] | undefined {
  const labels = raw
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  return labels.length > 0 ? labels : undefined;
}

// Comma-separated label list. Keeps the raw text locally so a trailing comma
// or space survives while typing; the parsed list is what reaches the config.
function LabelListInput({
  id,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  value: string[] | undefined;
  placeholder: string;
  onChange: (labels: string[] | undefined) => void;
}) {
  const [raw, setRaw] = useState((value ?? []).join(", "));
  return (
    <Input
      id={id}
      value={raw}
      placeholder={placeholder}
      onChange={(e) => {
        setRaw(e.target.value);
        onChange(parseLabelList(e.target.value));
      }}
    />
  );
}

export function IssueTriggerForm({
  value,
  repoFullName,
  setRepoFullName,
  onChange,
  errorMessage,
}: {
  value: IssueTriggerConfig;
  repoFullName: string;
  setRepoFullName: (repoFullName: string) => void;
  onChange: (value: IssueTriggerConfig) => void;
  errorMessage?: string;
}) {
  return (
    <div className="space-y-4 border rounded-lg p-4">
      <div className="space-y-2">
        <FormLabel>Repository</FormLabel>
        <RepoSelector
          selectedRepoFullName={repoFullName}
          onChange={(repoFullName) => {
            if (repoFullName) {
              setRepoFullName(repoFullName);
            }
          }}
        />
      </div>
      <div className="space-y-2">
        <FormLabel>When to trigger</FormLabel>
        <div className="space-y-3">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="onOpen"
              checked={value.on.open || false}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  on: { ...value.on, open: checked as boolean },
                })
              }
            />
            <Label htmlFor="onOpen" className="text-sm font-normal">
              When an issue is opened
            </Label>
          </div>
          <div className="space-y-2">
            <Label htmlFor="filterLabels" className="text-sm font-normal">
              Only issues with all of these labels
            </Label>
            <LabelListInput
              id="filterLabels"
              value={value.filter.labels}
              placeholder="e.g., bug, p1 (comma-separated)"
              onChange={(labels) =>
                onChange({
                  ...value,
                  filter: { ...value.filter, labels },
                })
              }
            />
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="onLabeled"
              checked={value.on.labeled || false}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  on: { ...value.on, labeled: checked as boolean },
                })
              }
            />
            <Label htmlFor="onLabeled" className="text-sm font-normal">
              Trigger when one of these labels is added
            </Label>
          </div>
          <div className="space-y-2">
            <Label htmlFor="excludeLabels" className="text-sm font-normal">
              Skip issues with any of these labels
            </Label>
            <LabelListInput
              id="excludeLabels"
              value={value.filter.excludeLabels}
              placeholder="e.g., wontfix, automata:finding (comma-separated)"
              onChange={(excludeLabels) =>
                onChange({
                  ...value,
                  filter: { ...value.filter, excludeLabels },
                })
              }
            />
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="otherAuthor"
              checked={value.filter.includeOtherAuthors}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  filter: {
                    ...value.filter,
                    includeOtherAuthors: checked as boolean,
                  },
                })
              }
            />
            <Label htmlFor="otherAuthor" className="text-sm font-normal">
              Include issues from other authors
            </Label>
          </div>
          {value.filter.includeOtherAuthors && (
            <>
              <div className="space-y-2">
                <FormLabel>Other authors</FormLabel>
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    <strong>Security Notice:</strong> Make sure you trust these
                    authors. Their issue contents will be read directly by the
                    agent when the automation runs.
                  </AlertDescription>
                </Alert>
                <Input
                  value={value.filter.otherAuthors || ""}
                  placeholder="e.g., octocat, sentry-io[bot], other-author"
                  onChange={(e) =>
                    onChange({
                      ...value,
                      filter: { ...value.filter, otherAuthors: e.target.value },
                    })
                  }
                />
              </div>
            </>
          )}
          <div className="flex items-center space-x-2">
            <Checkbox
              id="autoArchive"
              checked={value.autoArchiveOnComplete}
              onCheckedChange={(checked) =>
                onChange({
                  ...value,
                  autoArchiveOnComplete: checked as boolean,
                })
              }
            />
            <Label htmlFor="autoArchive" className="text-sm font-normal">
              Auto-archive task when agent completes
            </Label>
          </div>
        </div>
      </div>
      {errorMessage && (
        <p className="text-sm text-destructive">{errorMessage}</p>
      )}
    </div>
  );
}
