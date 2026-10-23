import { desc, eq } from "drizzle-orm";

import type { DB } from "../db";
import { knowledgeAdminLog, type KnowledgeAdminAction } from "../db/schema";
import { assertAdminLogTarget } from "./knowledge-minimize";

export type KnowledgeAdminLogRow = typeof knowledgeAdminLog.$inferSelect;

/**
 * Append one knowledge org-control change (toggle, budget, offboard, undo).
 * `target` carries ids, integers, booleans and enum values only; it is
 * validated BEFORE the insert so free text or partner content never lands in
 * the log. Uses the CALLER's db/tx (no own transaction) so the row commits
 * with the change it describes.
 */
export async function recordKnowledgeAdminAction({
  db,
  organizationId,
  actorUserId,
  action,
  target,
}: {
  db: DB;
  organizationId: string;
  actorUserId: string;
  action: KnowledgeAdminAction;
  target?: unknown;
}): Promise<void> {
  const checked = assertAdminLogTarget(target ?? {});
  await db.insert(knowledgeAdminLog).values({
    organizationId,
    actorUserId,
    action,
    target: checked,
  });
}

/** Newest first, fenced on the org. */
export async function listKnowledgeAdminActions({
  db,
  organizationId,
  limit = 50,
}: {
  db: DB;
  organizationId: string;
  limit?: number;
}): Promise<KnowledgeAdminLogRow[]> {
  return db
    .select()
    .from(knowledgeAdminLog)
    .where(eq(knowledgeAdminLog.organizationId, organizationId))
    .orderBy(desc(knowledgeAdminLog.createdAt), desc(knowledgeAdminLog.id))
    .limit(limit);
}
