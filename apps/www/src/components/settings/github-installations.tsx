"use client";

import { Github } from "lucide-react";
import { useState } from "react";

import { OrgAvatar } from "@/components/org-avatar";
import { Button } from "@/components/ui/button";
import { getGHAppInstallUrl } from "@/lib/gh-app-url";
import {
  useBindGithubInstallation,
  useGithubInstallationsQuery,
} from "@/queries/github-installation-queries";
import { useActiveOrganization } from "@/queries/organization-queries";
import type { GithubInstallationRow } from "@/server-actions/bind-github-installation";
import type { MyOrganization } from "@/server-actions/organizations";
import { GithubInstallationBindDialog } from "./github-installation-dialog";

function BindingLabel({ row }: { row: GithubInstallationRow }) {
  if (row.binding.kind === "organization") {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <OrgAvatar
          organization={row.binding.organization}
          className="size-4 text-[8px]"
        />
        <span className="truncate font-medium text-foreground">
          {row.binding.organization.name}
        </span>
      </span>
    );
  }
  if (row.binding.kind === "other-organization") {
    return (
      <span className="font-medium text-foreground">Another organization</span>
    );
  }
  return <span className="font-medium text-foreground">Unbound</span>;
}

function modeLabel(mode: GithubInstallationRow["mode"]): string | null {
  if (mode === "active") return "Active";
  if (mode === "shadow") return "Shadow (no GitHub side effects)";
  return null;
}

export function GithubInstallationItem({
  row,
  activeOrganization,
  canBind,
  onBind,
}: {
  row: GithubInstallationRow;
  activeOrganization: MyOrganization | null;
  canBind: boolean;
  onBind: () => void;
}) {
  const accountLogin = row.accountLogin ?? `installation ${row.installationId}`;
  const boundHere =
    row.binding.kind === "organization" &&
    row.binding.organization.id === activeOrganization?.id;
  const mode = modeLabel(row.mode);
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <Github className="size-4 shrink-0" />
          <span className="truncate font-mono text-sm font-semibold">
            {accountLogin}
          </span>
          {row.accountType && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {row.accountType === "Organization" ? "Organization" : "User"}
            </span>
          )}
        </div>
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">Runs in</span>
          <BindingLabel row={row} />
          {mode && (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">{mode}</span>
            </>
          )}
        </p>
      </div>
      {boundHere ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          Bound to this organization
        </span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={onBind}
          disabled={!activeOrganization || !canBind}
          title={
            !activeOrganization
              ? "Choose an organization to bind"
              : !canBind
                ? "Only organization owners and admins can bind a GitHub account"
                : undefined
          }
        >
          {activeOrganization
            ? `Bind to ${activeOrganization.name}`
            : "Choose an organization to bind"}
        </Button>
      )}
    </div>
  );
}

/**
 * Settings → Integrations: which org each GitHub account (App installation)
 * the user can see runs in, and the control to bind one to the active org.
 */
export function GithubInstallationsCard({
  canBindToOrganization,
}: {
  canBindToOrganization: boolean;
}) {
  const { data, isLoading, isError, isFetching, refetch } =
    useGithubInstallationsQuery();
  const { activeOrganization, expectedOrganizationId } =
    useActiveOrganization();
  const bindMutation = useBindGithubInstallation();
  const [pending, setPending] = useState<GithubInstallationRow | null>(null);

  if (isLoading) {
    return (
      <p className="text-sm text-muted-foreground">Loading GitHub accounts…</p>
    );
  }
  if (isError && !data) {
    // A failed load is not "nothing installed": say so and offer a retry.
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Could not load your GitHub accounts. GitHub did not answer.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (data?.githubTokenMissing) {
    return (
      <p className="text-sm text-muted-foreground">
        Your GitHub connection expired. Reconnect GitHub to see your accounts.
      </p>
    );
  }
  const installations = data?.installations ?? [];
  if (installations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        The GitHub App is not installed on any account you can see.{" "}
        <a
          href={getGHAppInstallUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:no-underline"
        >
          Install it on GitHub
        </a>
        .
      </p>
    );
  }

  const pendingLogin =
    pending?.accountLogin ?? `installation ${pending?.installationId ?? ""}`;
  return (
    <div className="flex w-full flex-col gap-2">
      {installations.map((row) => (
        <GithubInstallationItem
          key={row.installationId}
          row={row}
          activeOrganization={activeOrganization}
          canBind={
            canBindToOrganization && expectedOrganizationId !== undefined
          }
          onBind={() => setPending(row)}
        />
      ))}
      <GithubInstallationBindDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        accountLogin={pendingLogin}
        organization={activeOrganization}
        currentlyBoundElsewhere={
          !!pending &&
          pending.binding.kind !== "unbound" &&
          !(
            pending.binding.kind === "organization" &&
            pending.binding.organization.id === activeOrganization?.id
          )
        }
        isPending={bindMutation.isPending}
        onConfirm={() => {
          if (!pending || !activeOrganization || !expectedOrganizationId) {
            return;
          }
          bindMutation.mutate(
            {
              installationId: pending.installationId,
              expectedOrganizationId,
              accountLogin: pendingLogin,
              organizationName: activeOrganization.name,
            },
            { onSettled: () => setPending(null) },
          );
        }}
      />
    </div>
  );
}
