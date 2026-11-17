import { db } from "@/lib/db";

/** One thread a typed terminal moved; the chat when the caller knows it. */
export interface MentionTerminalTarget {
  threadId: string;
  threadChatId?: string;
}

/**
 * #668: answer the mentions whose threads a typed terminal just ended (the
 * worker's run-terminal post, the supersede sweep, the stalled watchdog).
 * Those paths never reach the daemon finish, the only other writer of a
 * mention reply, so without this the person who mentioned the App waits on
 * silence forever. Pass ONLY the threads the terminal write moved.
 *
 * The writer is imported on call, like every finish writer in
 * handle-daemon-event, so the light modules that call this (a route, the
 * sweeps) do not load the review stack eagerly. Never throws: a reply failure
 * must not undo or fail the terminal write that came before it.
 */
export async function replyToMentionsAtTerminal(
  targets: readonly MentionTerminalTarget[],
): Promise<void> {
  if (targets.length === 0) return;
  try {
    const { handleMentionRepliesAtTerminal } = await import(
      "./mention-reply-finish"
    );
    await handleMentionRepliesAtTerminal({ db, targets });
  } catch (error) {
    console.error("[mention-reply] terminal reply failed (non-fatal)", {
      threadIds: targets.map((t) => t.threadId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
