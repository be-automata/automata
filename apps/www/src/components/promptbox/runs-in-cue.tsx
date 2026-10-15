"use client";

import React from "react";

import { OrgAvatar } from "@/components/org-avatar";
import { useActiveOrganization } from "@/queries/organization-queries";
import { cn } from "@/lib/utils";

/**
 * Names where a new task will run before it starts: the active org and the
 * selected repository. Renders nothing until both are known.
 */
export function RunsInCue({
  repoFullName,
  className,
}: {
  repoFullName: string | null;
  className?: string;
}) {
  const { activeOrganization } = useActiveOrganization();
  return (
    <RunsInCueView
      organization={activeOrganization}
      repoFullName={repoFullName}
      className={className}
    />
  );
}

export function RunsInCueView({
  organization,
  repoFullName,
  className,
}: {
  organization: { id: string; name: string; logo?: string | null } | null;
  repoFullName: string | null;
  className?: string;
}) {
  if (!organization || !repoFullName) {
    return null;
  }
  const label = `Runs in ${organization.name} · ${repoFullName}`;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
        className,
      )}
      title={label}
    >
      <span className="shrink-0">Runs in</span>
      <OrgAvatar organization={organization} className="size-4 text-[8px]" />
      <span className="min-w-0 truncate font-medium">{organization.name}</span>
      <span className="shrink-0" aria-hidden="true">
        ·
      </span>
      <span className="min-w-0 truncate font-[var(--font-geist-mono)]">
        {repoFullName}
      </span>
    </div>
  );
}
