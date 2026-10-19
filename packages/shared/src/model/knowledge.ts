import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { DB } from "../db";
import {
  knowledgeClaim,
  knowledgeCursor,
  knowledgeDecision,
  knowledgeOp,
  knowledgeUsageWindow,
  type KnowledgeClaimState,
  type KnowledgeDecisionChoice,
  type KnowledgeDecisionRoute,
  type KnowledgeOpState,
} from "../db/schema";

/**
 * Knowledge plane persistence (M1 governed-truth slice).
 *
 * MULTI-TENANT: every function takes `organizationId` and fences every
 * predicate on it (ADR-001); a row of another org is indistinguishable from an
 * absent one. apps/www is the only caller; the worker reaches these over HTTP.
 */

/** Platform default for an org's monthly knowledge model-call cap: $20. */
export const DEFAULT_KNOWLEDGE_CAP_MICRO_USD = 20_000_000;

/** First instant of `now`'s UTC calendar month: the usage window key. */
export function knowledgeWindowStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type KnowledgeReservation =
  | { ok: true; windowStart: Date; reservedMicroUsd: number }
  | { ok: false; reason: "cap_exceeded"; windowStart: Date };

/**
 * Reserve `estimateMicroUsd` against the org's monthly window BEFORE a model
 * call. One conditional UPDATE does the check and the debit, so concurrent
 * jobs cannot both pass on the same remaining allowance. The caller settles
 * (or releases) the reservation afterwards; a retry reuses its reservation
 * instead of taking another.
 */
export async function reserveKnowledgeBudget({
  db,
  organizationId,
  estimateMicroUsd,
  now = new Date(),
  defaultCapMicroUsd = DEFAULT_KNOWLEDGE_CAP_MICRO_USD,
}: {
  db: DB;
  organizationId: string;
  estimateMicroUsd: number;
  now?: Date;
  defaultCapMicroUsd?: number;
}): Promise<KnowledgeReservation> {
  if (!Number.isSafeInteger(estimateMicroUsd) || estimateMicroUsd < 0)
    throw new RangeError(`invalid estimate: ${estimateMicroUsd}`);
  const windowStart = knowledgeWindowStart(now);
  await db
    .insert(knowledgeUsageWindow)
    .values({ organizationId, windowStart, capMicroUsd: defaultCapMicroUsd })
    .onConflictDoNothing();
  const rows = await db
    .update(knowledgeUsageWindow)
    .set({
      reservedMicroUsd: sql`${knowledgeUsageWindow.reservedMicroUsd} + ${estimateMicroUsd}`,
    })
    .where(
      and(
        eq(knowledgeUsageWindow.organizationId, organizationId),
        eq(knowledgeUsageWindow.windowStart, windowStart),
        sql`${knowledgeUsageWindow.reservedMicroUsd} + ${knowledgeUsageWindow.spentMicroUsd} + ${estimateMicroUsd} <= ${knowledgeUsageWindow.capMicroUsd}`,
      ),
    )
    .returning({ windowStart: knowledgeUsageWindow.windowStart });
  return rows.length === 1
    ? { ok: true, windowStart, reservedMicroUsd: estimateMicroUsd }
    : { ok: false, reason: "cap_exceeded", windowStart };
}

/**
 * Settle a reservation: release `reservedMicroUsd` and record what the call
 * actually cost. Pass `spentMicroUsd: 0` to release an unused reservation.
 */
export async function settleKnowledgeBudget({
  db,
  organizationId,
  windowStart,
  reservedMicroUsd,
  spentMicroUsd,
}: {
  db: DB;
  organizationId: string;
  windowStart: Date;
  reservedMicroUsd: number;
  spentMicroUsd: number;
}): Promise<void> {
  if (
    !Number.isSafeInteger(reservedMicroUsd) ||
    !Number.isSafeInteger(spentMicroUsd) ||
    reservedMicroUsd < 0 ||
    spentMicroUsd < 0
  )
    throw new RangeError("reserved and spent must be non-negative integers");
  await db
    .update(knowledgeUsageWindow)
    .set({
      reservedMicroUsd: sql`greatest(${knowledgeUsageWindow.reservedMicroUsd} - ${reservedMicroUsd}, 0)`,
      spentMicroUsd: sql`${knowledgeUsageWindow.spentMicroUsd} + ${spentMicroUsd}`,
    })
    .where(
      and(
        eq(knowledgeUsageWindow.organizationId, organizationId),
        eq(knowledgeUsageWindow.windowStart, windowStart),
      ),
    );
}

export type KnowledgeDecisionResult =
  | { result: "applied"; claimVersion: number }
  | { result: "rejected"; claimVersion: number }
  | { result: "superseded" }
  | { result: "already_decided"; state: KnowledgeOpState }
  | { result: "not_found" };

export interface KnowledgeClaimPatch {
  statement?: string;
  state?: KnowledgeClaimState;
}

const OPEN_OP_STATES: KnowledgeOpState[] = ["proposed", "reopened"];

/**
 * Record a decision on an op and apply its effect to the claim, atomically.
 *
 * The op row is locked; a decision on an op that is no longer open is refused
 * (`already_decided`), so a double click records one decision. The claim
 * update is a compare-and-swap on `version = op.base_version`: if the claim
 * moved since the op was proposed, nothing is written to the claim, the op
 * becomes `superseded` and the decision is still logged. `reject_keep` keeps
 * the statement but still bumps the version, because its pins move to the
 * current evidence (the repin the owner just confirmed).
 */
