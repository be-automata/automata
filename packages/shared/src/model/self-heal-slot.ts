import {
  and,
  count,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";

import type { DB } from "../db";
import {
  selfHealBreakerEvent,
  selfHealSlot,
  thread,
  threadChat,
} from "../db/schema";
import type { ThreadStatus } from "../db/types";
import { normalizeRepo } from "./repo-review-settings";
import { withSelfHealTx } from "./self-heal-tx";

/**
 * The platform-wide self-heal bulkhead (BULK-01). There is ONE box and ONE
 * slot: at most one self-heal run (audit or fix) is in flight across every
 * organization. Hatchet concurrency keys are per workflow and do not cap
 * across variants, so Postgres is the authority — a single row keyed
 * SELF_HEAL_SLOT_KEY, taken by compare-and-set.
 *
 * The slot is free when it is empty, its lease has expired, or its holder
 * thread is terminal. A fresh acquisition gets a short pre-holder lease
 * (5 min) that covers the gap until the dispatched thread is known; once the
 * holder thread is recorded the lease becomes 75 min (the stalled-thread
 * cutoff precedent), so a dead run never blocks the box for longer.
 *
 * UNFENCED by design: the slot is shared by every organization.
 */

export const SELF_HEAL_SLOT_KEY = "box";

export const SELF_HEAL_SLOT_PRE_LEASE_MS = 5 * 60 * 1000;
export const SELF_HEAL_SLOT_HOLDER_LEASE_MS = 75 * 60 * 1000;

export type SelfHealSlotKind = "audit" | "fix";

/** Effective statuses after which a holder thread can no longer use the box. */
export const SELF_HEAL_SLOT_TERMINAL_STATUSES: ThreadStatus[] = [
  "complete",
  "stopped",
  "error",
  "working-stopped",
];

export type AcquireSelfHealSlotResult =
  | { acquired: true }
  | {
      acquired: false;
      heldBy?: {
        threadId: string | null;
        kind: SelfHealSlotKind | null;
        leaseUntil: Date | null;
      };
    };

/**
 * The holder thread is terminal: a typed terminal cause, or a terminal status
 * on the thread row or on any of its threadChat rows (chat-mode threads keep
 * their live status on threadChat). Column refs are table-qualified, so inside
 * ON CONFLICT DO UPDATE ... WHERE they address the existing slot row.
 */
function holderThreadIsTerminal() {
  const statuses = sql.join(
    SELF_HEAL_SLOT_TERMINAL_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  return sql`exists (select 1 from ${thread} where ${thread.id} = ${selfHealSlot.holderThreadId} and (${thread.terminalCause} is not null or ${thread.status} in (${statuses}) or exists (select 1 from ${threadChat} where ${threadChat.threadId} = ${thread.id} and ${threadChat.status} in (${statuses}))))`;
}

/** The slot is takeable: empty, lease expired, or held by a terminal thread. */
function slotIsFree(now: Date) {
  return or(
    isNull(selfHealSlot.leaseUntil),
    lt(selfHealSlot.leaseUntil, now),
    and(isNotNull(selfHealSlot.holderThreadId), holderThreadIsTerminal()),
  );
}

/**
 * Take the box in ONE statement: insert the singleton row, or, on conflict,
 * overwrite it only when it is free. Concurrent callers serialize on the row
 * lock and re-evaluate the predicate against the winner's write, so exactly
 * one acquires. The loser reads who holds it.
 */
export async function acquireSelfHealSlot({
  db,
  organizationId,
  holderKind,
  now = new Date(),
  preLeaseMs = SELF_HEAL_SLOT_PRE_LEASE_MS,
}: {
  db: DB;
  organizationId: string;
  holderKind: SelfHealSlotKind;
  now?: Date;
  preLeaseMs?: number;
}): Promise<AcquireSelfHealSlotResult> {
  const leaseUntil = new Date(now.getTime() + preLeaseMs);
  return withSelfHealTx(db, async (tx) => {
    const won = await tx
      .insert(selfHealSlot)
      .values({
        slotKey: SELF_HEAL_SLOT_KEY,
        organizationId,
        holderKind,
        holderThreadId: null,
        leaseUntil,
        acquiredAt: now,
      })
      .onConflictDoUpdate({
        target: selfHealSlot.slotKey,
        set: {
          organizationId,
          holderKind,
          holderThreadId: null,
          leaseUntil,
          acquiredAt: now,
        },
        setWhere: slotIsFree(now),
      })
      .returning({ slotKey: selfHealSlot.slotKey });
    if (won.length > 0) return { acquired: true };
    const [held] = await tx
      .select({
        threadId: selfHealSlot.holderThreadId,
        kind: selfHealSlot.holderKind,
        leaseUntil: selfHealSlot.leaseUntil,
      })
      .from(selfHealSlot)
      .where(eq(selfHealSlot.slotKey, SELF_HEAL_SLOT_KEY));
    return held ? { acquired: false, heldBy: held } : { acquired: false };
  });
}

/**
 * Record the dispatched thread as the holder and extend the lease to the
 * holder horizon. Applies only while the slot is in its pre-holder lease (or
 * already held by this same thread — idempotent); returns whether it applied.
 */
export async function setSlotHolderThread({
  db,
  threadId,
  now = new Date(),
  leaseMs = SELF_HEAL_SLOT_HOLDER_LEASE_MS,
}: {
  db: DB;
  threadId: string;
  now?: Date;
  leaseMs?: number;
}): Promise<boolean> {
  return withSelfHealTx(db, async (tx) => {
    const rows = await tx
      .update(selfHealSlot)
      .set({
        holderThreadId: threadId,
        leaseUntil: new Date(now.getTime() + leaseMs),
      })
      .where(
        and(
          eq(selfHealSlot.slotKey, SELF_HEAL_SLOT_KEY),
          or(
            and(
              isNull(selfHealSlot.holderThreadId),
              gt(selfHealSlot.leaseUntil, now),
            ),
            eq(selfHealSlot.holderThreadId, threadId),
          ),
        ),
      )
      .returning({ slotKey: selfHealSlot.slotKey });
    return rows.length > 0;
  });
}

/**
 * Free the box. With `threadId`, only that holder can free it (a release by
 * any other thread is a no-op); without it, only a pre-holder acquisition (no
 * thread recorded yet — the dispatch did not start) is freed.
 */
export async function releaseSelfHealSlot({
  db,
  threadId,
}: {
  db: DB;
  threadId?: string;
}): Promise<boolean> {
  return withSelfHealTx(db, async (tx) => {
    const rows = await tx
      .update(selfHealSlot)
      .set({
        organizationId: null,
        holderKind: null,
        holderThreadId: null,
        leaseUntil: null,
        acquiredAt: null,
      })
      .where(
        and(
          eq(selfHealSlot.slotKey, SELF_HEAL_SLOT_KEY),
          isNotNull(selfHealSlot.leaseUntil),
          threadId === undefined
            ? isNull(selfHealSlot.holderThreadId)
            : eq(selfHealSlot.holderThreadId, threadId),
        ),
      )
      .returning({ slotKey: selfHealSlot.slotKey });
    return rows.length > 0;
  });
}

/** The slot row as stored (null before the first acquisition). */
export async function getSelfHealSlot({ db }: { db: DB }) {
  const [row] = await db
    .select()
    .from(selfHealSlot)
    .where(eq(selfHealSlot.slotKey, SELF_HEAL_SLOT_KEY));
  return row ?? null;
}

export type SelfHealSlotRow = NonNullable<
  Awaited<ReturnType<typeof getSelfHealSlot>>
>;

/**
 * Admission deferrals are kept as rows of self_heal_breaker_event under their
 * own scope kind, so the admin metrics can count them per repo (R5) without
 * a schema change. No breaker reads this scope kind, and the 30-day event
 * retention (pruneSelfHealRows) bounds the rows to the metrics window.
 */
export const ADMISSION_EVENT_SCOPE_KIND = "admission";

export type AdmissionDeferralReason = "review_in_flight" | "slot_held";

export async function recordAdmissionDeferral({
  db,
  organizationId,
  repoFullName,
  reason,
  now,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  reason: AdmissionDeferralReason;
  now?: Date;
}): Promise<void> {
  await db.insert(selfHealBreakerEvent).values({
    organizationId,
    scopeKind: ADMISSION_EVENT_SCOPE_KIND,
    scopeKey: normalizeRepo(repoFullName),
    outcome: "ignored",
    signal: reason,
    ...(now ? { createdAt: now } : {}),
  });
}

export async function countAdmissionDeferrals({
  db,
  organizationId,
  repoFullName,
  since,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  since: Date;
}): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(selfHealBreakerEvent)
    .where(
      and(
        eq(selfHealBreakerEvent.organizationId, organizationId),
        eq(selfHealBreakerEvent.scopeKind, ADMISSION_EVENT_SCOPE_KIND),
        eq(selfHealBreakerEvent.scopeKey, normalizeRepo(repoFullName)),
        gte(selfHealBreakerEvent.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}
