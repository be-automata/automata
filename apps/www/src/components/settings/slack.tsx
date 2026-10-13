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
    const appInstallUrl = await getSlackAppInstallUrlMutation.mutateAsync();
    window.location.href = appInstallUrl;
  };

  const isConnected = !!account.installation;

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
            Workspace ID: {account.teamId}
          </p>
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
            onClick={handleInstallApp}
            disabled={!slackAppReady || getSlackAppInstallUrlMutation.isPending}
          >
            <Slack className="h-4 w-4" />
            Install Slack App
          </Button>
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
  const handleConnect = async () => {
    const authUrl = await getSlackOAuthUrlMutation.mutateAsync();
    window.location.href = authUrl;
  };

  // No connections - show connect prompt
  if (accounts.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-lg w-full">
        <p className="text-sm">
          Connect your Slack workspace to interact with Terragon through Slack
        </p>
        <div className="flex">
          <Button size="sm" onClick={handleConnect} disabled={!canConnect}>
            <Slack className="h-4 w-4" />
            {getSlackOAuthUrlMutation.isPending
              ? "Connecting..."
              : "Connect Slack Workspace"}
          </Button>
        </div>
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
          onClick={handleConnect}
          disabled={!canConnect}
          className="underline cursor-pointer"
        >
          {getSlackOAuthUrlMutation.isPending
            ? "Connecting..."
            : "Connect another workspace"}
        </Button>
      </div>
    </div>
  );
}