export async function decideKnowledgeOp({
  db,
  organizationId,
  opId,
  actorUserId,
  slackUserId,
  route,
  choice,
  claimPatch = {},
  approvedAt = new Date(),
}: {
  db: DB;
  organizationId: string;
  opId: string;
  actorUserId: string | null;
  slackUserId: string | null;
  route: KnowledgeDecisionRoute;
  choice: KnowledgeDecisionChoice;
  claimPatch?: KnowledgeClaimPatch;
  approvedAt?: Date;
}): Promise<KnowledgeDecisionResult> {
  return db.transaction(async (tx) => {
    const [op] = await tx
      .select()
      .from(knowledgeOp)
      .where(
        and(
          eq(knowledgeOp.id, opId),
          eq(knowledgeOp.organizationId, organizationId),
        ),
      )
      .for("update");
    if (!op) return { result: "not_found" } as const;
    if (!OPEN_OP_STATES.includes(op.state))
      return { result: "already_decided", state: op.state } as const;

    await tx.insert(knowledgeDecision).values({
      organizationId,
      opId,
      repoFullName: op.repoFullName,
      actorUserId,
      slackUserId,
      route,
      choice,
      decidedAt: approvedAt,
    });

    const updated = await tx
      .update(knowledgeClaim)
      .set({
        ...claimPatch,
        version: sql`${knowledgeClaim.version} + 1`,
        approvedByUserId: actorUserId,
        approvedAt,
      })
      .where(
        and(
          eq(knowledgeClaim.id, op.claimId),
          eq(knowledgeClaim.organizationId, organizationId),
          eq(knowledgeClaim.version, op.baseVersion),
        ),
      )
      .returning({ version: knowledgeClaim.version });

    const claim = updated[0];
    if (!claim) {
      await tx
        .update(knowledgeOp)
        .set({ state: "superseded" })
        .where(
          and(
            eq(knowledgeOp.id, opId),
            eq(knowledgeOp.organizationId, organizationId),
          ),
        );
      return { result: "superseded" } as const;
    }
    const terminal: KnowledgeOpState =
      choice === "reject_keep" ? "rejected" : "applied";
    await tx
      .update(knowledgeOp)
      .set({ state: terminal })
      .where(
        and(
          eq(knowledgeOp.id, opId),
          eq(knowledgeOp.organizationId, organizationId),
          inArray(knowledgeOp.state, OPEN_OP_STATES),
        ),
      );
    return terminal === "rejected"
      ? ({ result: "rejected", claimVersion: claim.version } as const)
      : ({ result: "applied", claimVersion: claim.version } as const);
  });
}

/**
 * Move the default-branch cursor from `fromSha` to `toSha`. A compare-and-swap
 * on the current `last_sha` (null for a repo never reconciled): a late or
 * replayed job that read an older cursor moves nothing and gets `false`, so
 * the cursor never goes backwards.
 */
export async function advanceKnowledgeCursor({
  db,
  organizationId,
  repoFullName,
  defaultBranch,
  fromSha,
  toSha,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  defaultBranch: string;
  fromSha: string | null;
  toSha: string;
}): Promise<boolean> {
  if (fromSha === null) {
    const inserted = await db
      .insert(knowledgeCursor)
      .values({ organizationId, repoFullName, defaultBranch, lastSha: toSha })
      .onConflictDoNothing()
      .returning({ lastSha: knowledgeCursor.lastSha });
    if (inserted.length === 1) return true;
  }
  const rows = await db
    .update(knowledgeCursor)
    .set({ lastSha: toSha, defaultBranch })
    .where(
      and(
        eq(knowledgeCursor.organizationId, organizationId),
        eq(knowledgeCursor.repoFullName, repoFullName),
        fromSha === null
          ? isNull(knowledgeCursor.lastSha)
          : eq(knowledgeCursor.lastSha, fromSha),
      ),
    )
    .returning({ lastSha: knowledgeCursor.lastSha });
  return rows.length === 1;
}

/** Record the newest default-branch head seen (from a merge webhook or a head check). */
export async function observeKnowledgeHead({
  db,
  organizationId,
  repoFullName,
  defaultBranch,
  headSha,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  defaultBranch: string;
  headSha: string;
}): Promise<void> {
  await db
    .insert(knowledgeCursor)
    .values({
      organizationId,
      repoFullName,
      defaultBranch,
      observedHeadSha: headSha,
    })
    .onConflictDoUpdate({
      target: [knowledgeCursor.organizationId, knowledgeCursor.repoFullName],
      set: { observedHeadSha: headSha, defaultBranch },
    });
}

/** The repo's cursor, or null when it was never observed or reconciled. */
export async function getKnowledgeCursor({
  db,
  organizationId,
  repoFullName,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
}) {
  const [row] = await db
    .select()
    .from(knowledgeCursor)
    .where(
      and(
        eq(knowledgeCursor.organizationId, organizationId),
        eq(knowledgeCursor.repoFullName, repoFullName),
      ),
    );
  return row ?? null;
}
