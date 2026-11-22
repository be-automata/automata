import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/lib/db";
import { isAgentWorking } from "@/agent/thread-status";
import { maybeProcessFollowUpQueue } from "@/server-lib/process-follow-up-queue";
import { taskRunPushBranch } from "@/server-lib/task/remote-task-pr";
import type { DB } from "@terragon/shared/db";
import { thread as threadTable } from "@terragon/shared/db/schema";
import type { DBUserMessage } from "@terragon/shared";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { getCellSessionHead } from "@terragon/shared/model/cell-session-checkpoint";
import {
  CELL_SESSION_CONTINUATION_BUDGET,
  claimContinuation,
  countContinuations,
  getContinuationBySourceRun,
  markContinuationDispatched,
  releaseContinuation,
} from "@terragon/shared/model/cell-session-continuation";
import {
  getThreadChat,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import type { TerminalCause } from "@terragon/shared/model/terminal-cause";
import type { RunDisplayLane } from "@terragon/utils/run-lane";

/** Why a timed-out run is not continued. `error` = the decision itself failed (fail closed). */
export type ContinuationNoneReason =
  | "flag-off"
  | "not-timeout"
  | "lane"
  | "budget-spent"
  | "no-checkpoint"
  | "shadow"
  | "already-claimed"
  | "superseded"
  | "error";

export type ContinuationDecision =
  | {
      action: "continue";
      /** Completed turns in the checkpoint the continuation restores. */
      turn: number;
      ordinal: number;
    }
  | { action: "none"; reason: ContinuationNoneReason };

export interface ContinuationInput {
  threadId: string;
  threadChatId: string;
  /** The attempt: the run that ended. It is the fence and the ledger key. */
  runExternalId: string;
  cause: TerminalCause;
  /** The run's lane. Only a plain task run is continued (OD-5). */
  lane: RunDisplayLane;
}

/** The thread columns the decision and the message need. */
export interface ContinuationThread {
  userId: string;
  shadow: boolean;
  archived: boolean;
  activeRunExternalId: string | null;
  terminalCause: string | null;
  branch: string | null;
}

export interface ContinuationDeps {
  db: DB;
  /** The `cellSessionContinuation` flag for the thread's owner (default off). */
  isEnabled(args: { userId: string }): Promise<boolean>;
  readThread(args: { threadId: string }): Promise<ContinuationThread | null>;
  /**
   * The queue write. A throw here means nothing was queued. Resolves true when
   * the chat was idle BEFORE the write (read first, as queueFollowUpInternal
   * does: the write itself moves the status), so the queue should be drained.
   */
  queueWrite(args: {
    userId: string;
    threadId: string;
    threadChatId: string;
    message: DBUserMessage;
  }): Promise<boolean>;
  /** Drains the queue (idle chat only). A throw here is AFTER the write: the claim stays (F7). */
  drain(args: {
    userId: string;
    threadId: string;
    threadChatId: string;
  }): Promise<void>;
  log(message: string): void;
}

/** The continuation message: constants, the turn number and the work branch only (C7). */
export function renderContinuationMessage({
  turn,
  branch,
  ordinal = 1,
  budget = CELL_SESSION_CONTINUATION_BUDGET,
}: {
  turn: number;
  branch: string;
  ordinal?: number;
  budget?: number;
}): string {
  return (
    `Automatic continuation ${ordinal} of ${budget}: the previous run hit its time limit ` +
    `after ${turn} completed turns. This conversation was restored from its checkpoint, ` +
    `and unfinished work was saved to the work branch \`${branch}\`. ` +
    `Continue the task from where it stopped. Do not redo steps you already completed; ` +
    `check the work branch and your earlier results first.`
  );
}

/**
 * `updateThreadChat` commits the row and THEN awaits a broadcast. A throw after
 * the commit means the message exists, so it must count as written (the claim
 * stays; a release would let a retry queue a second copy). Only a write that
 * did not land rethrows. The read-back is the arbiter; if it fails too, the
 * original error propagates (release is then the safe side of an unknown).
 */
export async function appendQueuedMessageOnce({
  write,
  isCommitted,
  log,
}: {
  write: () => Promise<unknown>;
  isCommitted: () => Promise<boolean>;
  log: (message: string) => void;
}): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (!(await isCommitted())) throw error;
    log(
      `continuation: queued message committed, post-write step failed (${error instanceof Error ? error.name : "unknown"})`,
    );
  }
}

