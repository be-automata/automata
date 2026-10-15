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
import { OrgAvatar } from "../org-avatar";
import { SlackConnectDialog, SlackInstallDialog } from "./slack-target-dialogs";

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
  const { activeOrganization } = useActiveOrganization();
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
      expectedOrganizationId: activeOrganization?.id ?? null,
    });
    window.location.href = appInstallUrl;
  };

  const isConnected = !!account.installation;
  const boundOrganizationId = account.installation?.organizationId ?? null;
  const boundOrganization =
    myOrganizations?.organizations.find(
      (org) => org.id === boundOrganizationId,
    ) ?? null;
  const boundElsewhere =
    isConnected &&
    !!boundOrganizationId &&
    boundOrganizationId !== activeOrganization?.id;

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
                <>
                  <OrgAvatar
                    organization={boundOrganization}
                    className="size-4 text-[8px]"
                  />
                  <span className="font-medium text-foreground">
                    {boundOrganization.name}
                  </span>
                </>
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
  const canConnect = slackAppReady && !getSlackOAuthUrlMutation.isPending;
  const { activeOrganization } = useActiveOrganization();
  const [connectOpen, setConnectOpen] = useState(false);
  const handleConnect = async (teamId: string | undefined) => {
    const authUrl = await getSlackOAuthUrlMutation.mutateAsync({
      teamId,
      expectedOrganizationId: activeOrganization?.id ?? null,
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
  // Has connections - show workspaces and settings
  return (
    <div className="flex flex-col w-full gap-2">
      {accounts.map((account) => {
        return (
          <SlackAccountItem
            key={account.id}
            account={account}
            slackAppReady={slackAppReady}
          />
        );
      })}
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
