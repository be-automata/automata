import { combineThreadStatuses } from "@/agent/thread-status";
import { cn } from "@/lib/utils";
import { ThreadInfo, ThreadStatus } from "@terragon/shared";
import { File, Calendar } from "lucide-react";
import type React from "react";
import { RunStateGlyph } from "@/components/ui/run-state";

type MinimalThreadStatus =
  | "unread" // Thread is unread
  | "scheduled" // Thread is scheduled
  | "draft" // Thread saved as draft, not submitted
  | "pending" // Combines: queued, queued-tasks-concurrency, queued-sandbox-creation-rate-limit
  | "active" // Combines: booting, working
  | "finishing" // Combines: stopping, checkpointing, working-done
  | "complete" // Final state
  | "error"; // Any error state

function getMinimalStatus(detailedStatus: ThreadStatus): MinimalThreadStatus {
  const statusMap: Record<ThreadStatus, MinimalThreadStatus> = {
    draft: "draft",
    scheduled: "scheduled",
    queued: "pending",
    "queued-tasks-concurrency": "pending",
    "queued-sandbox-creation-rate-limit": "pending",
    "queued-agent-rate-limit": "pending",
    "queued-blocked": "pending", // deprecated but still mapping
    booting: "active",
    working: "active",
    stopping: "finishing",
    checkpointing: "finishing",
    "working-done": "finishing",
    complete: "complete",
    "working-error": "error",
    "working-stopped": "finishing",
    stopped: "complete",
    error: "error",
  };

  return statusMap[detailedStatus] || "pending";
}

function getStatusLabel({
  status,
  isError,
}: {
  status: ThreadStatus;
  isError?: boolean;
}): string {
  if (isError) {
    return "Error";
  }
  const labels: Record<ThreadStatus, string> = {
    draft: "Draft",
    queued: "Queued",
    scheduled: "Scheduled",
    "queued-tasks-concurrency": "Waiting for sandbox",
    "queued-sandbox-creation-rate-limit": "Rate limited",
    "queued-agent-rate-limit": "Agent rate limit reached",
    "queued-blocked": "Blocked",
    booting: "Starting",
    working: "Running",
    stopping: "Stopping",
    checkpointing: "Wrapping up",
    "working-done": "Finishing",
    complete: "Complete",
    "working-error": "Error",
    "working-stopped": "Stopped",
    stopped: "Stopped",
    error: "Error",
  };

  return labels[status] || status;
}

export function ThreadStatusIndicator({
  thread,
}: {
  thread: Pick<ThreadInfo, "isUnread" | "threadChats" | "draftMessage">;
}) {
  const status = combineThreadStatuses(
    thread.threadChats.map((chat) => chat.status),
  );
  const isError = thread.threadChats.some((chat) => chat.errorMessage !== null);
  return (
    <MinimalStatusIndicator
      isUnread={thread.isUnread}
      isDraft={!!thread.draftMessage}
      status={status}
      isError={isError}
    />
  );
}

function MinimalStatusIndicator({
  isUnread,
  isDraft,
  isError,
  status,
  className,
}: {
  isUnread: boolean;
  isDraft: boolean;
  status: ThreadStatus;
  isError: boolean;
  className?: string;
}) {
  let minimalStatus = getMinimalStatus(status);
  // active should take precedence over unread
  if (isUnread && minimalStatus !== "active") {
    minimalStatus = "unread";
  } else if (isError) {
    minimalStatus = "error";
  } else if (isDraft) {
    minimalStatus = "draft";
  }

  // Ops Desk shape grammar (components/ui/run-state.tsx); draft and scheduled
  // are not run states, so they keep a muted icon.
  const icons: Record<MinimalThreadStatus, React.ReactNode> = {
    draft: <File strokeWidth={2.5} className="size-3 text-muted-foreground" />,
    scheduled: (
      <Calendar strokeWidth={3} className="size-3 text-muted-foreground" />
    ),
    pending: <RunStateGlyph kind="waiting" />,
    active: <RunStateGlyph kind="running" />,
    finishing: <RunStateGlyph kind="running" />,
    complete: <RunStateGlyph kind="done" />,
    error: <RunStateGlyph kind="needs-you" />,
    unread: (
      <span className="inline-block size-1.5 rounded-full bg-foreground" />
    ),
  };
  return (
    <div
      className={cn(
        "flex size-3 flex-shrink-0 items-center justify-center",
        className,
      )}
      title={getStatusLabel({ status, isError })}
    >
      {icons[minimalStatus]}
    </div>
  );
}
