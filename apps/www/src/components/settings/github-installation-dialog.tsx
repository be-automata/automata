"use client";

import { ArrowRight, Github } from "lucide-react";

import { OrgAvatar } from "@/components/org-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MyOrganization } from "@/server-actions/organizations";

/**
 * Receipt before a GitHub account is bound to an org: the account, the org it
 * will run in, and what that changes. Same pattern as the Slack install
 * receipt (slack-target-dialogs.tsx).
 */
export function GithubInstallationBindDialog({
  open,
  onOpenChange,
  accountLogin,
  organization,
  currentlyBoundElsewhere,
  isPending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountLogin: string;
  organization: MyOrganization | null;
  currentlyBoundElsewhere: boolean;
  isPending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Bind {accountLogin} to {organization?.name ?? "no organization"}
          </DialogTitle>
          <DialogDescription>
            PR reviews, mentions, audits and automations for this account&apos;s
            repositories will run in this organization, with its environment and
            credentials. Its repositories show in the repo picker when you act
            in this organization.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <Github className="size-4 shrink-0" />
          <span className="truncate font-medium font-mono">{accountLogin}</span>
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
          {organization ? (
            <>
              <OrgAvatar organization={organization} className="size-5" />
              <span className="truncate font-medium">{organization.name}</span>
            </>
          ) : (
            <span className="text-muted-foreground">No organization</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {currentlyBoundElsewhere
            ? "This account is bound to another organization today. Moving it re-routes future work only: runs, reviews and threads that already exist stay where they are."
            : "Binding routes future work only: runs, reviews and threads that already exist stay where they are."}{" "}
          To bind it to a different organization, switch organization first (top
          of the sidebar).
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isPending || !organization}>
            <Github className="size-4" />
            {isPending
              ? "Binding…"
              : `Bind to ${organization?.name ?? "organization"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
