import { db } from "@/lib/db";

/**
 * #668: the typed terminal causes a mention stays silent for. A policy cause
 * cannot reach a mention (no prKey, so the engine never supersedes, discards
 * or stale-skips it) and a person stopped a `user-cancelled` run on purpose.
 * Every other cause — `plane-offline` included, unlike the review lane's
 * `ABANDONED_TERMINAL_CAUSES` — is a run that never answered: no newer run
 * speaks for a mention, so silence here is silence forever.
 */
const MENTION_SILENT_CAUSES: ReadonlySet<string> = new Set([
  "superseded",
  "discarded",
  "stale-skipped",
  "user-cancelled",
]);

export function isMentionSilentCause(cause: string | null): boolean {
  return cause !== null && MENTION_SILENT_CAUSES.has(cause);
}

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
