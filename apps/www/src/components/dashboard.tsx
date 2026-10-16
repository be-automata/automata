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
import { RecommendedTasks } from "./recommended-tasks";
import { AgentActivityBoard } from "./activity/agent-activity-board";
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
  const [showAllTasks, setShowAllTasks] = useState(showArchived);
  const selectedModel = useAtomValue(selectedModelAtom);

  // Determine if there are any active tasks; used for Sawyer UI empty state
  const { data } = useInfiniteThreadList({ archived: false });
  const showRecommendedTasks =
    (data?.pages.flatMap((page) => page) ?? []).length < 3;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col">
      <FeatureUpsellToast />
      <div className="flex flex-1 flex-col gap-8 pb-8 pt-4">
        <AgentActivityBoard />
        {showRecommendedTasks && (
          <div className="hidden space-y-2 lg:block">
            <h2 className="text-[15px] font-bold leading-5">Suggested tasks</h2>
            <RecommendedTasks
              onTaskSelect={(p) => setPromptText(p)}
              selectedModel={selectedModel}
            />
          </div>
        )}
        {mounted && (
          <section aria-label="All tasks">
            <button
              type="button"
              aria-expanded={showAllTasks}
              onClick={() => setShowAllTasks((open) => !open)}
              className="flex w-full items-center gap-2 border-b border-border pb-1.5 text-left"
            >
              <span className="text-[15px] font-bold leading-5">All tasks</span>
              <span className="text-xs text-muted-foreground">
                {showAllTasks ? "hide" : "show"}
              </span>
            </button>
            {showAllTasks ? (
              <ThreadListMain
                queryFilters={{ archived: showArchived }}
                viewFilter={showArchived ? "archived" : "active"}
                allowGroupBy={true}
                showSuggestedTasks={false}
                setPromptText={setPromptText}
              />
            ) : null}
          </section>
        )}
      </div>
      {/* Docked like a terminal prompt: activity owns the top of the page. */}
      <div className="sticky bottom-0 z-10 border-t border-border bg-background pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <DashboardPromptBox
          placeholder={placeholder}
          status={null}
          threadId={null}
          onUpdate={onUpdate}
          handleStop={handleStop}
          handleSubmit={handleSubmit}
          promptText={promptText ?? undefined}
        />
      </div>
    </div>
  );
}
