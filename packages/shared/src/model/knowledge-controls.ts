import { and, eq, sql } from "drizzle-orm";

import type { DB } from "../db";
import {
  knowledgePlatformSettings,
  knowledgeUsageWindow,
  organizationReviewSettings,
} from "../db/schema";
import {
  DEFAULT_KNOWLEDGE_CAP_MICRO_USD,
  KNOWLEDGE_BUDGET_ABSOLUTE_MAX_MICRO_USD,
  KNOWLEDGE_BUDGET_CEILING_DEFAULT_MICRO_USD,
  effectiveKnowledgeBudgetMicroUsd,
  knowledgeGateReason,
  knowledgeWindowStart,
  type KnowledgeGateReason,
} from "./knowledge";
import { recordKnowledgeAdminAction } from "./knowledge-admin-log";

/**
 * Per-org knowledge kill switch, budget, offboarding and spend. No
 * authorization here: the route owns it (`canSetKnowledgeBudget` is the pure
 * rule). Nothing in this file deletes data; Off keeps everything and the cursor.
 */

/** Purge runs 7 days after the offboard mark. */
export const KNOWLEDGE_PURGE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const PLATFORM_SETTINGS_ID = "global";

export interface KnowledgeControls {
  engine: boolean | null;
  budgetMicroUsd: number | null;
  effectiveBudgetMicroUsd: number;
  ceilingMicroUsd: number;
  offboardedAt: Date | null;
  purgeAfter: Date | null;
  purgedAt: Date | null;
  enabled: boolean;
  gateReason: KnowledgeGateReason | null;
  updatedAt: Date | null;
}

/** The stored row changed since the caller read it (expectedUpdatedAt mismatch). */
export class KnowledgeControlsConflictError extends Error {
  constructor() {
    super("knowledge controls changed since they were read");
    this.name = "KnowledgeControlsConflictError";
  }
}

/** The engine cannot be enabled while the org is offboarded. */
export class KnowledgeOffboardedError extends Error {
  constructor() {
    super("knowledge is offboarded for this organization");
    this.name = "KnowledgeOffboardedError";
  }
}

type OrgRow = typeof organizationReviewSettings.$inferSelect;

function toControls(
  row: OrgRow | undefined,
  ceiling: number,
): KnowledgeControls {
  const gateReason = knowledgeGateReason(row);
  const offboardedAt = row?.knowledgeOffboardedAt ?? null;
  return {
    engine: row?.knowledgeEngine ?? null,
    budgetMicroUsd: row?.knowledgeBudgetMicroUsd ?? null,
    effectiveBudgetMicroUsd: effectiveKnowledgeBudgetMicroUsd(row),
    ceilingMicroUsd: ceiling,
    offboardedAt,
    purgeAfter: offboardedAt
      ? new Date(offboardedAt.getTime() + KNOWLEDGE_PURGE_GRACE_MS)
      : null,
    purgedAt: row?.knowledgePurgedAt ?? null,
    enabled: gateReason === null,
    gateReason,
    updatedAt: row?.knowledgeUpdatedAt ?? null,
  };
}

/**
 * Knowledge writes stamp `knowledgeUpdatedAt` and leave the shared `updatedAt`
 * (the PR-review settings' optimistic-concurrency stamp) as it is: assigning
 * the column to itself also keeps drizzle's `$onUpdate` from bumping it.
 */
const KEEP_REVIEW_UPDATED_AT = sql`${organizationReviewSettings.updatedAt}`;

async function readOrgRow(
  db: DB,
  organizationId: string,
  lock = false,
): Promise<OrgRow | undefined> {
  const q = db
    .select()
    .from(organizationReviewSettings)
    .where(eq(organizationReviewSettings.organizationId, organizationId));
  const [row] = await (lock ? q.for("update") : q);
  return row;
}

function assertBudgetInRange(micro: number): void {
  if (
    !Number.isSafeInteger(micro) ||
    micro < 0 ||
    micro > KNOWLEDGE_BUDGET_ABSOLUTE_MAX_MICRO_USD
  )
    throw new RangeError(`invalid knowledge budget: ${micro}`);
}

