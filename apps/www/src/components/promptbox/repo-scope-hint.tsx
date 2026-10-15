"use client";

import Link from "next/link";
import React from "react";

import { cn } from "@/lib/utils";
import { useActiveOrganization } from "@/queries/organization-queries";
import { useUserReposQuery } from "@/queries/user-repo-queries";
import type { UserReposScope } from "@/server-actions/user-repos";

/**
 * One line under the repo picker when the active org has no GitHub account
 * bound: the list is then every repo the user's token can see, not the org's.
 */
export function RepoScopeHint({ className }: { className?: string }) {
  const { data } = useUserReposQuery();
  const { activeOrganization } = useActiveOrganization();
  return (
    <RepoScopeHintView
      scope={data?.scope}
      organizationName={activeOrganization?.name ?? null}
      className={className}
    />
  );
}

export function RepoScopeHintView({
  scope,
  organizationName,
  className,
}: {
  scope: UserReposScope | undefined;
  organizationName: string | null;
  className?: string;
}) {
  if (scope !== "unassigned" || !organizationName) {
    return null;
  }
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      No GitHub account is bound to {organizationName} yet — bind one in{" "}
      <Link
        href="/settings/integrations"
        className="underline hover:no-underline"
      >
        Settings → Integrations
      </Link>
      .
    </p>
  );
}
