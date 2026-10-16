import { combineThreadStatuses } from "@/agent/thread-status";
import { cn } from "@/lib/utils";
import { ThreadInfo, ThreadStatus } from "@terragon/shared";
import { runStateFor } from "@terragon/shared/model/run-state";
import { File, Calendar } from "lucide-react";
import { RunStateGlyph } from "@/components/ui/run-state";

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

/**
 * The task-list glyph: the shared run-state grammar (components/ui/run-state)
 * with three local overlays that are not run states — draft, scheduled, and an
 * unread dot on a run that is no longer live.
 */
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
  const state = runStateFor({ status, hasError: isError });
  const isLive = state.kind === "running" || state.kind === "waiting";
  const glyph =
    isDraft && !isLive ? (
      <File strokeWidth={2.5} className="size-3 text-muted-foreground" />
    ) : status === "scheduled" ? (
      <Calendar strokeWidth={3} className="size-3 text-muted-foreground" />
    ) : isUnread && !isLive && state.kind !== "needs-you" ? (
      <span className="inline-block size-1.5 rounded-full bg-foreground" />
    ) : (
      <RunStateGlyph kind={state.kind} />
    );
  const label = isDraft && !isLive ? "draft" : state.word;
  return (
    <div
      className={cn(
        "flex size-3 flex-shrink-0 items-center justify-center",
        className,
      )}
      title={label}
    >
      {glyph}
      <span className="sr-only">{label}</span>
    </div>
  );
}
