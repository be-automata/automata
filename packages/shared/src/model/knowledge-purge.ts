import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";

import type { DB } from "../db";
import {
  knowledgeClaim,
  knowledgeCursor,
  knowledgeDecision,
  knowledgeIntent,
  knowledgeOp,
  knowledgePin,
  organizationReviewSettings,
} from "../db/schema";
import { KNOWLEDGE_PURGE_GRACE_MS } from "./knowledge-controls";

/**
 * OPS-04 offboarding purge. SYSTEM path: called only by the hourly sweep in
 * apps/www/src/server-lib/knowledge/purge-sweep.ts (enforced by the 12-05
 * static guard). `knowledge_usage_window` (integers) and `knowledge_admin_log`
 * (ids and enums) are retained by design: they carry no partner text. This
 * file never logs; callers log ids and counts.
 */

export interface KnowledgePurgeCounts {
  claims: number;
  pins: number;
  ops: number;
  decisions: number;
  cursors: number;
  intents: number;
}

export class KnowledgeNotOffboardedError extends Error {
  constructor() {
    super("knowledge data can only be purged for an offboarded organization");
    this.name = "KnowledgeNotOffboardedError";
  }
}

export class KnowledgePurgeNotDueError extends Error {
  constructor() {
    super("knowledge offboard mark is still inside the purge grace period");
    this.name = "KnowledgePurgeNotDueError";
  }
}

export async function purgeKnowledgeData({
  db,
  organizationId,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  now?: Date;
}): Promise<KnowledgePurgeCounts> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [settings] = await tx
      .select({
        offboardedAt: organizationReviewSettings.knowledgeOffboardedAt,
      })
      .from(organizationReviewSettings)
      .where(eq(organizationReviewSettings.organizationId, organizationId))
      .for("update");
    if (!settings || !settings.offboardedAt) {
      throw new KnowledgeNotOffboardedError();
    }
    // Re-check the grace under the lock: an undo + re-offboard after the sweep
    // listed this org must not purge the fresh mark early.
    if (
      settings.offboardedAt.getTime() >
      now.getTime() - KNOWLEDGE_PURGE_GRACE_MS
    ) {
      throw new KnowledgePurgeNotDueError();
    }
    // Children first, every delete keyed by organization_id (not only cascade).
    const decisions = await tx
      .delete(knowledgeDecision)
      .where(eq(knowledgeDecision.organizationId, organizationId))
      .returning({ id: knowledgeDecision.id });
    const ops = await tx
      .delete(knowledgeOp)
      .where(eq(knowledgeOp.organizationId, organizationId))
      .returning({ id: knowledgeOp.id });
    const pins = await tx
      .delete(knowledgePin)
      .where(eq(knowledgePin.organizationId, organizationId))
      .returning({ id: knowledgePin.id });
    const claims = await tx
      .delete(knowledgeClaim)
      .where(eq(knowledgeClaim.organizationId, organizationId))
      .returning({ id: knowledgeClaim.id });
    const cursors = await tx
      .delete(knowledgeCursor)
      .where(eq(knowledgeCursor.organizationId, organizationId))
      .returning({ id: knowledgeCursor.id });
    const intents = await tx
      .delete(knowledgeIntent)
      .where(eq(knowledgeIntent.organizationId, organizationId))
      .returning({ id: knowledgeIntent.id });
    await tx
      .update(organizationReviewSettings)
      .set({ knowledgePurgedAt: now, updatedAt: now })
      .where(eq(organizationReviewSettings.organizationId, organizationId));
    return {
      claims: claims.length,
      pins: pins.length,
      ops: ops.length,
      decisions: decisions.length,
      cursors: cursors.length,
      intents: intents.length,
    };
  });
}

/** Orgs whose offboard mark is past the grace period and not yet purged. Ids only. */
export async function listKnowledgeOrgsDueForPurge({
  db,
  now = new Date(),
  limit = 10,
}: {
  db: DB;
  now?: Date;
  limit?: number;
}): Promise<string[]> {
  const cutoff = new Date(now.getTime() - KNOWLEDGE_PURGE_GRACE_MS);
  const rows = await db
    .select({ organizationId: organizationReviewSettings.organizationId })
    .from(organizationReviewSettings)
    .where(
      and(
        lte(organizationReviewSettings.knowledgeOffboardedAt, cutoff),
        or(
          isNull(organizationReviewSettings.knowledgePurgedAt),
          lt(
            organizationReviewSettings.knowledgePurgedAt,
            organizationReviewSettings.knowledgeOffboardedAt,
          ),
        ),
      ),
    )
    .orderBy(asc(organizationReviewSettings.knowledgeOffboardedAt))
    .limit(limit);
  return rows.map((r) => r.organizationId);
}
