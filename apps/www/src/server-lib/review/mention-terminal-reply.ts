import { db } from "@/lib/db";

/**
 * #668: answer the mentions whose threads a typed terminal just ended (the
 * worker's run-terminal post, the supersede sweep, the stalled watchdog).
 * Those paths never reach the daemon finish, the only other writer of a
 * mention reply, so without this the person who mentioned the App waits on
 * silence forever. Pass ONLY the ids the terminal write moved.
 *
 * The writer is imported on call, like every finish writer in
 * handle-daemon-event, so the light modules that call this (a route, the
 * sweeps) do not load the review stack eagerly. Never throws: a reply failure
 * must not undo or fail the terminal write that came before it.
 */
export async function replyToMentionsAtTerminal(
  threadIds: readonly string[],
): Promise<void> {
  if (threadIds.length === 0) return;
  try {
    const { handleMentionRepliesAtTerminal } = await import(
      "./mention-reply-finish"
    );
    await handleMentionRepliesAtTerminal({ db, threadIds });
  } catch (error) {
    console.error("[mention-reply] terminal reply failed (non-fatal)", {
      threadIds,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
