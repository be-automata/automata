"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slack } from "lucide-react";
import { useUpdateSlackSettings } from "@/queries/slack-mutations";
import { ConnectionStatusPill } from "../credentials/connection-status-pill";
import { toast } from "sonner";
import {
  getSlackAppInstallUrl,
  getSlackOAuthUrl,
  disconnectSlackAccount,
} from "@/server-actions/slack";
import { useRouter } from "next/navigation";
import { ModelSelector } from "../model-selector";
import { RepoSelector } from "../repo-branch-selector";
import { useRealtimeUser } from "@/hooks/useRealtime";
import { SlackAccountWithMetadata } from "@terragon/shared/db/types";
import { AIModel } from "@terragon/agent/types";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import {
  useActiveOrganization,
  useMyOrganizations,
} from "@/queries/organization-queries";
import { OrgName } from "../org-avatar";
import { SlackConnectDialog, SlackInstallDialog } from "./slack-target-dialogs";
import { groupSlackAccounts } from "@/lib/slack-account-groups";

function SlackAccountItem({
  account,
  slackAppReady,
}: {
  account: SlackAccountWithMetadata;
  slackAppReady: boolean;
}) {
  const router = useRouter();
  const updateMutation = useUpdateSlackSettings();
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [defaultRepo, setDefaultRepo] = useState(
    account.settings?.defaultRepoFullName || "",
  );
  const [defaultModel, setDefaultModel] = useState<AIModel | null>(
    account.settings?.defaultModel || null,
  );
  const getSlackAppInstallUrlMutation = useServerActionMutation({
    mutationFn: getSlackAppInstallUrl,
  });
  const { activeOrganization, expectedOrganizationId } =
    useActiveOrganization();
  const { data: myOrganizations } = useMyOrganizations();
  const [installOpen, setInstallOpen] = useState(false);

  const handleDisconnect = async () => {
    try {
      setIsDisconnecting(true);
      await disconnectSlackAccount({ teamId: account.teamId });
      toast.success("Slack workspace disconnected");
      router.refresh();
    } catch (error) {
      console.error("Failed to disconnect Slack:", error);
      toast.error("Failed to disconnect Slack workspace");
    } finally {
      setIsDisconnecting(false);
    }
  };

  const handleInstallApp = async () => {
    // The team hint opens Slack on this card's workspace, not the browser's
    // default one.
    const appInstallUrl = await getSlackAppInstallUrlMutation.mutateAsync({
      teamId: account.teamId,
      expectedOrganizationId,
    });
    window.location.href = appInstallUrl;
  };

  const isConnected = !!account.installation;
  const boundOrganizationId = account.installation?.organizationId ?? null;
  const boundOrganization =
    myOrganizations?.organizations.find(
      (org) => org.id === boundOrganizationId,
    ) ?? null;
  // A bound org id implies an installation, so this is connected.
  const boundElsewhere =
    !!boundOrganizationId && boundOrganizationId !== activeOrganization?.id;

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-2 flex-1">
          <div className="flex items-center gap-2">
            <Slack className="h-5 w-5" />
            <span className="font-semibold">{account.slackTeamName}</span>
            <ConnectionStatusPill connected={isConnected} />
          </div>
          <p className="text-xs text-muted-foreground">
            Workspace ID: <span className="font-mono">{account.teamId}</span>
          </p>
          {isConnected && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Mentions run in
              {boundOrganization ? (
                <OrgName
                  organization={boundOrganization}
                  size="xs"
                  nameClassName="font-medium text-foreground"
                />
              ) : boundOrganizationId ? (
                <span className="font-medium text-foreground">
                  an organization you are not a member of
                </span>
              ) : (
                <span className="font-medium text-foreground">
                  no organization (personal)
                </span>
              )}
            </p>
          )}
          {boundElsewhere && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              This workspace is bound to a different organization than the one
              you are acting in. Settings below apply to your account only.
            </p>
          )}
        </div>
      </div>

      {!isConnected ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            The Slack app needs to be installed in your workspace to complete
            the setup.
          </p>
          <Button
            size="sm"
            onClick={() => setInstallOpen(true)}
            disabled={
              !slackAppReady ||
              !activeOrganization ||
              getSlackAppInstallUrlMutation.isPending
            }
          >
            <Slack className="h-4 w-4" />
            {activeOrganization
              ? `Install into ${activeOrganization.name}`
              : "Choose an organization to install"}
          </Button>
          <SlackInstallDialog
            open={installOpen}
            onOpenChange={setInstallOpen}
            workspaceName={account.slackTeamName}
            workspaceId={account.teamId}
            organization={activeOrganization}
            isPending={getSlackAppInstallUrlMutation.isPending}
            onContinue={handleInstallApp}
          />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="space-y-1">
              <Label className="text-sm">Default Repository</Label>
              <RepoSelector
                selectedRepoFullName={defaultRepo}
                onChange={(repoFullName) => {
                  if (repoFullName) {
                    setDefaultRepo(repoFullName);
                    updateMutation.mutate({
                      teamId: account.teamId,
                      settings: {
                        defaultRepoFullName: repoFullName,
                        defaultModel: defaultModel!,
                      },
                    });
                  }
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">Default Model</Label>
              <ModelSelector
                className="border-solid p-2 text-foreground bg-transparent dark:!bg-muted"
                forcedAgent={null}
                forcedAgentVersion={null}
                isMultiAgentMode={false}
                supportsMultiAgentPromptSubmission={false}
                setIsMultiAgentMode={() => {}}
                selectedModels={{}}
                selectedModel={defaultModel as any}
                setSelectedModel={({ model }: { model: AIModel }) => {
                  setDefaultModel(model);
                  updateMutation.mutate({
                    teamId: account.teamId,
                    settings: {
                      defaultModel: model,
                    },
                  });
                }}
              />
            </div>
          </div>
          <div className="space-x-2">
            <Button
              onClick={handleDisconnect}
              disabled={isDisconnecting}
              size="sm"
              variant="link"
              className="text-muted-foreground font-normal underline px-0 opacity-50 hover:opacity-100"
            >
              {isDisconnecting ? "Disconnecting..." : "Disconnect"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One of the user's other Slack sign-ins, shown under the active org's own
 * workspaces: installable into this org when no org has it yet, otherwise
 * named with the org that uses it.
 */
function OtherSlackAccountRow({
  account,
  slackAppReady,
}: {
  account: SlackAccountWithMetadata;
  slackAppReady: boolean;
}) {
  const router = useRouter();
  const [isRemoving, setIsRemoving] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const getSlackAppInstallUrlMutation = useServerActionMutation({
    mutationFn: getSlackAppInstallUrl,
  });
  const { activeOrganization, expectedOrganizationId } =
    useActiveOrganization();
  const { data: myOrganizations } = useMyOrganizations();
  const boundOrganizationId = account.installation?.organizationId ?? null;
  const boundOrganization =
    myOrganizations?.organizations.find(
      (org) => org.id === boundOrganizationId,
    ) ?? null;

  const handleRemove = async () => {
    try {
      setIsRemoving(true);
      await disconnectSlackAccount({ teamId: account.teamId });
      toast.success(`Removed your ${account.slackTeamName} sign-in`);
      router.refresh();
    } catch (error) {
      console.error("Failed to remove Slack sign-in:", error);
      toast.error("Failed to remove the Slack sign-in");
    } finally {
      setIsRemoving(false);
    }
  };

  const handleInstallApp = async () => {
    const appInstallUrl = await getSlackAppInstallUrlMutation.mutateAsync({
      teamId: account.teamId,
      expectedOrganizationId,
    });
    window.location.href = appInstallUrl;
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Slack className="h-4 w-4 shrink-0" />
          {account.slackTeamName}
          <span className="font-mono text-xs font-normal text-muted-foreground">
            {account.teamId}
          </span>
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {account.installation ? (
            <>
              Used by
              {boundOrganization ? (
                <OrgName
                  organization={boundOrganization}
                  size="xs"
                  nameClassName="font-medium text-foreground"
                />
              ) : (
                <span className="font-medium text-foreground">
                  {boundOrganizationId
                    ? "an organization you are not a member of"
                    : "no organization (personal)"}
                </span>
              )}
            </>
          ) : (
            "Not installed in any organization"
          )}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {!account.installation && activeOrganization && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setInstallOpen(true)}
              disabled={
                !slackAppReady || getSlackAppInstallUrlMutation.isPending
              }
            >
              Install into {activeOrganization.name}
            </Button>
            <SlackInstallDialog
              open={installOpen}
              onOpenChange={setInstallOpen}
              workspaceName={account.slackTeamName}
              workspaceId={account.teamId}
              organization={activeOrganization}
              isPending={getSlackAppInstallUrlMutation.isPending}
              onContinue={handleInstallApp}
            />
          </>
        )}
        <Button
          size="sm"
          variant="link"
          onClick={handleRemove}
          disabled={isRemoving}
          className="px-0 text-muted-foreground underline"
        >
          {isRemoving ? "Removing..." : "Remove"}
        </Button>
      </div>
    </div>
  );
}

export function SlackAccountSettings({
  accounts,
  slackAppReady,
}: {
  accounts: SlackAccountWithMetadata[];
  /** The active org's Slack app has every SLACK_* key it needs. */
  slackAppReady: boolean;
}) {
  const router = useRouter();
  useRealtimeUser({
    matches: (message) => !!message.data.slack,
    onMessage: () => router.refresh(),
  });
  const getSlackOAuthUrlMutation = useServerActionMutation({
    mutationFn: getSlackOAuthUrl,
  });
  const { activeOrganization, expectedOrganizationId, isLoading } =
    useActiveOrganization();
  // Wait for the org list so the request names the org the page shows.
  const canConnect =
    slackAppReady && !isLoading && !getSlackOAuthUrlMutation.isPending;
  const [connectOpen, setConnectOpen] = useState(false);
  const handleConnect = async (teamId: string | undefined) => {
    const authUrl = await getSlackOAuthUrlMutation.mutateAsync({
      teamId,
      expectedOrganizationId,
    });
    window.location.href = authUrl;
  };
  const connectDialog = (
    <SlackConnectDialog
      open={connectOpen}
      onOpenChange={setConnectOpen}
      organization={activeOrganization}
      isPending={getSlackOAuthUrlMutation.isPending}
      onContinue={handleConnect}
    />
  );

  // No connections - show connect prompt
  if (accounts.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-lg w-full">
        <p className="text-sm">
          Connect your Slack workspace to interact with Terragon through Slack
        </p>
        <div className="flex">
          <Button
            size="sm"
            onClick={() => setConnectOpen(true)}
            disabled={!canConnect}
          >
            <Slack className="h-4 w-4" />
            {getSlackOAuthUrlMutation.isPending
              ? "Connecting..."
              : "Connect Slack Workspace"}
          </Button>
        </div>
        {connectDialog}
      </div>
    );
  }
  // The active org's workspaces get full cards; the user's other sign-ins
  // are listed apart, so another org's workspace is never offered as this
  // org's.
  const groups = groupSlackAccounts(accounts, activeOrganization?.id ?? null);
  const others = [...groups.notInstalled, ...groups.otherOrganization];
  return (
    <div className="flex flex-col w-full gap-2">
      {groups.inOrganization.length === 0 && activeOrganization && (
        <p className="text-sm text-muted-foreground">
          No Slack workspace is installed in {activeOrganization.name} yet.
        </p>
      )}
      {groups.inOrganization.map((account) => (
        <SlackAccountItem
          key={account.id}
          account={account}
          slackAppReady={slackAppReady}
        />
      ))}
      {others.length > 0 && (
        // Open while the org has none of its own, so installing one is not
        // hidden behind a click.
        <details
          className="rounded-lg border px-4 py-2"
          open={groups.inOrganization.length === 0}
        >
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Other Slack workspaces you are signed in to ({others.length})
          </summary>
          <div className="divide-y">
            {others.map((account) => (
              <OtherSlackAccountRow
                key={account.id}
                account={account}
                slackAppReady={slackAppReady}
              />
            ))}
          </div>
        </details>
      )}
      <div className="flex">
        <Button
          variant="link"
          onClick={() => setConnectOpen(true)}
          disabled={!canConnect}
          className="underline cursor-pointer"
        >
          {getSlackOAuthUrlMutation.isPending
            ? "Connecting..."
            : "Connect another workspace"}
        </Button>
      </div>
      {connectDialog}
    </div>
  );
}
