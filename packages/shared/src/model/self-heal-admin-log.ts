import { desc, eq } from "drizzle-orm";

import type { DB } from "../db";
import { selfHealAdminLog } from "../db/schema";
import { withSelfHealTx } from "./self-heal-tx";

export type SelfHealAdminLogRow = typeof selfHealAdminLog.$inferSelect;
export type SelfHealAdminAction = SelfHealAdminLogRow["action"];

/**
 * Operator actor log (KILL-01 / OBS-01): who drained, reset a breaker, changed
 * settings or flipped the kill switch. Org-fenced. `target` must carry ids and
 * enum values only, never secrets or payload text.
 */
export async function recordSelfHealAdminAction({
  db,
  organizationId,
  actorUserId,
  action,
  target,
}: {
  db: DB;
  organizationId: string;
  actorUserId: string;
  action: SelfHealAdminAction;
  target?: Record<string, unknown>;
}): Promise<void> {
  await withSelfHealTx(db, async (tx) => {
    await tx.insert(selfHealAdminLog).values({
      organizationId,
      actorUserId,
      action,
      target: target ?? null,
    });
  });
}

/** Newest first. */
export async function listSelfHealAdminActions({
  db,
  organizationId,
  limit = 50,
}: {
  db: DB;
  organizationId: string;
  limit?: number;
}): Promise<SelfHealAdminLogRow[]> {
  return db
    .select()
    .from(selfHealAdminLog)
    .where(eq(selfHealAdminLog.organizationId, organizationId))
    .orderBy(desc(selfHealAdminLog.createdAt), desc(selfHealAdminLog.id))
    .limit(limit);
}
