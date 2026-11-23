import { and, asc, eq, gte, isNull, lt, notExists, sql } from "drizzle-orm";

import type { DB } from "../../db";
import { agentApplied, agentMessages, thread } from "../../db/schema";
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
 * life plus at least R. The orphan pass runs first, then the consumed pass, so a
 * slow or failing consumed pass cannot starve orphan pruning; if it throws, the
 * error propagates (the cron logs it) and the orphan deletions already
 * committed. `maxBatches` applies per pass and `budgetMs` is shared: once it is
 * spent, no new batch starts. The real upper bound on wall clock is `budgetMs`
 * plus one in-flight batch of up to 3 statements (select, delete applied,
 * delete messages), each capped at the 10 s statement timeout. Throws
 * `RangeError` unless `batch` and `maxBatches` are positive integers and
 * `budgetMs` is a positive finite number. Logs nothing: the caller logs counts.
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
}): Promise<{ messages: number; applied: number; orphans: number }> {
  assertPositiveInt("batch", batch);
  assertPositiveInt("maxBatches", maxBatches);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new RangeError(`budgetMs must be a positive number, got ${budgetMs}`);
  }
  const cut = new Date(now.getTime() - AGENT_MESSAGE_RETENTION_MS);
  const startedAt = Date.now();
  let applied = 0;

  /**
   * Runs one pass: each batch is its own transaction that selects up to `batch`
   * ids with `select(tx, cursor)` (locking them), then deletes them. Stops on a
   * short or empty batch, `maxBatches`, or the shared budget. `cursor` is the
   * last row of the previous batch, for passes that keyset-scan.
   */
  async function drainBatches<C>(
    select: (
      tx: SelfHealTx,
      cursor: C | null,
    ) => Promise<{ id: number; cursor: C }[]>,
  ): Promise<number> {
    let count = 0;
    let cursor: C | null = null;
    for (let i = 0; i < maxBatches && Date.now() - startedAt < budgetMs; i++) {
      const prev = cursor;
      const done = await withSelfHealTx(
        db,
        async (tx) => {
          const rows = await select(tx, prev);
          const last = rows[rows.length - 1];
          if (!last) return null;
          const deleted = await deleteByIds(
            tx,
            rows.map((r) => r.id),
          );
          return { rows: rows.length, deleted, cursor: last.cursor };
        },
        PRUNE_TX_TIMEOUTS,
      );
      if (!done) break;
      count += done.rows;
      applied += done.deleted;
      cursor = done.cursor;
      if (done.rows < batch) break;
    }
    return count;
  }

  // Orphans: never delivered, target thread gone.
  const orphans = await drainBatches<null>(async (tx) =>
    (
      await tx
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
        .for("update", { of: agentMessages, skipLocked: true })
    ).map((r) => ({ id: r.id, cursor: null })),
  );

  // Consumed: sender can no longer retry. Keyset over (consumed_at, id) so kept rows are not rescanned.
  const messages = await drainBatches<{ consumedAt: Date; id: number }>(
    async (tx, cursor) => {
      const rows = await tx
        .select({ id: agentMessages.id, consumedAt: agentMessages.consumedAt })
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
      // consumed_at < cut excludes NULLs, so the column is never null here.
      return rows.map((r) => ({
        id: r.id,
        cursor: { consumedAt: r.consumedAt as Date, id: r.id },
      }));
    },
  );

  return { messages, applied, orphans };
}
