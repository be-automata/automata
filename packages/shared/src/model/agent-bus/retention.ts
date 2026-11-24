import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  notExists,
  sql,
} from "drizzle-orm";

import type { DB } from "../../db";
import {
  agentApplied,
  agentMessagePruneCursor,
  agentMessages,
  thread,
  threadChat,
} from "../../db/schema";
import { assertPositiveInt } from "../../utils";
import { withSelfHealTx, type SelfHealTx } from "../self-heal-tx";
import {
  threadIsTerminal,
  threadLastWriteAt,
  threadTimestampParam,
} from "../thread-effective-status";

/**
 * How long a consumed message (and its idempotency key) outlives its sender
 * (spec #759, OD-1): 30 days, as `EFFECT_RETENTION_MS` and
 * `EGRESS_EVENTS_PRUNE_AFTER_MS`.
 */
export const AGENT_MESSAGE_RETENTION_MS = 30 * 86_400_000;

const PRUNE_TX_TIMEOUTS = { statementTimeoutMs: 10_000, lockTimeoutMs: 1_000 };

export interface AgentMessagePruneCounts {
  messages: number;
  applied: number;
  orphans: number;
}

/**
 * One or both passes of `pruneAgentMessages` threw. `errors` holds each pass's
 * error (orphan pass first); `counts` holds what still committed, including the
 * batches a failing pass finished before it threw.
 */
export class AgentMessagePruneError extends AggregateError {
  constructor(
    errors: unknown[],
    readonly counts: AgentMessagePruneCounts,
  ) {
    super(
      errors,
      `agent_messages prune: ${errors.length} pass(es) failed; still pruned ${counts.messages} consumed + ${counts.orphans} orphaned rows`,
    );
    this.name = "AgentMessagePruneError";
  }
}

/**
 * `thread` is never aliased: `threadIsTerminal()` and `threadLastWriteAt()`
 * correlate on `"thread"."id"`. The sender can no longer retry when its thread
 * is gone, or is terminal and last written more than R ago.
 */
function senderCannotRetry(cut: Date) {
  return notExists(
    sql`(select 1 from ${thread} where ${and(
      eq(thread.id, agentMessages.fromRun),
      sql`not (${and(
        threadIsTerminal(),
        lt(threadLastWriteAt(), threadTimestampParam(cut)),
      )})`,
    )})`,
  );
}

/**
 * Fences the senders of a consumed batch against a concurrent resume, inside the
 * batch transaction, and returns the senders whose messages may be deleted.
 *
 * A resume (`clearThreadTerminalForResume`, a status move) is an UPDATE of the
 * sender's `thread` row and/or its `thread_chat` rows. FOR SHARE is the weakest
 * row lock that conflicts with such an UPDATE (FOR KEY SHARE does not), so while
 * we hold it a resume waits for our commit; one that committed before is seen by
 * the re-check that follows. SKIP LOCKED: a sender being written right now is
 * skipped for this batch, never waited on. A sender counts as fenced only when
 * its thread row and every one of its chat rows were locked; a sender whose
 * thread is gone has nothing to resume and stays eligible. A new chat row (an
 * INSERT) is not blocked, but it cannot make a terminal sender live on its own:
 * that takes an UPDATE of the thread row or of the terminal chat row.
 */
async function fenceSenders(tx: SelfHealTx, senders: string[]) {
  const existing = await tx
    .select({ id: thread.id })
    .from(thread)
    .where(inArray(thread.id, senders));
  const lockedThreads = await tx
    .select({ id: thread.id })
    .from(thread)
    .where(inArray(thread.id, senders))
    .for("share", { skipLocked: true });
  const lockedChats = await tx
    .select({ id: threadChat.id })
    .from(threadChat)
    .where(inArray(threadChat.threadId, senders))
    .for("share", { skipLocked: true });
  const allChats = await tx
    .select({ id: threadChat.id, threadId: threadChat.threadId })
    .from(threadChat)
    .where(inArray(threadChat.threadId, senders));
  const exists = new Set(existing.map((r) => r.id));
  const threadLocked = new Set(lockedThreads.map((r) => r.id));
  const chatLocked = new Set(lockedChats.map((r) => r.id));
  const chatUnlocked = new Set(
    allChats.filter((c) => !chatLocked.has(c.id)).map((c) => c.threadId),
  );
  return senders.filter(
    (s) => !exists.has(s) || (threadLocked.has(s) && !chatUnlocked.has(s)),
  );
}

interface ConsumedCursor {
  consumedAt: Date;
  id: number;
}

const CONSUMED_CURSOR_ID = "consumed";

/**
 * The persisted cursor of the consumed pass (#769). `null` is "start from the
 * beginning" and is stored as no row, so a deployment whose table is empty
 * behaves as before the cursor existed.
 */
