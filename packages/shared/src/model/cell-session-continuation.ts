import { and, count, eq } from "drizzle-orm";
import { DB } from "../db";
import { cellSessionContinuation } from "../db/schema";

/** OD-2: one automatic continuation per thread. */
export const CELL_SESSION_CONTINUATION_BUDGET = 1;

export type CellSessionContinuation =
  typeof cellSessionContinuation.$inferSelect;

export type ClaimContinuationResult =
  | { claimed: true; id: string; ordinal: number }
  | { claimed: false; reason: "already-claimed" | "budget-spent" };

/** The ledger row of a timed-out run, or null when it was never claimed. */
export async function getContinuationBySourceRun({
  db,
  sourceRunExternalId,
}: {
  db: DB;
  sourceRunExternalId: string;
}): Promise<CellSessionContinuation | null> {
  const rows = await db
    .select()
    .from(cellSessionContinuation)
    .where(eq(cellSessionContinuation.sourceRunExternalId, sourceRunExternalId))
    .limit(1);
  return rows[0] ?? null;
}

/** How many continuations the thread has claimed (any state). */
export async function countContinuations({
  db,
  threadId,
}: {
  db: DB;
  threadId: string;
}): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(cellSessionContinuation)
    .where(eq(cellSessionContinuation.threadId, threadId));
  return row?.n ?? 0;
}

/**
 * Claim the ONE continuation for a timed-out run. Two UNIQUE bounds make a race
 * collapse to one winner: (thread, ordinal) caps the thread at `budget`, and
 * (source run) keeps a redelivered terminal from claiming twice. The loser gets
 * the bound it hit and must not dispatch. Never throws on a conflict.
 */
export async function claimContinuation({
  db,
  threadId,
  threadChatId,
  sourceRunExternalId,
  checkpointManifestId,
  checkpointTurn,
  budget = CELL_SESSION_CONTINUATION_BUDGET,
}: {
  db: DB;
  threadId: string;
  threadChatId: string;
  sourceRunExternalId: string;
  checkpointManifestId: string;
  checkpointTurn: number;
  budget?: number;
}): Promise<ClaimContinuationResult> {
  const ordinal = (await countContinuations({ db, threadId })) + 1;
  if (ordinal > budget) {
    const existing = await getContinuationBySourceRun({
      db,
      sourceRunExternalId,
    });
    return {
      claimed: false,
      reason: existing ? "already-claimed" : "budget-spent",
    };
  }
  const rows = await db
    .insert(cellSessionContinuation)
    .values({
      threadId,
      threadChatId,
      ordinal,
      sourceRunExternalId,
      checkpointManifestId,
      checkpointTurn,
    })
    .onConflictDoNothing()
    .returning({ id: cellSessionContinuation.id });
  const row = rows[0];
  if (row) return { claimed: true, id: row.id, ordinal };
  // Lost a race: name the bound that was hit.
  const existing = await getContinuationBySourceRun({
    db,
    sourceRunExternalId,
  });
  return {
    claimed: false,
    reason: existing ? "already-claimed" : "budget-spent",
  };
}

/** The continuation message is queued: the claim now stays for good. */
export async function markContinuationDispatched({
  db,
  id,
}: {
  db: DB;
  id: string;
}): Promise<boolean> {
  const rows = await db
    .update(cellSessionContinuation)
    .set({ state: "dispatched", updatedAt: new Date() })
    .where(eq(cellSessionContinuation.id, id))
    .returning({ id: cellSessionContinuation.id });
  return rows.length > 0;
}

/**
 * Compensation for a claim whose message was never queued: remove the row so a
 * redelivered terminal can retry. Only a `claimed` row goes; a `dispatched` row
 * (the message exists) is never released, which is what stops a second
 * continuation (F7).
 */
export async function releaseContinuation({
  db,
  id,
}: {
  db: DB;
  id: string;
}): Promise<boolean> {
  const rows = await db
    .delete(cellSessionContinuation)
    .where(
      and(
        eq(cellSessionContinuation.id, id),
        eq(cellSessionContinuation.state, "claimed"),
      ),
    )
    .returning({ id: cellSessionContinuation.id });
  return rows.length > 0;
}
