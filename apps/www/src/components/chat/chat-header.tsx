"use client";

import Link from "next/link";
import { memo, useState, useRef, useEffect } from "react";
import { getThreadTitle } from "@/agent/thread-utils";
import { PRStatusPill } from "../pr-status-pill";
import { ThreadInfoFull } from "@terragon/shared";
import { toast } from "sonner";
import { Pill } from "@/components/shared/pill";
import { ChatHeaderButtons } from "./chat-header-buttons";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import posthog from "posthog-js";
import { ThreadStatusIndicator } from "@/components/thread-status";
import { RunStatusChip } from "@/components/chat/run-status-chip";
import { Input } from "@/components/ui/input";
import { useUpdateThreadNameMutation } from "@/queries/thread-mutations";
import { AutomationPill } from "@/components/automations/pill";
import { Eye, CloudOff, PanelRightClose, Split, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCollapsibleThreadList } from "../thread-list/use-collapsible-thread-list";
import { ThreadAgentIcon } from "../thread-agent-icon";

export const ChatHeader = memo(function ChatHeader({
  thread,
  isReadOnly,
  onHeaderClick,
  onTerminalClick,
}: {
  thread: ThreadInfoFull;
  isReadOnly: boolean;
  onHeaderClick?: () => void;
  onTerminalClick?: () => void;
}) {
  const { isMobile } = useSidebar();
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState(thread.name || "");
  const inputRef = useRef<HTMLInputElement>(null);
  const updateNameMutation = useUpdateThreadNameMutation();
  const {
    canCollapseThreadList,
    isThreadListCollapsed,
    setThreadListCollapsed,
  } = useCollapsibleThreadList();
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = () => {
    const trimmedName = editedName.trim();
    // Don't submit if name is empty or unchanged
    if (!trimmedName || trimmedName === thread.name) {
      setIsEditing(false);
      setEditedName(thread.name || "");
      return;
    }
    updateNameMutation.mutate(
      {
        threadId: thread.id,
        name: trimmedName,
      },
      {
        onSuccess: () => {
          setIsEditing(false);
        },
        onError: () => {
          setEditedName(thread.name || "");
        },
      },
    );
  };

  const handleCancel = () => {
    setIsEditing(false);
    setEditedName(thread.name || "");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };
  return (
    <>
      <div
        className="flex w-full items-center justify-between px-4 border-b bg-card/80 backdrop-blur gap-2 sm:gap-4 overflow-hidden h-[62px]"
        onClick={isMobile ? onHeaderClick : undefined}
        style={isMobile ? { cursor: "pointer" } : undefined}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isMobile && <SidebarTrigger className="px-0 size-auto w-fit mr-2" />}
          {canCollapseThreadList && isThreadListCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setThreadListCollapsed(false)}
              className="w-fit mr-2 flex-shrink-0"
              title="Show task list"
            >
              <PanelRightClose className="h-4 w-4" />
            </Button>
          )}
          <div className="flex flex-col min-w-0 w-full">
            <div className="flex items-center gap-2 w-full">
              <ThreadStatusIndicator thread={thread} />
              <RunStatusChip
                terminalCause={thread.terminalCause}
                supersededByThreadId={thread.supersededByThreadId}
              />
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                {isEditing ? (
                  <Input
                    ref={inputRef}
                    value={editedName}
                    onChange={(e) => setEditedName(e.target.value)}
                    onBlur={handleSave}
                    onKeyDown={handleKeyDown}
                    className="h-auto py-0 px-0 text-sm font-bold border-0 bg-transparent focus-visible:ring-1 focus-visible:ring-ring rounded-sm -ml-0.5 w-full"
                    placeholder={getThreadTitle(thread)}
                    style={{ minWidth: "100px" }}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                ) : (
                  <span className="font-bold text-sm text-foreground truncate">
                    {getThreadTitle(thread)}
                  </span>
                )}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <ThreadAgentIcon thread={thread} />
                  {thread.githubPRNumber && thread.prStatus && (
                    <PRStatusPill
                      checksStatus={thread.prChecksStatus}
                      status={thread.prStatus}
                      prNumber={thread.githubPRNumber}
                      repoFullName={thread.githubRepoFullName}
                    />
                  )}
                </div>
              </div>
            </div>
            {/* metadata */}
            <div className="text-muted-foreground text-xs font-mono flex items-center gap-1.5 h-5 min-w-0">
              <span className="flex-shrink-0 whitespace-nowrap">
                {thread.githubRepoFullName}
              </span>
              {thread.branchName && thread.repoBaseBranchName && (
                <span className="hidden sm:inline-flex items-center gap-0.5 min-w-0 overflow-hidden">
                  <span className="flex-shrink-0">(</span>
                  <a
                    href={`https://github.com/${thread.githubRepoFullName}/tree/${thread.repoBaseBranchName}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-foreground truncate min-w-[30px] max-w-[200px] block"
                    onClick={() => {
                      posthog.capture("base_branch_link_clicked", {
                        repoFullName: thread.githubRepoFullName,
                        baseBranchName: thread.repoBaseBranchName,
                      });
                    }}
                    title={thread.repoBaseBranchName}
                  >
                    {thread.repoBaseBranchName}
                  </a>
                  <span className="text-muted-foreground flex-shrink-0 mx-1">
                    ←
                  </span>
                  <a
                    href={`https://github.com/${thread.githubRepoFullName}/tree/${thread.branchName}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-foreground truncate min-w-[35px] block"
                    onClick={() => {
                      posthog.capture("head_branch_link_clicked", {
                        repoFullName: thread.githubRepoFullName,
                        branchName: thread.branchName,
                      });
                    }}
                    title={thread.branchName}
                  >
                    {thread.branchName}
                  </a>
                  <button
                    type="button"
                    className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors cursor-pointer ml-1"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      try {
                        navigator.clipboard.writeText(thread.branchName!);
                        posthog.capture("branch_name_copied", {
                          repoFullName: thread.githubRepoFullName,
                          branchName: thread.branchName,
                        });
                        toast.success("Copied branch name");
                      } catch (err) {
                        console.error("Failed to copy branch name", err);
                      }
                    }}
                    title="Copy branch name"
                    aria-label="Copy branch name"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                  <span>)</span>
                </span>
              )}
              {thread.disableGitCheckpointing && (
                <span
                  className="inline-flex items-center ml-1 align-middle"
                  title="Git checkpointing disabled"
                >
                  <CloudOff className="h-3 w-3 text-muted-foreground opacity-70" />
                </span>
              )}
              <span className="flex items-center gap-1.5">
                {thread.automationId && (
                  <AutomationPill
                    automationId={thread.automationId}
                    isReadOnly={isReadOnly}
                  />
                )}
                {thread.archived && <Pill label="Archived" />}
              </span>
            </div>
          </div>
        </div>
        <ChatHeaderButtons
          thread={thread}
          onRenameClick={() => setIsEditing(true)}
          isReadOnly={isReadOnly}
          onTerminalClick={onTerminalClick}
        />
      </div>
      {thread.sourceType === "www-fork" && (
        <div className="flex w-full items-center px-4 py-2 border-b bg-muted overflow-hidden">
          {(isMobile || isThreadListCollapsed) && (
            <div
              className="px-0 size-auto w-fit block"
              style={{ width: "32px" }}
              aria-hidden="true"
            />
          )}
          <div className="flex flex-col gap-0.5 flex-1">
            <div className="flex items-center gap-2">
              <Split className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-mono font-medium line-clamp-1">
                Forked from{" "}
                <Link
                  href={`/task/${thread.parentThreadId}`}
                  className="underline"
                >
                  {thread.parentThreadName ?? ""}
                </Link>
              </span>
            </div>
          </div>
        </div>
      )}
      {isReadOnly && (
        <div className="flex w-full items-center px-4 py-2 border-b bg-muted overflow-hidden">
          {(isMobile || isThreadListCollapsed) && (
            <div
              className="px-0 size-auto w-fit block"
              style={{ width: "32px" }}
              aria-hidden="true"
            />
          )}
          <div className="flex flex-col gap-0.5 flex-1">
            <div className="flex items-center gap-2">
              <Eye className="h-2.5 w-2.5 text-muted-foreground" />
              <span className="text-xs font-mono font-medium whitespace-nowrap">
                View only
              </span>
              <span className="text-xs font-mono text-muted-foreground">
                · Viewing someone else's task
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
});
