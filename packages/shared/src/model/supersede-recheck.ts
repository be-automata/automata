import { and, eq, lt, or } from "drizzle-orm";
import { DB } from "../db";
import { supersedeDesiredHead, supersedeRecheck } from "../db/schema";
import { normalizeRepo } from "./repo-review-settings";

/** The per-PR concurrency key, exactly as dispatch stamps it on the run input. */
export function buildPrKey({
  orgId,
  repoFullName,
  prNumber,
}: {
  orgId: string;
  repoFullName: string;
  prNumber: number;
}): string {
  return `${orgId}/${normalizeRepo(repoFullName)}/${prNumber}`;
}

/**
 * Record a PR head seen by a webhook (#125 C5). Compare-and-set on the
 * GitHub timestamp so an out-of-order delivery never moves the head
 * BACKWARDS; an equal timestamp is won by the lexicographically greater
 * delivery id (deterministic). Returns true when the row changed.
 */
export async function upsertDesiredHead({
  db,
  prKey,
  sha,
  webhookAt,
  deliveryId,
}: {
  db: DB;
  prKey: string;
  sha: string;
  webhookAt: Date;
  deliveryId: string;
}): Promise<boolean> {
  const rows = await db
    .insert(supersedeDesiredHead)
    .values({ prKey, sha, webhookAt, deliveryId })
    .onConflictDoUpdate({
      target: supersedeDesiredHead.prKey,
      set: { sha, webhookAt, deliveryId, updatedAt: new Date() },
      setWhere: or(
        lt(supersedeDesiredHead.webhookAt, webhookAt),
        and(
          eq(supersedeDesiredHead.webhookAt, webhookAt),
          lt(supersedeDesiredHead.deliveryId, deliveryId),
        ),
      ),
    })
    .returning({ prKey: supersedeDesiredHead.prKey });
  return rows.length > 0;
}

export async function getDesiredHead({
  db,
  prKey,
}: {
  db: DB;
  prKey: string;
}): Promise<{ sha: string; webhookAt: Date; deliveryId: string } | null> {
  const [row] = await db
    .select({
      sha: supersedeDesiredHead.sha,
      webhookAt: supersedeDesiredHead.webhookAt,
      deliveryId: supersedeDesiredHead.deliveryId,
    })
    .from(supersedeDesiredHead)
    .where(eq(supersedeDesiredHead.prKey, prKey))
    .limit(1);
  return row ?? null;
}

/**
 * Claim the ONE recheck for (prKey, desiredHeadSha). The UNIQUE index turns a
 * race between two terminals into exactly one winner; the loser gets false
 * and must not dispatch. Never throws on the conflict.
 */
export async function claimRecheck({
  db,
  prKey,
  desiredHeadSha,
  triggeredByThreadId,
}: {
  db: DB;
  prKey: string;
  desiredHeadSha: string;
  triggeredByThreadId: string;
}): Promise<boolean> {
  const rows = await db
    .insert(supersedeRecheck)
    .values({ prKey, desiredHeadSha, triggeredByThreadId })
    .onConflictDoNothing({
      target: [supersedeRecheck.prKey, supersedeRecheck.desiredHeadSha],
    })
    .returning({ id: supersedeRecheck.id });
  return rows.length > 0;
}