export async function getKnowledgeBudgetCeilingSetting(db: DB): Promise<{
  ceilingMicroUsd: number;
  isDefault: boolean;
  updatedByUserId: string | null;
  updatedAt: Date | null;
}> {
  const [row] = await db
    .select()
    .from(knowledgePlatformSettings)
    .where(eq(knowledgePlatformSettings.id, PLATFORM_SETTINGS_ID));
  const stored = row?.budgetCeilingMicroUsd ?? null;
  return {
    ceilingMicroUsd: stored ?? KNOWLEDGE_BUDGET_CEILING_DEFAULT_MICRO_USD,
    isDefault: stored === null,
    updatedByUserId: row?.updatedByUserId ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** The platform ceiling for org budgets; $100 when unset. */
export async function getKnowledgeBudgetCeiling(db: DB): Promise<number> {
  return (await getKnowledgeBudgetCeilingSetting(db)).ceilingMicroUsd;
}

/**
 * Set the platform ceiling (null resets to the default). Never touches org
 * budgets or windows: lowering only gates future raises. No authorization here.
 */
export async function setKnowledgeBudgetCeiling(
  db: DB,
  { micro, actorUserId }: { micro: number | null; actorUserId: string },
): Promise<void> {
  if (micro !== null) assertBudgetInRange(micro);
  const now = new Date();
  await db
    .insert(knowledgePlatformSettings)
    .values({
      id: PLATFORM_SETTINGS_ID,
      budgetCeilingMicroUsd: micro,
      updatedByUserId: actorUserId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [knowledgePlatformSettings.id],
      set: {
        budgetCeilingMicroUsd: micro,
        updatedByUserId: actorUserId,
        updatedAt: now,
      },
    });
}

/** The kill-switch verdict alone: one primary-key read, no cache. */
export async function getKnowledgeGateReason({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<KnowledgeGateReason | null> {
  return knowledgeGateReason(await readOrgRow(db, organizationId));
}

/** Live read, no cache. */
export async function getKnowledgeControls({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<KnowledgeControls> {
  const [row, ceiling] = await Promise.all([
    readOrgRow(db, organizationId),
    getKnowledgeBudgetCeiling(db),
  ]);
  return toControls(row, ceiling);
}

/**
 * Pure ceiling rule. An org admin may set a budget up to the ceiling, or lower
 * an existing one; only a platform admin may go above the ceiling.
 */
export function canSetKnowledgeBudget({
  next,
  current,
  isPlatformAdmin,
  ceilingMicroUsd,
}: {
  next: number | null;
  current: number | null;
  isPlatformAdmin: boolean;
  ceilingMicroUsd: number;
}): { ok: true } | { ok: false; reason: "out_of_range" | "above_ceiling" } {
  if (next === null) return { ok: true };
  if (
    !Number.isSafeInteger(next) ||
    next < 0 ||
    next > KNOWLEDGE_BUDGET_ABSOLUTE_MAX_MICRO_USD
  )
    return { ok: false, reason: "out_of_range" };
  if (isPlatformAdmin) return { ok: true };
  if (next <= ceilingMicroUsd) return { ok: true };
  if (next <= (current ?? DEFAULT_KNOWLEDGE_CAP_MICRO_USD)) return { ok: true };
  return { ok: false, reason: "above_ceiling" };
}

export async function updateKnowledgeControls({
  db,
  organizationId,
  actorUserId,
  patch,
  expectedUpdatedAt,
  via = "org_admin",
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  actorUserId: string;
  patch: { engine?: boolean; budgetMicroUsd?: number | null };
  expectedUpdatedAt?: Date | null;
  via?: "org_admin" | "platform_admin";
  now?: Date;
}): Promise<KnowledgeControls> {
  if (patch.budgetMicroUsd !== undefined && patch.budgetMicroUsd !== null)
    assertBudgetInRange(patch.budgetMicroUsd);
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const row = await readOrgRow(tx, organizationId, true);
    if (expectedUpdatedAt !== undefined) {
      const stamp = row?.knowledgeUpdatedAt ?? null;
      const matches =
        expectedUpdatedAt === null
          ? stamp === null
          : stamp !== null && stamp.getTime() === expectedUpdatedAt.getTime();
      if (!matches) throw new KnowledgeControlsConflictError();
    }
    if (patch.engine === true && row?.knowledgeOffboardedAt)
      throw new KnowledgeOffboardedError();

    const fields: Partial<typeof organizationReviewSettings.$inferInsert> = {};
    if (patch.engine !== undefined) fields.knowledgeEngine = patch.engine;
    if (patch.budgetMicroUsd !== undefined)
      fields.knowledgeBudgetMicroUsd = patch.budgetMicroUsd;
    await tx
      .insert(organizationReviewSettings)
      .values({
        organizationId,
        ...fields,
        updatedByUserId: actorUserId,
        knowledgeUpdatedAt: now,
      })
      .onConflictDoUpdate({
        target: [organizationReviewSettings.organizationId],
        set: {
          ...fields,
          updatedByUserId: actorUserId,
          knowledgeUpdatedAt: now,
          updatedAt: KEEP_REVIEW_UPDATED_AT,
        },
      });

    if (patch.budgetMicroUsd !== undefined) {
      const cap = patch.budgetMicroUsd ?? DEFAULT_KNOWLEDGE_CAP_MICRO_USD;
      await tx
        .insert(knowledgeUsageWindow)
        .values({
          organizationId,
          windowStart: knowledgeWindowStart(now),
          capMicroUsd: cap,
        })
        .onConflictDoUpdate({
          target: [
            knowledgeUsageWindow.organizationId,
            knowledgeUsageWindow.windowStart,
          ],
          set: {
            capMicroUsd: sql`excluded.cap_micro_usd`,
            capAlertedAt: sql`CASE WHEN excluded.cap_micro_usd > ${knowledgeUsageWindow.capMicroUsd} THEN NULL ELSE ${knowledgeUsageWindow.capAlertedAt} END`,
          },
        });
    }

    const fromEngine = row?.knowledgeEngine ?? null;
    if (patch.engine !== undefined && patch.engine !== fromEngine)
      await recordKnowledgeAdminAction({
        db: tx,
        organizationId,
        actorUserId,
        action: "engine_toggle",
        target: { from: fromEngine, to: patch.engine, via },
      });
    const fromBudget = row?.knowledgeBudgetMicroUsd ?? null;
    if (
      patch.budgetMicroUsd !== undefined &&
      patch.budgetMicroUsd !== fromBudget
    )
      await recordKnowledgeAdminAction({
        db: tx,
        organizationId,
        actorUserId,
        action: "budget_change",
        target: {
          fromMicroUsd: fromBudget,
          toMicroUsd: patch.budgetMicroUsd,
          via,
        },
      });
  });
  return getKnowledgeControls({ db, organizationId });
}

/**
 * Mark the org offboarded and force the engine Off. Idempotent: a second call
 * keeps the original mark and writes no second log row. Deletes nothing.
 */
export async function offboardKnowledge({
  db,
  organizationId,
  actorUserId,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  actorUserId: string;
  now?: Date;
}): Promise<KnowledgeControls> {
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const row = await readOrgRow(tx, organizationId, true);
    if (row?.knowledgeOffboardedAt) return;
    const fields = {
      knowledgeEngine: false,
      knowledgeOffboardedAt: now,
      updatedByUserId: actorUserId,
      knowledgeUpdatedAt: now,
    };
    await tx
      .insert(organizationReviewSettings)
      .values({ organizationId, ...fields })
      .onConflictDoUpdate({
        target: [organizationReviewSettings.organizationId],
        set: { ...fields, updatedAt: KEEP_REVIEW_UPDATED_AT },
      });
    await recordKnowledgeAdminAction({
      db: tx,
      organizationId,
      actorUserId,
      action: "offboard",
      target: { engineWas: row?.knowledgeEngine ?? null },
    });
  });
  return getKnowledgeControls({ db, organizationId });
}

/** Undo an offboard mark. The engine stays Off: re-enabling is a separate toggle. */
export async function clearKnowledgeOffboard({
  db,
  organizationId,
  actorUserId,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  actorUserId: string;
  now?: Date;
}): Promise<KnowledgeControls> {
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const row = await readOrgRow(tx, organizationId, true);
    if (!row?.knowledgeOffboardedAt) return;
    const purged =
      row.knowledgePurgedAt !== null &&
      row.knowledgePurgedAt.getTime() >= row.knowledgeOffboardedAt.getTime();
    await tx
      .update(organizationReviewSettings)
      .set({
        knowledgeOffboardedAt: null,
        updatedByUserId: actorUserId,
        knowledgeUpdatedAt: now,
        updatedAt: KEEP_REVIEW_UPDATED_AT,
      })
      .where(eq(organizationReviewSettings.organizationId, organizationId));
    await recordKnowledgeAdminAction({
      db: tx,
      organizationId,
      actorUserId,
      action: "offboard_undo",
      target: { purged },
    });
  });
  return getKnowledgeControls({ db, organizationId });
}

