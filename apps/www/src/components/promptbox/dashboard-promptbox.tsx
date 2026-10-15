"use client";

import React, { useCallback, useMemo, useState } from "react";
import {
  usePromptBox,
  HandleSubmitArgs as UsePromptBoxHandleSubmitArgs,
  HandleSubmit as UsePromptBoxHandleSubmit,
  HandleUpdate,
  HandleStop,
} from "./use-promptbox";
import { SimplePromptBox } from "./simple-promptbox";
import { useRepositoryCache } from "./typeahead/repository-cache";
import { ThreadStatus } from "@terragon/shared";
import {
  useSelectedRepo,
  useSelectedBranch,
} from "@/hooks/useSelectedRepoAndBranch";
import { RepoBranchSelector } from "../repo-branch-selector";
import { CredentialsWarning } from "./credentials-warning";
import { RunsInCue } from "./runs-in-cue";
import { RepoScopeHint } from "./repo-scope-hint";
import { useUserReposQuery } from "@/queries/user-repo-queries";
import { resolveSelectedRepo } from "@/lib/resolve-selected-repo";
import { useCredentialInfoForAgent } from "@/atoms/user-credentials";
import {
  PromptBoxToolBelt,
  usePromptBoxToolBeltOptions,
} from "./prompt-box-tool-belt";
import { useAccessInfo } from "@/queries/subscription";
import { useActiveOrganization } from "@/queries/organization-queries";
import { modelToAgent } from "@terragon/agent/utils";

export type DashboardPromptBoxHandleSubmit = (
  args: UsePromptBoxHandleSubmitArgs & {
    disableGitCheckpointing: boolean;
    skipSetup: boolean;
    createNewBranch: boolean;
    /** The org the page showed; the server refuses the task if it moved. */
    expectedOrganizationId: string | null | undefined;
  },
) => Promise<void>;

interface DashboardPromptBoxProps {
  placeholder?: string;
  threadId: string | null;
  status: ThreadStatus | null;
  promptText?: string;
  handleStop: HandleStop;
  onUpdate: HandleUpdate;
  handleSubmit: DashboardPromptBoxHandleSubmit;
}

export function DashboardPromptBox(props: DashboardPromptBoxProps) {
  const [storedRepoFullName, setRepoFullName] = useSelectedRepo();
  const [storedBranchName, setBranchName] = useSelectedBranch();
  // The stored selection is per user; ignore it when the active org's repo
  // list does not hold it (see resolveSelectedRepo).
  const { data: repoData, isLoading: isRepoListLoading } = useUserReposQuery();
  const {
    repoFullName,
    branchName,
    pending: isRepoPending,
  } = resolveSelectedRepo({
    selectedRepoFullName: storedRepoFullName || null,
    selectedBranch: storedBranchName || null,
    repos: repoData?.repos,
    isLoading: isRepoListLoading,
  });
  const [isRecording, setIsRecording] = useState(false);
  const onRepoBranchChange = useCallback(
    (repo: string | null, branch: string | null) => {
      setRepoFullName(repo);
      setBranchName(branch);
    },
    [setRepoFullName, setBranchName],
  );

  const repositoryCache = useRepositoryCache({
    repoFullName: repoFullName ?? "",
    branchName: branchName ?? "",
  });

  const {
    skipSetup,
    disableGitCheckpointing,
    createNewBranch,
    setSkipSetup,
    setDisableGitCheckpointing,
    setCreateNewBranch,
  } = usePromptBoxToolBeltOptions({
    branchName,
    shouldUseCookieValues: true,
  });
  const { isActive } = useAccessInfo();
  const { expectedOrganizationId } = useActiveOrganization();

  const placeholderText = useMemo(() => {
    if (props.placeholder != null) return props.placeholder;
    if (!repoFullName || !branchName) {
      return "Select a repository and branch to start...";
    }
    return "Type your message here... Use @ to mention files (Enter to send)";
  }, [props.placeholder, repoFullName, branchName]);

  const wrappedHandleSubmit: UsePromptBoxHandleSubmit = useCallback(
    async ({
      userMessage,
      selectedModels,
      repoFullName,
      branchName,
      saveAsDraft,
      scheduleAt,
    }) => {
      return props.handleSubmit({
        userMessage,
        selectedModels,
        repoFullName,
        branchName,
        saveAsDraft,
        scheduleAt,
        disableGitCheckpointing,
        skipSetup,
        createNewBranch,
        expectedOrganizationId,
      });
    },
    [
      props,
      disableGitCheckpointing,
      skipSetup,
      createNewBranch,
      expectedOrganizationId,
    ],
  );

  const {
    editor,
    attachedFiles,
    isSubmitting,
    isSubmitDisabled: baseIsSubmitDisabled,
    handleFilesAttached,
    removeFile,
    submitForm,
    permissionMode,
    setPermissionMode,
    selectedModel,
    selectedModels,
    setSelectedModel,
    isMultiAgentMode,
    setIsMultiAgentMode,
  } = usePromptBox({
    ...props,
    placeholderText,
    repoFullName,
    branchName,
    forcedAgent: null,
    forcedAgentVersion: null,
    initialSelectedModel: null,
    persistSelectedModelToUserFlags: true,
    typeahead: repositoryCache,
    clearContentBeforeSubmit: false,
    requireRepoAndBranch: true,
    storageKeyPrefix: "prompt-box-input-dashboard",
    isRecording,
    initialPermissionMode: "allowAll",
    handleSubmit: wrappedHandleSubmit,
    supportsMultiAgentPromptSubmission: true,
  });

  const selectedAgent = modelToAgent(selectedModel);
  const credentialInfo = useCredentialInfoForAgent(selectedAgent);

  const isSubmitDisabled =
    baseIsSubmitDisabled ||
    (credentialInfo && !credentialInfo.canInvokeAgent) ||
    !isActive ||
    // Until the active org's repo list arrives, the stored repo may belong to
    // the org the user just switched away from.
    isRepoPending;

  // Set content when promptText changes
  React.useEffect(() => {
    if (props.promptText && editor) {
      editor.commands.setContent(props.promptText);
      editor.commands.focus();
    }
  }, [props.promptText, editor]);

  return (
    <div className="flex flex-col gap-2">
      <SimplePromptBox
        forcedAgent={null}
        forcedAgentVersion={null}
        editor={editor}
        attachedFiles={attachedFiles}
        handleFilesAttached={handleFilesAttached}
        removeFile={removeFile}
        isSubmitting={isSubmitting}
        submitForm={submitForm}
        handleStop={props.handleStop}
        isSubmitDisabled={isSubmitDisabled}
        showStopButton={false}
        hideSubmitButton={false}
        className="min-h-[120px]"
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        selectedModels={selectedModels}
        isMultiAgentMode={isMultiAgentMode}
        setIsMultiAgentMode={setIsMultiAgentMode}
        supportsMultiAgentPromptSubmission={true}
        onRecordingChange={setIsRecording}
        typeahead={repositoryCache}
        supportSaveAsDraft={true}
        supportSchedule={true}
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
        submitCue={<RunsInCue repoFullName={repoFullName} />}
      />
      <CredentialsWarning selectedModel={selectedModel} />
      <div className="flex items-center justify-between w-full">
        <RepoBranchSelector
          selectedRepoFullName={repoFullName || null}
          selectedBranch={branchName || null}
          onChange={onRepoBranchChange}
        />

        <PromptBoxToolBelt
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
      <RepoScopeHint className="px-2 sm:px-4" />
    </div>
  );
}
