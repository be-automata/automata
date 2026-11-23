import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import type { DB } from "../../db";
import { agentApplied, agentMessages, thread } from "../../db/schema";
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
 * correlate on `"thread"."id"`, so each sender check is an EXISTS on `thread`.
 */
function senderCannotRetry(cut: Date) {
  return or(
    notExists(
      sql`(select 1 from ${thread} where ${eq(thread.id, agentMessages.fromRun)})`,
    ),
    exists(
      sql`(select 1 from ${thread} where ${and(
        eq(thread.id, agentMessages.fromRun),
        threadIsTerminal(),
        lt(threadLastWriteAt(), threadTimestampParam(cut)),
      )})`,
    ),
  );
}

interface ConsumedBatch {
  count: number;
  applied: number;
  last: { consumedAt: Date; id: number };
}

interface OrphanBatch {
  count: number;
  applied: number;
  lastId: number;
}

async function deleteByIds(
  tx: SelfHealTx,
  ids: number[],
): Promise<{ applied: number }> {
  const applied = await tx
    .delete(agentApplied)
    .where(inArray(agentApplied.msgId, ids))
    .returning({ id: agentApplied.msgId });
  await tx.delete(agentMessages).where(inArray(agentMessages.id, ids));
  return { applied: applied.length };
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
 * life plus at least R. `maxBatches` applies per pass; once `budgetMs` of wall
 * clock is spent, no new batch starts. Logs nothing: the caller logs counts.
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
  const cut = new Date(now.getTime() - AGENT_MESSAGE_RETENTION_MS);
  const startedAt = Date.now();
  const hasBudget = () => Date.now() - startedAt < budgetMs;
  let messages = 0;
  let orphans = 0;
  let applied = 0;

  // (a) Consumed pass: keyset over (consumed_at, id) so kept rows are not rescanned.
  let cursor: ConsumedBatch["last"] | null = null;
  for (let i = 0; i < maxBatches && hasBudget(); i++) {
    const after: ConsumedBatch["last"] | null = cursor;
    const result: ConsumedBatch | null = await withSelfHealTx(
      db,
      async (tx): Promise<ConsumedBatch | null> => {
        const rows = await tx
          .select({
            id: agentMessages.id,
            consumedAt: agentMessages.consumedAt,
          })
          .from(agentMessages)
          .where(
            and(
              isNotNull(agentMessages.consumedAt),
              lt(agentMessages.consumedAt, cut),
              after
                ? or(
                    gt(agentMessages.consumedAt, after.consumedAt),
                    and(
                      eq(agentMessages.consumedAt, after.consumedAt),
                      gt(agentMessages.id, after.id),
                    ),
                  )
                : undefined,
              senderCannotRetry(cut),
            ),
          )
          .orderBy(asc(agentMessages.consumedAt), asc(agentMessages.id))
          .limit(batch)
          .for("update", { of: agentMessages, skipLocked: true });
        const last = rows[rows.length - 1];
        if (!last || last.consumedAt === null) return null;
        const deleted = await deleteByIds(
          tx,
          rows.map((r) => r.id),
        );
        return {
          count: rows.length,
          applied: deleted.applied,
          last: { consumedAt: last.consumedAt, id: last.id },
        };
      },
      PRUNE_TX_TIMEOUTS,
    );
    if (!result) break;
    messages += result.count;
    applied += result.applied;
    cursor = result.last;
    if (result.count < batch) break;
  }

  // (b) Orphan pass: never delivered, and the target thread is gone.
  let lastOrphanId = 0;
  for (let i = 0; i < maxBatches && hasBudget(); i++) {
    const after = lastOrphanId;
    const result: OrphanBatch | null = await withSelfHealTx(
      db,
      async (tx): Promise<OrphanBatch | null> => {
        const rows = await tx
          .select({ id: agentMessages.id })
          .from(agentMessages)
          .where(
            and(
              isNull(agentMessages.consumedAt),
              lt(agentMessages.createdAt, cut),
              gt(agentMessages.id, after),
              notExists(
                sql`(select 1 from ${thread} where ${eq(thread.id, agentMessages.toRun)})`,
              ),
            ),
          )
          .orderBy(asc(agentMessages.id))
          .limit(batch)
          .for("update", { of: agentMessages, skipLocked: true });
        const last = rows[rows.length - 1];
        if (!last) return null;
        const deleted = await deleteByIds(
          tx,
          rows.map((r) => r.id),
        );
        return {
          count: rows.length,
          applied: deleted.applied,
          lastId: last.id,
        };
      },
      PRUNE_TX_TIMEOUTS,
    );
    if (!result) break;
    orphans += result.count;
    applied += result.applied;
    lastOrphanId = result.lastId;
    if (result.count < batch) break;
  }

  return { messages, applied, orphans };
}
