import { and, eq } from "drizzle-orm";
import { DB } from "../db";
import { cellSessionCheckpoint } from "../db/schema";

export type CellSessionHead = typeof cellSessionCheckpoint.$inferSelect;

export interface CellSessionHeadMove {
  sessionId: string;
  headManifestId: string;
  headTurn: number;
  nativeBytes: number;
  callIndexSha256: string | null;
  lastRunExternalId: string;
  organizationId?: string | null;
}

export type AdvanceCellSessionHeadResult =
  | { moved: true; version: number }
  | { moved: false };

/** The pointer row of a thread chat, or null when no checkpoint was written. */
export async function getCellSessionHead({
  db,
  threadId,
  threadChatId,
}: {
  db: DB;
  threadId: string;
  threadChatId: string;
}): Promise<CellSessionHead | null> {
  const rows = await db
    .select()
    .from(cellSessionCheckpoint)
    .where(
      and(
        eq(cellSessionCheckpoint.threadId, threadId),
        eq(cellSessionCheckpoint.threadChatId, threadChatId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Move the head and the call index together, as one compare-and-set on `version`.
 * `expectedVersion` 0 means "no row yet": INSERT ... ON CONFLICT DO NOTHING (version 1).
 * Any other value is a conditional UPDATE that bumps `version`. No row back means the
 * head moved under the caller (or the row is missing): nothing changed, and the writer
 * must stop. Never throws on a lost race.
 */
export async function advanceCellSessionHead({
  db,
  threadId,
  threadChatId,
  expectedVersion,
  move,
}: {
  db: DB;
  threadId: string;
  threadChatId: string;
  expectedVersion: number;
  move: CellSessionHeadMove;
}): Promise<AdvanceCellSessionHeadResult> {
  const fields = {
    sessionId: move.sessionId,
    headManifestId: move.headManifestId,
    headTurn: move.headTurn,
    nativeBytes: move.nativeBytes,
    callIndexSha256: move.callIndexSha256,
    lastRunExternalId: move.lastRunExternalId,
  };
  if (expectedVersion === 0) {
    const rows = await db
      .insert(cellSessionCheckpoint)
      .values({
        threadId,
        threadChatId,
        organizationId: move.organizationId ?? null,
        ...fields,
      })
      .onConflictDoNothing({
        target: [
          cellSessionCheckpoint.threadId,
          cellSessionCheckpoint.threadChatId,
        ],
      })
      .returning({ version: cellSessionCheckpoint.version });
    const row = rows[0];
    return row ? { moved: true, version: row.version } : { moved: false };
  }
  const rows = await db
    .update(cellSessionCheckpoint)
    .set({
      ...fields,
      version: expectedVersion + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(cellSessionCheckpoint.threadId, threadId),
        eq(cellSessionCheckpoint.threadChatId, threadChatId),
        eq(cellSessionCheckpoint.version, expectedVersion),
      ),
    )
    .returning({ version: cellSessionCheckpoint.version });
  const row = rows[0];
  return row ? { moved: true, version: row.version } : { moved: false };
}