export interface KnowledgeSpend {
  windowStart: Date;
  capMicroUsd: number;
  reservedMicroUsd: number;
  spentMicroUsd: number;
  remainingMicroUsd: number;
  atCap: boolean;
  capAlertedAt: Date | null;
}

/** Spend for the current UTC month; org-fenced. */
export async function getKnowledgeSpend({
  db,
  organizationId,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  now?: Date;
}): Promise<KnowledgeSpend> {
  const windowStart = knowledgeWindowStart(now);
  const [window] = await db
    .select()
    .from(knowledgeUsageWindow)
    .where(
      and(
        eq(knowledgeUsageWindow.organizationId, organizationId),
        eq(knowledgeUsageWindow.windowStart, windowStart),
      ),
    );
  const capMicroUsd =
    window?.capMicroUsd ??
    effectiveKnowledgeBudgetMicroUsd(await readOrgRow(db, organizationId));
  const reservedMicroUsd = window?.reservedMicroUsd ?? 0;
  const spentMicroUsd = window?.spentMicroUsd ?? 0;
  const remainingMicroUsd = Math.max(
    0,
    capMicroUsd - reservedMicroUsd - spentMicroUsd,
  );
  const capAlertedAt = window?.capAlertedAt ?? null;
  return {
    windowStart,
    capMicroUsd,
    reservedMicroUsd,
    spentMicroUsd,
    remainingMicroUsd,
    atCap: remainingMicroUsd === 0 || capAlertedAt !== null,
    capAlertedAt,
  };
}
