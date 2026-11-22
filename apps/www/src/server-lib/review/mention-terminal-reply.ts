import { db } from "@/lib/db";
import type { TerminalCause } from "@terragon/shared/model/terminal-cause";

/** One thread a typed terminal moved; the chat when the caller knows it. */
export interface MentionTerminalTarget {
  threadId: string;
  threadChatId?: string;
  /** #743: a timed-out run whose one automatic continuation was already spent. */
  continuationLimitReached?: boolean;
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

/**
 * #743 scope 6: reconcile the thread's in-flight add-on calls before a
 * re-dispatch. An explicit no-op while `ADDON_CALLBACK_SECRET` is unset (the
 * receiver refuses everything then, so no call can be in flight); a real
 * reconcile lands with the dispatcher. It never re-sends a call.
 */
export async function reconcileAddonCalls(_args: {
  threadId: string;
}): Promise<{ reason: "receiver-off" }> {
  return { reason: "receiver-off" };
}

export interface TerminalContinuationInput {
  threadId: string;
  threadChatId: string;
  runExternalId: string;
  cause: TerminalCause;
  /** Post the mention reply when the run is not continued. False on a redelivery. */
  reply: boolean;
  /** Worker-reported class: the run started fresh after a failed restore. */
  startedFresh?: string;
}

/**
 * #743 phase 10: the run-terminal hook. On a `timeout` it reconciles add-on
 * calls, then asks the continuation decision. A continued run DEFERS the
 * mention reply to the final run; a spent budget names the limit in the reply;
 * every other outcome keeps today's reply. FAIL-OPEN: nothing here throws, and
 * an error counts as "not continued" so a mention is never left silent.
 */
export async function continueOrReplyAtTerminal(
  input: TerminalContinuationInput,
  reconcile: typeof reconcileAddonCalls = reconcileAddonCalls,
): Promise<void> {
  const { threadId, threadChatId, runExternalId, cause } = input;
  let limitReached = false;
  if (cause === "timeout") {
    try {
      const { maybeContinueAfterTimeout } = await import(
        "@/server-lib/cell-session/continuation"
      );
      await reconcile({ threadId });
      if (input.startedFresh) {
        console.log(
          `continuation: source run started fresh (${input.startedFresh}) thread=${threadId}`,
        );
      }
      // The checkpoint row the decision requires is written only by a plain
      // cell task run (OD-5), so it is the lane proof; pass the task lane.
      const decision = await maybeContinueAfterTimeout({
        threadId,
        threadChatId,
        runExternalId,
        cause,
        lane: "task",
      });
      if (decision.action === "continue") return;
      limitReached = decision.reason === "budget-spent";
    } catch (error) {
      console.error(
        `continuation: hook failed (${error instanceof Error ? error.name : "unknown"}) thread=${threadId}`,
      );
    }
  }
  if (input.reply) {
    await replyToMentionsAtTerminal([
      {
        threadId,
        threadChatId,
        ...(limitReached ? { continuationLimitReached: true } : {}),
      },
    ]);
  }
}
