"use client";

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRouter } from "next/navigation";
import type {
  DBUserMessage,
  ThreadChatInfoFull,
  ThreadInfo,
} from "@terragon/shared";
import { GenericPromptBox } from "../promptbox/generic-promptbox";
import { redoThread } from "@/server-actions/redo-thread";
import { RepoBranchSelector } from "../repo-branch-selector";
import {
  PromptBoxToolBelt,
  usePromptBoxToolBeltOptions,
} from "../promptbox/prompt-box-tool-belt";
import { useServerActionMutation } from "@/queries/server-action-helpers";

export function RedoTaskDialog({
  thread,
  threadChat,
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thread: ThreadInfo;
  threadChat: ThreadChatInfoFull;
}) {
  const permissionMode = threadChat.permissionMode ?? "allowAll";
  const messages = useMemo(
    () => threadChat.messages ?? [],
    [threadChat.messages],
  );
  const router = useRouter();
  const [repoFullName, setRepoFullName] = useState<string>(
    thread.githubRepoFullName,
  );
  const [branchName, setBranchName] = useState<string>(
    thread.repoBaseBranchName,
  );
  const {
    createNewBranch,
    setCreateNewBranch,
    disableGitCheckpointing,
    skipSetup,
    setDisableGitCheckpointing,
    setSkipSetup,
    skipArchiving,
    setSkipArchiving,
  } = usePromptBoxToolBeltOptions({
    branchName,
    shouldUseCookieValues: false,
    initialDisableGitCheckpointing: !!thread.disableGitCheckpointing,
    initialSkipSetup: !!thread.skipSetup,
    initialCreateNewBranch: true,
  });

  const redoThreadMutation = useServerActionMutation({
    mutationFn: async ({ userMessage }: { userMessage: DBUserMessage }) => {
      return await redoThread({
        threadId: thread.id,
        userMessage,
        repoFullName,
        branchName,
        disableGitCheckpointing,
        skipArchiving,
        skipSetup,
      });
    },
    onSuccess: () => {
      onOpenChange(false);
      router.push("/dashboard");
    },
  });

  const userMessageToRetry = useMemo(() => {
    // Get the model from the last user message
    let messageModel: DBUserMessage["model"] = null;
    const msg: DBUserMessage = {
      type: "user",
      model: messageModel,
      parts: [],
    };
    for (const message of messages || []) {
      if (message.type === "user") {
        // Get the model from the first user message we encounter
        if (!messageModel && message.model) {
          messageModel = message.model;
          msg.model = messageModel;
        }
        msg.parts.push(...message.parts);
        continue;
      }
      if (
        message.type === "stop" ||
        message.type === "error" ||
        message.type === "meta" ||
        // #209 item 1: not agent output — it must not end the prefill scan.
        message.type === "credential-source"
      ) {
        continue;
      }
      break;
    }
    return msg;
  }, [messages]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] flex flex-col">
        <DialogHeader>
          <DialogTitle>Try this task again!</DialogTitle>
          <DialogDescription>
            Edit your initial message below. A new task will be created with
            your updated message.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 flex-1 overflow-y-auto min-h-0">
          <GenericPromptBox
            className="min-h-[200px] max-h-[80dvh]"
            placeholder="Edit your initial message..."
            message={{
              ...userMessageToRetry,
              permissionMode,
            }}
            repoFullName={repoFullName}
            branchName={branchName}
            onSubmit={redoThreadMutation.mutateAsync}
            hideSubmitButton={false}
            autoFocus={true}
            forcedAgent={null}
            forcedAgentVersion={null}
          />
          <div className="flex items-center justify-between">
            <RepoBranchSelector
              selectedRepoFullName={repoFullName}
              selectedBranch={branchName}
              onChange={(repoFullName, branchName) => {
                if (repoFullName) {
                  setRepoFullName(repoFullName);
                }
                if (branchName) {
                  setBranchName(branchName);
                }
              }}
            />
            <PromptBoxToolBelt
              showSkipArchive={true}
              skipArchiveValue={skipArchiving}
              onSkipArchiveChange={setSkipArchiving}
              showSkipSetup={true}
              skipSetupValue={skipSetup}
              onSkipSetupChange={setSkipSetup}
              skipSetupDisabled={!repoFullName}
              showCheckpoint={true}
              checkpointValue={disableGitCheckpointing}
              onCheckpointChange={setDisableGitCheckpointing}
              checkpointDisabled={!repoFullName}
              showCreateNewBranchOption={true}
              createNewBranchValue={createNewBranch}
              onCreateNewBranchChange={setCreateNewBranch}
              createNewBranchDisabled={!repoFullName}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