const consumedCursorStore = {
  async load(tx: SelfHealTx): Promise<ConsumedCursor | null> {
    const [row] = await tx
      .select({
        consumedAt: agentMessagePruneCursor.consumedAt,
        id: agentMessagePruneCursor.msgId,
      })
      .from(agentMessagePruneCursor)
      .where(eq(agentMessagePruneCursor.id, CONSUMED_CURSOR_ID));
    return row ?? null;
  },
  async save(tx: SelfHealTx, cursor: ConsumedCursor | null): Promise<void> {
    if (!cursor) {
      await tx
        .delete(agentMessagePruneCursor)
        .where(eq(agentMessagePruneCursor.id, CONSUMED_CURSOR_ID));
      return;
    }
    const value = {
      consumedAt: cursor.consumedAt,
      msgId: cursor.id,
      updatedAt: sql`now()`,
    };
    await tx
      .insert(agentMessagePruneCursor)
      .values({ id: CONSUMED_CURSOR_ID, ...value })
      .onConflictDoUpdate({ target: agentMessagePruneCursor.id, set: value });
  },
};

/** Deletes the messages and their `agent_applied` rows; returns how many applied rows went. */
async function deleteByIds(tx: SelfHealTx, ids: number[]) {
  const idList = sql`${sql.param(ids)}::bigint[]`;
  const applied = await tx
    .delete(agentApplied)
    .where(sql`${agentApplied.msgId} = any(${idList})`)
    .returning({ id: agentApplied.msgId });
  await tx
    .delete(agentMessages)
    .where(sql`${agentMessages.id} = any(${idList})`);
  return applied.length;
}

/**
 * UNFENCED retention sweep over every organization. Deletes, in bounded batches,
 *
 * - consumed messages older than R whose sender can no longer send in a way that
 *   counts as a retry (its thread is gone, or it is terminal and last written
 *   more than R ago), and
 * - unconsumed messages older than R whose target thread is gone (never
 *   delivered, the sweeper treats them as inert),
 *
 * together with their `agent_applied` rows. A live sender's keys are never
 * deleted, so a retried send stays idempotent for the sender's whole active
 * life plus at least R. Each consumed batch locks its senders' thread and chat
 * rows and re-checks the sender rule under that lock (`fenceSenders`), so a
 * resume racing the prune either waits for it or keeps its rows.
 *
 * The orphan pass runs first, then the consumed pass. Each runs in its own
 * try: a failure in one never prevents the other. If either threw, the call
 * rejects with `AgentMessagePruneError` once both have run, carrying every
 * error and the counts that committed (the cron logs it).
 * `maxBatches` applies per pass and `budgetMs` is shared: once it is spent, no
 * new batch starts, except that the consumed pass always gets its first batch,
 * so an orphan pass that spent the budget (slow, or timing out) cannot starve
 * it. The real upper bound on wall clock is `budgetMs` plus two in-flight
 * batches, each statement capped at the 10 s statement timeout. Throws
 * `RangeError` unless `batch` and `maxBatches` are positive integers and
 * `budgetMs` is a positive finite number. Logs nothing: the caller logs counts.
 *
 * The consumed pass resumes where the previous call stopped (#769): its first
 * batch starts from the cursor stored in `agent_message_prune_cursor`, and each
 * batch writes its last row's `(consumed_at, id)` there inside its own
 * transaction, so the cursor moves only with committed deletes. A short or
 * empty batch means the end of the range: it clears the cursor, and the next
 * call starts from the beginning again. So the kept rows (live or fenced
 * senders) are re-read once per full pass, not once per call, and kept rows at
 * the head of the index can no longer hold the pass back from the deletable
 * rows behind them. A row that becomes deletable behind the cursor waits for
 * the wrap, at most one full pass. Concurrent calls never delete a row twice
 * (FOR UPDATE SKIP LOCKED); the last batch to commit wins the cursor. The
 * orphan pass has no cursor.
 */
