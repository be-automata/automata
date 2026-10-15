"use client";

import { ArrowRight, Slack, type LucideIcon } from "lucide-react";
import React, { useEffect, useState } from "react";

import { OrgName } from "@/components/org-avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseSlackTeamId } from "@/lib/slack-team-id";
import { cn } from "@/lib/utils";
import type { MyOrganization } from "@/server-actions/organizations";

/**
 * The org an action will land in, named before the user commits to it: the
 * subject (a Slack workspace, a GitHub account) → the org. Install and bind
 * route future work to this org, so it is a receipt to read, not a generic
 * OAuth hand-off.
 */
export function TargetLine({
  icon: Icon,
  subject,
  subjectClassName,
  organization,
}: {
  icon: LucideIcon;
  subject: string;
  subjectClassName?: string;
  organization: MyOrganization | null;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <Icon className="size-4 shrink-0" />
      <span className={cn("truncate font-medium", subjectClassName)}>
        {subject}
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      {organization ? (
        <OrgName
          organization={organization}
          size="sm"
          nameClassName="font-medium"
        />
      ) : (
        <span className="text-muted-foreground">No organization</span>
      )}
    </div>
  );
}

/**
 * Install binds the workspace to the org for good, and the card the button
 * sits on names whichever workspace the user's Slack account is linked to —
 * which need not be the org's own (a user in two orgs linked one workspace,
 * then switched org). So the user must say, in so many words, that this
 * workspace belongs to this org before Slack is opened.
 */
export function SlackInstallConfirmation({
  workspaceName,
  workspaceId,
  organization,
  confirmed,
  onConfirmedChange,
}: {
  workspaceName: string;
  workspaceId: string;
  organization: MyOrganization | null;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
}) {
  const orgName = organization?.name ?? "this organization";
  return (
    <div className="space-y-3">
      <TargetLine
        icon={Slack}
        subject={workspaceName}
        organization={organization}
      />
      <div className="flex items-start gap-2">
        <Checkbox
          id="slack-install-confirm"
          checked={confirmed}
          onCheckedChange={(value) => onConfirmedChange(value === true)}
          className="mt-0.5"
        />
        <Label htmlFor="slack-install-confirm" className="text-sm leading-snug">
          {workspaceName} (<span className="font-mono">{workspaceId}</span>) is{" "}
          {orgName}&apos;s Slack workspace
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">
        The workspace stays bound to {orgName}. Not the right workspace? Cancel,
        then use &ldquo;Connect another workspace&rdquo; with the ID of the
        workspace you want (it starts with T).
      </p>
    </div>
  );
}

export function SlackInstallDialog({
  open,
  onOpenChange,
  workspaceName,
  workspaceId,
  organization,
  isPending,
  onContinue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceName: string;
  workspaceId: string;
  organization: MyOrganization | null;
  isPending: boolean;
  onContinue: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  // Every opening asks again.
  useEffect(() => {
    if (!open) {
      setConfirmed(false);
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Install Slack into {organization?.name ?? "no organization"}
          </DialogTitle>
          <DialogDescription>
            Mentions of the bot in this workspace will start tasks in this
            organization, with its environment and credentials.
          </DialogDescription>
        </DialogHeader>
        <SlackInstallConfirmation
          workspaceName={workspaceName}
          workspaceId={workspaceId}
          organization={organization}
          confirmed={confirmed}
          onConfirmedChange={setConfirmed}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={onContinue}
            disabled={isPending || !organization || !confirmed}
          >
            <Slack className="size-4" />
            {isPending ? "Opening Slack…" : "Continue to Slack"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SlackConnectDialog({
  open,
  onOpenChange,
  organization,
  isPending,
  onContinue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organization: MyOrganization | null;
  isPending: boolean;
  onContinue: (teamId: string | undefined) => void;
}) {
  const [workspace, setWorkspace] = useState("");
  const teamId = parseSlackTeamId(workspace);
  const invalid = workspace.trim() !== "" && !teamId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect a Slack workspace</DialogTitle>
          <DialogDescription>
            Links your Slack account so your mentions run as you
            {organization ? ` in ${organization.name}` : ""}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="slack-workspace">Workspace (optional)</Label>
          <Input
            id="slack-workspace"
            placeholder="T01ABCDEF or https://app.slack.com/client/T01ABCDEF/…"
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            aria-invalid={invalid}
            className="font-mono text-xs"
          />
          <p
            className={
              invalid
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {invalid
              ? "Paste a workspace ID (starts with T) or a Slack client URL."
              : "Slack signs you in to your browser's default workspace. To pick another, paste its ID: open it at app.slack.com and copy the part of the URL that starts with T."}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => onContinue(teamId ?? undefined)}
            disabled={isPending || invalid}
          >
            <Slack className="size-4" />
            {isPending ? "Opening Slack…" : "Continue to Slack"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
