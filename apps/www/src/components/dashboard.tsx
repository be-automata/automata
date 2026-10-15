"use client";

import {
  DashboardPromptBoxHandleSubmit,
  DashboardPromptBox,
} from "./promptbox/dashboard-promptbox";
import { ThreadListMain } from "./thread-list/main";
import { newThread } from "@/server-actions/new-thread";
import { useTypewriterEffect } from "@/hooks/useTypewriter";
import { useCallback, useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  threadQueryKeys,
  useInfiniteThreadList,
} from "@/queries/thread-queries";
import { convertToPlainText } from "@/lib/db-message-helpers";
import { HandleUpdate } from "./promptbox/use-promptbox";
import { cn } from "@/lib/utils";
import { RecommendedTasks } from "./recommended-tasks";
import { useAtomValue } from "jotai";
import { selectedModelAtom } from "@/atoms/user-flags";
import { FeatureUpsellToast } from "@/components/feature-upsell-toast";
import { unwrapError, unwrapResult } from "@/lib/server-actions";

export function Dashboard({
  showArchived = false,
}: {
  showArchived?: boolean;
}) {
  const [typewriterEffectEnabled, setTypewriterEffectEnabled] = useState(true);
  const placeholder = useTypewriterEffect(typewriterEffectEnabled);
  const queryClient = useQueryClient();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const handleSubmit = useCallback<DashboardPromptBoxHandleSubmit>(
    async ({
      userMessage,
      repoFullName,
      selectedModels,
      branchName,
      saveAsDraft,
      scheduleAt,
      disableGitCheckpointing,
      skipSetup,
      createNewBranch,
      expectedOrganizationId,
    }) => {
      try {
        unwrapResult(
          await newThread({
            expectedOrganizationId,
            message: userMessage,
            githubRepoFullName: repoFullName,
            branchName,
            saveAsDraft,
            disableGitCheckpointing,
            skipSetup,
            createNewBranch,
            scheduleAt,
            selectedModels,
          }),
        );
        if (!saveAsDraft) {
          queryClient.refetchQueries({
            queryKey: threadQueryKeys.list({ archived: showArchived }),
          });
        } else {
          // For drafts, stay on dashboard and update the list
          toast.success("Task saved as draft successfully.");
          queryClient.refetchQueries({
            queryKey: threadQueryKeys.list({ archived: showArchived }),
          });
        }
      } catch (error: any) {
        console.error("Failed to create thread:", error);
        toast.error(unwrapError(error), { duration: 5000 });
        throw error; // Re-throw to trigger onSubmitError in usePromptBox
      }
    },
    [queryClient, showArchived],
  );

  const handleStop = useCallback(async () => {
    throw new Error("Cannot stop thread in dashboard.");
  }, []);

  const onUpdate = useCallback<HandleUpdate>(({ userMessage }) => {
    const plainText = convertToPlainText({
      message: userMessage,
      skipAttachments: true,
    });
    setTypewriterEffectEnabled(plainText.length === 0);
  }, []);

  const [promptText, setPromptText] = useState<string | null>(null);
  const selectedModel = useAtomValue(selectedModelAtom);

  // Determine if there are any active tasks; used for Sawyer UI empty state
  const { data } = useInfiniteThreadList({ archived: false });
  const showRecommendedTasks =
    (data?.pages.flatMap((page) => page) ?? []).length < 3;

  return (
    <div
      className={cn(
        "flex flex-col h-full max-w-2xl w-full mx-auto gap-8 justify-start pt-2.5",
      )}
    >
      <FeatureUpsellToast />
      <DashboardPromptBox
        placeholder={placeholder}
        status={null}
        threadId={null}
        onUpdate={onUpdate}
        handleStop={handleStop}
        handleSubmit={handleSubmit}
        promptText={promptText ?? undefined}
      />
      {showRecommendedTasks && (
        <div className="space-y-2 hidden lg:block">
          <h3 className="text-sm font-medium text-muted-foreground/70">
            Suggested tasks
          </h3>
          <RecommendedTasks
            onTaskSelect={(p) => setPromptText(p)}
            selectedModel={selectedModel}
          />
        </div>
      )}
      {mounted && (
        <div className="lg:hidden">
          <ThreadListMain
            queryFilters={{ archived: showArchived }}
            viewFilter={showArchived ? "archived" : "active"}
            allowGroupBy={true}
            showSuggestedTasks={showRecommendedTasks}
            setPromptText={setPromptText}
          />
        </div>
      )}
    </div>
  );
}