export async function pruneAgentMessages({
  db,
  now = new Date(),
  batch = 500,
  maxBatches = 10,
  budgetMs = 20_000,
}: {
  db: DB;
  now?: Date;
  batch?: number;
  maxBatches?: number;
  budgetMs?: number;
}): Promise<AgentMessagePruneCounts> {
  assertPositiveInt("batch", batch);
  assertPositiveInt("maxBatches", maxBatches);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new RangeError(`budgetMs must be a positive number, got ${budgetMs}`);
  }
  const cut = new Date(now.getTime() - AGENT_MESSAGE_RETENTION_MS);
  const startedAt = Date.now();
  const counts: AgentMessagePruneCounts = {
    messages: 0,
    applied: 0,
    orphans: 0,
  };
  const errors: unknown[] = [];

  /**
   * Runs one pass: each batch is its own transaction. `select(tx, cursor)` locks
   * up to `batch` candidate rows and returns them with the ids to delete (a
   * subset when a re-check keeps some) and the cursor of the last candidate.
   * With a `store`, the first batch loads its cursor from it, and every batch
   * saves its cursor (null on a short batch) in its own transaction.
   * Stops on a short or empty batch, `maxBatches`, or the shared budget, which
   * `firstBatchAlways` exempts the first batch from. Adds
   * each committed batch to `counts[key]` as it goes, so a pass that throws
   * still reports what it deleted; its error is collected, never rethrown here.
   */
  async function drainBatches<C>(
    key: "messages" | "orphans",
    firstBatchAlways: boolean,
    select: (
      tx: SelfHealTx,
      cursor: C | null,
    ) => Promise<{ selected: number; ids: number[]; cursor: C | null }>,
    store?: {
      load: (tx: SelfHealTx) => Promise<C | null>;
      save: (tx: SelfHealTx, cursor: C | null) => Promise<void>;
    },
  ): Promise<void> {
    let cursor: C | null = null;
    try {
      for (
        let i = 0;
        i < maxBatches &&
        ((firstBatchAlways && i === 0) || Date.now() - startedAt < budgetMs);
        i++
      ) {
        const prev = cursor;
        const first = i === 0;
        const done = await withSelfHealTx(
          db,
          async (tx) => {
            const from = first && store ? await store.load(tx) : prev;
            const picked = await select(tx, from);
            const deleted =
              picked.ids.length > 0 ? await deleteByIds(tx, picked.ids) : 0;
            await store?.save(
              tx,
              picked.selected < batch ? null : picked.cursor,
            );
            return { ...picked, deleted };
          },
          PRUNE_TX_TIMEOUTS,
        );
        counts[key] += done.ids.length;
        counts.applied += done.deleted;
        cursor = done.cursor;
        if (done.selected < batch) break;
      }
    } catch (error) {
      errors.push(error);
    }
  }

  // Orphans: never delivered, target thread gone.
  await drainBatches<null>("orphans", false, async (tx) => {
    const rows = await tx
      .select({ id: agentMessages.id })
      .from(agentMessages)
      .where(
        and(
          isNull(agentMessages.consumedAt),
          lt(agentMessages.createdAt, cut),
          notExists(
            sql`(select 1 from ${thread} where ${eq(thread.id, agentMessages.toRun)})`,
          ),
        ),
      )
      .limit(batch)
      .for("update", { of: agentMessages, skipLocked: true });
    return { selected: rows.length, ids: rows.map((r) => r.id), cursor: null };
  });

  // Consumed: sender can no longer retry. The keyset over (consumed_at, id) moves past each
  // batch and is persisted across calls (#769), wrapping to the start at the end of the range.
  await drainBatches<ConsumedCursor>(
    "messages",
    true,
    async (tx, cursor) => {
      const rows = await tx
        .select({
          id: agentMessages.id,
          consumedAt: agentMessages.consumedAt,
          fromRun: agentMessages.fromRun,
        })
        .from(agentMessages)
        .where(
          and(
            lt(agentMessages.consumedAt, cut),
            cursor
              ? and(
                  // Index range bound; the row comparison is the exact keyset.
                  gte(agentMessages.consumedAt, cursor.consumedAt),
                  // ::timestamptz because a bare param in a row comparison has no type.
                  sql`(${agentMessages.consumedAt}, ${agentMessages.id}) > (${sql.param(cursor.consumedAt, agentMessages.consumedAt)}::timestamptz, ${cursor.id})`,
                )
              : undefined,
            senderCannotRetry(cut),
          ),
        )
        .orderBy(asc(agentMessages.consumedAt), asc(agentMessages.id))
        .limit(batch)
        .for("update", { of: agentMessages, skipLocked: true });
      const last = rows[rows.length - 1];
      if (!last) return { selected: 0, ids: [], cursor: null };
      const fenced = await fenceSenders(tx, [
        ...new Set(rows.map((r) => r.fromRun)),
      ]);
      // Re-check under the locks: a fresh statement sees any resume that
      // committed before them.
      const keep =
        fenced.length === 0
          ? []
          : await tx
              .select({ id: agentMessages.id })
              .from(agentMessages)
              .where(
                and(
                  inArray(
                    agentMessages.id,
                    rows.map((r) => r.id),
                  ),
                  inArray(agentMessages.fromRun, fenced),
                  senderCannotRetry(cut),
                ),
              );
      return {
        selected: rows.length,
        ids: keep.map((r) => r.id),
        // consumed_at < cut excludes NULLs, so the column is never null here.
        cursor: { consumedAt: last.consumedAt as Date, id: last.id },
      };
    },
    consumedCursorStore,
  );

  if (errors.length > 0) throw new AgentMessagePruneError(errors, counts);
  return counts;
}
