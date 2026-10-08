"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { checkTrackerConfig } from "@/server-actions/admin/tracker-config";
import type { TrackerConfigDiagnostic } from "@/server-lib/tracker/tracker-config-diagnostic";

/**
 * Staff check: what the post-merge audit would resolve for an org + repo
 * (organization → owner's repository environment, never personal Global).
 */
export function TrackerConfigCheck() {
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [repoFullName, setRepoFullName] = useState("");
  const [result, setResult] = useState<TrackerConfigDiagnostic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <h2 className="text-base font-medium">Tracker config check</h2>
      <p className="text-xs text-muted-foreground">
        Resolves the post-merge audit&apos;s tracker settings for an org and
        repository and shows which layer each key came from. The token is never
        shown.
      </p>
      <div className="flex gap-2">
        <Input
          placeholder="org slug"
          value={organizationSlug}
          onChange={(event) => setOrganizationSlug(event.target.value)}
        />
        <Input
          placeholder="owner/repo"
          value={repoFullName}
          onChange={(event) => setRepoFullName(event.target.value)}
        />
        <Button
          disabled={pending || !organizationSlug.trim() || !repoFullName.trim()}
          onClick={async () => {
            setPending(true);
            setError(null);
            try {
              setResult(
                await checkTrackerConfig({ organizationSlug, repoFullName }),
              );
            } catch (caught) {
              setResult(null);
              setError(
                caught instanceof Error ? caught.message : "Check failed",
              );
            } finally {
              setPending(false);
            }
          }}
        >
          Check
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {result && (
        <>
          {"mixedLayers" in result && result.mixedLayers && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              YOUTRACK_URL and YOUTRACK_TOKEN come from different layers —
              usually a stale repository override.
            </p>
          )}
          <pre className="text-xs bg-muted p-3 rounded-md overflow-auto">
            {JSON.stringify(result, null, 2)}
          </pre>
        </>
      )}
    </div>
  );
}
