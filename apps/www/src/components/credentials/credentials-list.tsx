"use client";

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Trash2 } from "lucide-react";
import { useAtomValue } from "jotai";
import {
  useCredentials,
  useDeleteCredentialsMutation,
  useToggleActiveCredentialMutation,
} from "@/queries/credentials-queries";
import type { AgentProviderCredentialsMap } from "@/server-lib/credentials";
import { AIAgent } from "@terragon/agent/types";
import {
  getAgentDisplayName,
  isConnectedCredentialsSupported,
} from "@terragon/agent/utils";
import { AgentIcon } from "@/components/chat/agent-icon";
import { credentialKindInfo } from "@terragon/shared/model/credential-kind";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { allAgentsAtom } from "@/atoms/user";

type CredentialData = NonNullable<AgentProviderCredentialsMap[AIAgent]>[number];

function CredentialDeleteButton({
  credential,
  agent,
  onDelete,
  deletePending,
}: {
  credential: CredentialData;
  agent: AIAgent;
  onDelete: () => void;
  deletePending: boolean;
}) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  // A connected ACCOUNT is disconnected, a pasted secret is deleted. Reading this
  // from the shared kind map (rather than `type === "oauth"`) is what stops a new
  // credential kind from silently inheriting the wrong copy.
  const isOAuth = credentialKindInfo(credential.type).isConnection;
  const agentName = getAgentDisplayName(agent);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="size-5 p-2 opacity-50 hover:opacity-100"
        onClick={() => setShowDeleteDialog(true)}
        disabled={deletePending}
        aria-label={isOAuth ? "Disconnect" : "Delete"}
      >
        <Trash2 className="h-4 w-4 text-muted-foreground" />
      </Button>
      <DeleteConfirmationDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        onConfirm={() => {
          onDelete();
          setShowDeleteDialog(false);
        }}
        title={isOAuth ? "Disconnect Subscription" : "Delete Credential"}
        description={
          isOAuth
            ? `Are you sure you want to disconnect your ${agentName} subscription? This action cannot be undone.`
            : `Are you sure you want to delete this ${agentName} credential? This action cannot be undone.`
        }
        confirmText={isOAuth ? "Disconnect" : "Delete"}
        isLoading={deletePending}
      />
    </>
  );
}

type CredentialWithAgent = CredentialData & {
  agent: AIAgent;
  agentName: string;
};

function CredentialsListItem({
  credential,
}: {
  credential: CredentialWithAgent;
}) {
  const deleteMutation = useDeleteCredentialsMutation();
  const toggleActiveMutation = useToggleActiveCredentialMutation();
  return (
    <div
      className={cn("p-3 bg-muted/50 rounded-lg border border-border", {
        "opacity-50": !credential.isActive,
      })}
    >
      <div className="grid grid-cols-[auto_1fr_auto_auto] gap-3">
        {/* Icon column */}
        <div className="flex items-start pt-1">
          <AgentIcon agent={credential.agent} sessionId={null} />
        </div>
        {/* Text column */}
        <div className="flex flex-col min-w-0">
          <div className="flex flex-row items-center gap-2">
            <span className="text-sm font-medium truncate">
              {credential.agentName}
            </span>
            <Badge variant="outline" className="text-xs">
              {credentialKindInfo(credential.type).label}
            </Badge>
          </div>
          {/* A setup-token can carry an accountEmail when the optional profile
              probe happened to succeed, so gate on "has account metadata to
              show", not on the kind being interactive OAuth. */}
          {credential.type !== "api-key" &&
            credential.metadata &&
            typeof credential.metadata === "object" && (
              <div className="flex flex-col gap-0.5 mt-0.5">
                {/* Claude OAuth - accountEmail */}
                {"accountEmail" in credential.metadata &&
                  credential.metadata.accountEmail && (
                    <span className="text-xs text-muted-foreground font-mono">
                      {String(credential.metadata.accountEmail)}
                    </span>
                  )}
                {/* Codex OAuth - email, planType, chatgptAccountId */}
                {credential.agent === "codex" &&
                  "email" in credential.metadata &&
                  credential.metadata.email && (
                    <span className="text-xs text-muted-foreground font-mono">
                      {String(credential.metadata.email)}
                    </span>
                  )}
              </div>
            )}
        </div>
        {/* Switch column */}
        <div className="flex items-start pt-0.5">
          <Switch
            checked={credential.isActive}
            onCheckedChange={async (newChecked) => {
              await toggleActiveMutation.mutateAsync({
                credentialId: credential.id,
                isActive: newChecked,
              });
            }}
          />
        </div>
        {/* Trash column */}
        <div className="flex items-start pt-0.5">
          <CredentialDeleteButton
            credential={credential}
            agent={credential.agent}
            onDelete={() => {
              deleteMutation.mutateAsync({ credentialId: credential.id });
            }}
            deletePending={deleteMutation.isPending}
          />
        </div>
      </div>
    </div>
  );
}

export function CredentialsList() {
  const allAgents = useAtomValue(allAgentsAtom);
  // Filter to only show agents that support credentials
  const agents = allAgents.filter((agent) => {
    return isConnectedCredentialsSupported(agent);
  });
  const { data: agentProviderCredentials } = useCredentials();
  const allCredentials = useMemo(() => {
    return agents.flatMap((agent) => {
      const credentials = agentProviderCredentials?.[agent] || [];
      return credentials.map((credential) => ({
        ...credential,
        agent,
        agentName: getAgentDisplayName(agent),
      }));
    });
  }, [agentProviderCredentials, agents]);

  if (!agentProviderCredentials) {
    return (
      <div className="p-6 text-center">
        <p className="text-sm text-muted-foreground">Loading credentials...</p>
      </div>
    );
  }
  if (allCredentials.length === 0) {
    return (
      <div className="p-6 text-center border-dashed rounded-md">
        <p className="text-sm text-muted-foreground">
          No credentials added yet.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {allCredentials.map((credential) => (
        <CredentialsListItem key={credential.id} credential={credential} />
      ))}
    </div>
  );
}
