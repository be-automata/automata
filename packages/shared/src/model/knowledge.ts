import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { DB } from "../db";
import {
  knowledgeClaim,
  knowledgeCursor,
  knowledgeDecision,
  knowledgeOp,
  knowledgeUsageWindow,
  organizationReviewSettings,
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

/** Why the engine is not running for an org. */
export type KnowledgeGateReason = "engine_off" | "offboarded";

/** The org-row columns the resolvers need. */
export interface KnowledgeControlsRow {
  knowledgeEngine: boolean | null;
  knowledgeOffboardedAt: Date | null;
  knowledgeBudgetMicroUsd: number | null;
}

/**
 * Platform default ceiling for an org budget: $100 (5x the default cap). Used
 * only when knowledge_platform_settings has no row or a NULL ceiling; the real
 * ceiling is a platform-admin setting.
 */
export const KNOWLEDGE_BUDGET_CEILING_DEFAULT_MICRO_USD = 100_000_000;

/**
 * $10k validation bound for the ceiling and any org budget, even for platform
 * admins. Validation only, never a ceiling.
 */
export const KNOWLEDGE_BUDGET_ABSOLUTE_MAX_MICRO_USD = 10_000_000_000;

/**
 * The single definition of ON. A missing row, NULL and false are OFF; an
 * offboarded org is OFF even when the flag is true (offboarded wins).
 */
export function knowledgeGateReason(
  row: KnowledgeControlsRow | undefined,
): KnowledgeGateReason | null {
  if (!row) return "engine_off";
  if (row.knowledgeOffboardedAt) return "offboarded";
  return row.knowledgeEngine === true ? null : "engine_off";
}

export function isKnowledgeEnabled(
  row: KnowledgeControlsRow | undefined,
): boolean {
  return knowledgeGateReason(row) === null;
}

/** The org's monthly cap: its own budget, else the platform default. */
export function effectiveKnowledgeBudgetMicroUsd(
  row: Pick<KnowledgeControlsRow, "knowledgeBudgetMicroUsd"> | undefined,
): number {
  return row?.knowledgeBudgetMicroUsd ?? DEFAULT_KNOWLEDGE_CAP_MICRO_USD;
}

/**
 * cap_exceeded and the gate reasons mean PAUSE: the caller defers and retries
 * later (next window or after a raise), it never fails the job.
 */
export type KnowledgeReservation =
  | { ok: true; windowStart: Date; reservedMicroUsd: number }
  | { ok: false; reason: "cap_exceeded"; windowStart: Date; alerted: boolean }
  | { ok: false; reason: KnowledgeGateReason };

/**
 * Reserve `estimateMicroUsd` against the org's monthly window BEFORE a model
 * call. This is the choke point for all knowledge model spend: it checks the
 * kill switch (live read, no cache) and takes the cap from the org's budget
 * inside the database, so a caller cannot choose its own cap. One conditional
 * UPDATE does the check and the debit, so concurrent jobs cannot both pass on
 * the same remaining allowance. The first denial per window claims the cap
 * alert exactly once. The caller settles (or releases) the reservation
 * afterwards; settle is never gated.
 */
export async function reserveKnowledgeBudget({
  db,
  organizationId,
  estimateMicroUsd,
  now = new Date(),
  log = console,
}: {
  db: DB;
  organizationId: string;
  estimateMicroUsd: number;
  now?: Date;
  log?: Pick<Console, "error">;
}): Promise<KnowledgeReservation> {
  if (!Number.isSafeInteger(estimateMicroUsd) || estimateMicroUsd < 0)
    throw new RangeError(`invalid estimate: ${estimateMicroUsd}`);
  const [controls] = await db
    .select({
      knowledgeEngine: organizationReviewSettings.knowledgeEngine,
      knowledgeOffboardedAt: organizationReviewSettings.knowledgeOffboardedAt,
      knowledgeBudgetMicroUsd:
        organizationReviewSettings.knowledgeBudgetMicroUsd,
    })
    .from(organizationReviewSettings)
    .where(eq(organizationReviewSettings.organizationId, organizationId));
  const gate = knowledgeGateReason(controls);
  if (gate) return { ok: false, reason: gate };

  const windowStart = knowledgeWindowStart(now);
  await db
    .insert(knowledgeUsageWindow)
    .values({
      organizationId,
      windowStart,
      capMicroUsd: sql`coalesce((select knowledge_budget_micro_usd from organization_review_settings where organization_id = ${organizationId}), ${DEFAULT_KNOWLEDGE_CAP_MICRO_USD})`,
    })
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
  if (rows.length === 1)
    return { ok: true, windowStart, reservedMicroUsd: estimateMicroUsd };

  const claimed = await db
    .update(knowledgeUsageWindow)
    .set({ capAlertedAt: sql`now()` })
    .where(
      and(
        eq(knowledgeUsageWindow.organizationId, organizationId),
        eq(knowledgeUsageWindow.windowStart, windowStart),
        isNull(knowledgeUsageWindow.capAlertedAt),
      ),
    )
    .returning({
      capMicroUsd: knowledgeUsageWindow.capMicroUsd,
      reservedMicroUsd: knowledgeUsageWindow.reservedMicroUsd,
      spentMicroUsd: knowledgeUsageWindow.spentMicroUsd,
    });
  const claim = claimed[0];
  if (claim) {
    // ids and integers only: never statements or partner content
    log.error("[knowledge:budget-cap]", {
      organizationId,
      windowStart: windowStart.toISOString(),
      capMicroUsd: claim.capMicroUsd,
      reservedMicroUsd: claim.reservedMicroUsd,
      spentMicroUsd: claim.spentMicroUsd,
    });
  }
  return { ok: false, reason: "cap_exceeded", windowStart, alerted: !!claim };
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