function defaultDeps(): ContinuationDeps {
  const db = defaultDb;
  return {
    db,
    async readThread({ threadId }) {
      const [row] = await db
        .select({
          userId: threadTable.userId,
          shadow: threadTable.shadow,
          archived: threadTable.archived,
          activeRunExternalId: threadTable.activeRunExternalId,
          terminalCause: threadTable.terminalCause,
          branchName: threadTable.branchName,
          baseBranch: threadTable.repoBaseBranchName,
          prNumber: threadTable.githubPRNumber,
          sourceMetadata: threadTable.sourceMetadata,
        })
        .from(threadTable)
        .where(eq(threadTable.id, threadId))
        .limit(1);
      if (!row) return null;
      const branch =
        taskRunPushBranch({
          threadId,
          prNumber: row.prNumber ?? undefined,
          branch: row.branchName ?? row.baseBranch,
          baseBranch: row.baseBranch,
          sourceMetadata: row.sourceMetadata,
        }) ??
        row.branchName ??
        row.baseBranch;
      return {
        userId: row.userId,
        shadow: row.shadow,
        archived: row.archived,
        activeRunExternalId: row.activeRunExternalId,
        terminalCause: row.terminalCause,
        branch: branch ?? null,
      };
    },
    async queueWrite({ userId, threadId, threadChatId, message }) {
      const threadChat = await getThreadChat({
        db,
        threadId,
        userId,
        threadChatId,
      });
      if (!threadChat) throw new Error("Thread chat not found");
      await appendQueuedMessageOnce({
        write: () =>
          updateThreadChat({
            db,
            userId,
            threadId,
            threadChatId,
            updates: { appendQueuedMessages: [message] },
          }),
        isCommitted: async () => {
          const after = await getThreadChat({
            db,
            threadId,
            userId,
            threadChatId,
          });
          return (after?.queuedMessages ?? []).some(
            (m) => m.timestamp === message.timestamp,
          );
        },
        log: (m) => console.log(m),
      });
      return !isAgentWorking(threadChat.status);
    },
    async drain({ userId, threadId, threadChatId }) {
      await maybeProcessFollowUpQueue({ userId, threadId, threadChatId });
    },
    isEnabled: ({ userId }) =>
      getFeatureFlagForUser({
        db,
        userId,
        flagName: "cellSessionContinuation",
      }),
    log: (message) => console.log(message),
  };
}

/**
 * #743 phase 9: decide whether a timed-out cell task run continues in a new cell,
 * and claim the one continuation. Runs at most once per run (the ledger's UNIQUE
 * source-run key), and at most `CELL_SESSION_CONTINUATION_BUDGET` times per thread.
 *
 * Order (F4): the budget is checked BEFORE the checkpoint, so a second timeout
 * names the limit even when the continued run wrote no checkpoint. The checkpoint
 * row is the proof of "a cell run" (only a cell task run writes one, OD-5).
 *
 * Claim life (F7): claim, queue write, mark dispatched, drain. A throw BEFORE the
 * queue write releases the claim; a throw after it keeps it (the message exists).
 * NEVER throws: a failure is `none` / `error`, so a mention is never left silent.
 */
export async function maybeContinueAfterTimeout(
  input: ContinuationInput,
  deps: ContinuationDeps = defaultDeps(),
): Promise<ContinuationDecision> {
  const none = (reason: ContinuationNoneReason): ContinuationDecision => {
    deps.log(
      `continuation: none (${reason}) thread=${input.threadId} run=${input.runExternalId}`,
    );
    return { action: "none", reason };
  };
  try {
    const { db } = deps;
    if (input.cause !== "timeout") return none("not-timeout");
    if (input.lane !== "task") return none("lane");
    // The flag is per owner, so it needs the thread; a missing thread falls
    // through to `superseded` below.
    const owner = await deps.readThread({ threadId: input.threadId });
    if (owner && !(await deps.isEnabled({ userId: owner.userId }))) {
      return none("flag-off");
    }
    if (
      await getContinuationBySourceRun({
        db,
        sourceRunExternalId: input.runExternalId,
      })
    ) {
      return none("already-claimed");
    }
    if (
      (await countContinuations({ db, threadId: input.threadId })) >=
      CELL_SESSION_CONTINUATION_BUDGET
    ) {
      return none("budget-spent");
    }
    const head = await getCellSessionHead({
      db,
      threadId: input.threadId,
      threadChatId: input.threadChatId,
    });
    if (
      !head ||
      head.lastRunExternalId !== input.runExternalId ||
      head.headTurn < 1
    ) {
      return none("no-checkpoint");
    }
    const thread = await deps.readThread({ threadId: input.threadId });
    if (
      !thread ||
      thread.archived ||
      thread.terminalCause !== "timeout" ||
      thread.activeRunExternalId !== input.runExternalId
    ) {
      return none("superseded");
    }
    // A shadow thread is never drained, so a claimed message would sit unread.
    if (thread.shadow) return none("shadow");
    const claim = await claimContinuation({
      db,
      threadId: input.threadId,
      threadChatId: input.threadChatId,
      sourceRunExternalId: input.runExternalId,
      checkpointManifestId: head.headManifestId,
      checkpointTurn: head.headTurn,
    });
    if (!claim.claimed) return none(claim.reason);

    const message: DBUserMessage = {
      type: "user",
      model: null,
      parts: [
        {
          type: "text",
          text: renderContinuationMessage({
            turn: head.headTurn,
            branch: thread.branch ?? "the work branch",
            ordinal: claim.ordinal,
          }),
        },
      ],
      timestamp: new Date().toISOString(),
    };
    const target = {
      userId: thread.userId,
      threadId: input.threadId,
      threadChatId: input.threadChatId,
    };
    let idle: boolean;
    try {
      idle = await deps.queueWrite({ ...target, message });
    } catch (error) {
      // Nothing was queued: release, so a redelivered terminal can retry.
      await releaseContinuation({ db, id: claim.id });
      throw error;
    }
    // The message exists from here on: the claim is never released (F7).
    try {
      await markContinuationDispatched({ db, id: claim.id });
      if (idle) await deps.drain(target);
      deps.log(
        `continuation: dispatched (ordinal ${claim.ordinal}) thread=${input.threadId}`,
      );
    } catch {
      deps.log(
        `continuation: claimed, not dispatched thread=${input.threadId} run=${input.runExternalId}`,
      );
    }
    return { action: "continue", turn: head.headTurn, ordinal: claim.ordinal };
  } catch (error) {
    deps.log(
      `continuation: failed thread=${input.threadId} (${error instanceof Error ? error.name : "unknown"})`,
    );
    return none("error");
  }
}
