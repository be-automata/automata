import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import type { DB } from "../db";
import { deliveryFixCycles, deliveryPullRequests } from "../db/schema";
import { DELIVERY_FIX_CAP } from "./delivery-loop-settings";
import { type SelfHealTx, withSelfHealTx } from "./self-heal-tx";

/**
 * #509 delivery loop ledger. `delivery_pull_requests` holds the loop state of
 * each enrolled pull request; `delivery_fix_cycles` holds one row per fix
 * cycle. Every phase change is a compare-and-set on (phase, head_sha), and a
 * head gets at most one cycle (UNIQUE delivery_pr_id, trigger_head_sha), so a
 * webhook redelivery, the sweep and an in-process trigger converge on one
 * outcome.
 */

export type DeliveryPhase = (typeof deliveryPullRequests.$inferSelect)["phase"];
export type DeliveryFixCycleState =
  (typeof deliveryFixCycles.$inferSelect)["state"];
export type DeliveryFixTrigger =
  (typeof deliveryFixCycles.$inferSelect)["trigger"];
export type DeliveryPullRequestRow = typeof deliveryPullRequests.$inferSelect;
export type DeliveryFixCycleRow = typeof deliveryFixCycles.$inferSelect;

/** Phases the loop never leaves. */
export const DELIVERY_TERMINAL_PHASES: readonly DeliveryPhase[] = [
  "merged",
  "closed",
];

/** How long one evaluation may hold a row. */
export const DELIVERY_LEASE_MS = 60_000;

export interface EnrollDeliveryPrInput {
  organizationId: string;
  repoFullName: string;
  prNumber: number;
  issueNumber: number;
  headRef: string;
  baseRef: string;
  headSha: string | null;
  deliveryThreadId: string;
  automationId: string;
  now: Date;
}

/**
 * Enrolls a pull request in `awaiting_ci`. Idempotent: a second call for the
 * same (org, repo, PR) returns the existing row and changes nothing.
 */
export async function enrollDeliveryPr(
  db: DB,
  input: EnrollDeliveryPrInput,
): Promise<{ row: DeliveryPullRequestRow; created: boolean }> {
  const repoFullName = input.repoFullName.toLowerCase();
  const [inserted] = await db
    .insert(deliveryPullRequests)
    .values({
      organizationId: input.organizationId,
      repoFullName,
      prNumber: input.prNumber,
      issueNumber: input.issueNumber,
      headRef: input.headRef,
      baseRef: input.baseRef,
      headSha: input.headSha,
      headSeenAt: input.headSha === null ? null : input.now,
      deliveryThreadId: input.deliveryThreadId,
      automationId: input.automationId,
      phase: "awaiting_ci",
      lastReason: "enrolled",
    })
    .onConflictDoNothing({
      target: [
        deliveryPullRequests.organizationId,
        deliveryPullRequests.repoFullName,
        deliveryPullRequests.prNumber,
      ],
    })
    .returning();
  if (inserted) return { row: inserted, created: true };
  const existing = await findDeliveryPr(db, {
    organizationId: input.organizationId,
    repoFullName,
    prNumber: input.prNumber,
  });
  if (!existing) {
    throw new Error(
      `enrollDeliveryPr: conflict on ${repoFullName}#${input.prNumber} but no row found`,
    );
  }
  return { row: existing, created: false };
}

export async function getDeliveryPr(
  db: DB,
  id: string,
): Promise<DeliveryPullRequestRow | undefined> {
  const [row] = await db
    .select()
    .from(deliveryPullRequests)
    .where(eq(deliveryPullRequests.id, id));
  return row;
}

export async function findDeliveryPr(
  db: DB,
  key: { organizationId: string; repoFullName: string; prNumber: number },
): Promise<DeliveryPullRequestRow | undefined> {
  const [row] = await db
    .select()
    .from(deliveryPullRequests)
    .where(
      and(
        eq(deliveryPullRequests.organizationId, key.organizationId),
        eq(deliveryPullRequests.repoFullName, key.repoFullName.toLowerCase()),
        eq(deliveryPullRequests.prNumber, key.prNumber),
      ),
    );
  return row;
}

/**
 * Non-terminal enrolled PRs of a repo, by PR number or by head sha (the keys
 * a review event and a CI event carry). Not org-scoped: a webhook knows the
 * repo, and the evaluator re-reads everything it acts on.
 */
export async function findOpenDeliveryPrs(
  db: DB,
  key: { repoFullName: string } & (
    | { prNumber: number }
    | { headSha: string }
    | { headRef: string }
  ),
): Promise<DeliveryPullRequestRow[]> {
  const repo = eq(
    deliveryPullRequests.repoFullName,
    key.repoFullName.toLowerCase(),
  );
  const match =
    "prNumber" in key
      ? eq(deliveryPullRequests.prNumber, key.prNumber)
      : "headSha" in key
        ? eq(deliveryPullRequests.headSha, key.headSha)
        : eq(deliveryPullRequests.headRef, key.headRef);
  return await db
    .select()
    .from(deliveryPullRequests)
    .where(
      and(
        repo,
        match,
        notInArray(deliveryPullRequests.phase, [...DELIVERY_TERMINAL_PHASES]),
      ),
    );
}

/** The sweep's batch: non-terminal rows, least recently evaluated first. */
export async function listDeliveryPrsForSweep(
  db: DB,
  limit: number,
): Promise<DeliveryPullRequestRow[]> {
  return await db
    .select()
    .from(deliveryPullRequests)
    .where(
      notInArray(deliveryPullRequests.phase, [...DELIVERY_TERMINAL_PHASES]),
    )
    .orderBy(asc(sql`coalesce(${deliveryPullRequests.evaluatedAt}, 'epoch')`))
    .limit(limit);
}

/**
 * Takes the evaluation lease when it is free or lapsed. False = another
 * evaluator holds it (the caller skips; the holder re-reads anyway).
 */
export async function acquireDeliveryLease(
  db: DB,
  id: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(deliveryPullRequests)
    .set({ leaseUntil: new Date(now.getTime() + DELIVERY_LEASE_MS) })
    .where(
      and(
        eq(deliveryPullRequests.id, id),
        or(
          isNull(deliveryPullRequests.leaseUntil),
          lt(deliveryPullRequests.leaseUntil, now),
        ),
      ),
    )
    .returning({ id: deliveryPullRequests.id });
  return rows.length === 1;
}

export async function releaseDeliveryLease(
  db: DB,
  id: string,
  now: Date,
): Promise<void> {
  await db
    .update(deliveryPullRequests)
    .set({ leaseUntil: null, evaluatedAt: now })
    .where(eq(deliveryPullRequests.id, id));
}

/**
 * Stamps `evaluated_at` without touching the lease: an evaluation that
 * skipped before taking it (the loop is off for the repo) still moves the row
 * to the back of the sweep, so rows with the loop off never starve the rest.
 */
export async function touchDeliveryEvaluated(
  db: DB,
  id: string,
  now: Date,
): Promise<void> {
  await db
    .update(deliveryPullRequests)
    .set({ evaluatedAt: now })
    .where(eq(deliveryPullRequests.id, id));
}

export type DeliveryPrPatch = Partial<
  Pick<
    DeliveryPullRequestRow,
    | "phase"
    | "headSha"
    | "headSeenAt"
    | "readyMarkedHeadSha"
    | "readyMarkedAt"
    | "mergeReadyHeadSha"
    | "mergeReadyCommentId"
    | "stopCommentId"
    | "lastReason"
  >
>;

/**
 * Compare-and-set: applies `patch` only while the row is still in
 * `expectedPhase` at `expectedHeadSha` (null matches null). False = someone
 * else moved it first; the caller re-reads, never retries blindly.
 */
export async function transitionDeliveryPr(
  db: DB,
  {
    id,
    expectedPhase,
    expectedHeadSha,
    patch,
  }: {
    id: string;
    expectedPhase: DeliveryPhase;
    expectedHeadSha: string | null;
    patch: DeliveryPrPatch;
  },
): Promise<boolean> {
  const rows = await db
    .update(deliveryPullRequests)
    .set(patch)
    .where(
      and(
        eq(deliveryPullRequests.id, id),
        eq(deliveryPullRequests.phase, expectedPhase),
        sql`${deliveryPullRequests.headSha} IS NOT DISTINCT FROM ${expectedHeadSha}`,
      ),
    )
    .returning({ id: deliveryPullRequests.id });
  return rows.length === 1;
}

/**
 * The next `cycle_no` of a PR: a sequence over EVERY cycle row, shadow ones
 * included, so a PR that ran in shadow before going live never collides on
 * (delivery_pr_id, cycle_no). The cap counts `cycles_used`, not this.
 */
async function nextCycleNo(
  db: Pick<DB, "select">,
  deliveryPrId: string,
): Promise<number> {
  const [row] = await db
    .select({
      next: sql<number>`coalesce(max(${deliveryFixCycles.cycleNo}), 0) + 1`,
    })
    .from(deliveryFixCycles)
    .where(eq(deliveryFixCycles.deliveryPrId, deliveryPrId));
  return Number(row?.next ?? 1);
}

export type StartFixCycleResult =
  | { kind: "started"; cycle: DeliveryFixCycleRow }
  /** This head already has a cycle (redelivery, sweep, second trigger). */
  | { kind: "duplicate" }
  | { kind: "cap_reached"; cyclesUsed: number }
  /** The row moved (phase or head) before the cycle could start. */
  | { kind: "stale" };

/**
 * Locks the PR row for the rest of the transaction. Every cycle writer takes
 * it before reading the head's cycle or computing `cycle_no`, so writers on
 * one PR are serialized and `cycle_no` never collides.
 */
async function lockDeliveryPr(tx: SelfHealTx, deliveryPrId: string) {
  const [row] = await tx
    .select({
      phase: deliveryPullRequests.phase,
      headSha: deliveryPullRequests.headSha,
      cyclesUsed: deliveryPullRequests.cyclesUsed,
    })
    .from(deliveryPullRequests)
    .where(eq(deliveryPullRequests.id, deliveryPrId))
    .for("update");
  return row;
}

async function cycleAtHead(
  tx: SelfHealTx,
  deliveryPrId: string,
  headSha: string,
) {
  const [row] = await tx
    .select({ id: deliveryFixCycles.id, state: deliveryFixCycles.state })
    .from(deliveryFixCycles)
    .where(
      and(
        eq(deliveryFixCycles.deliveryPrId, deliveryPrId),
        eq(deliveryFixCycles.triggerHeadSha, headSha),
      ),
    );
  return row;
}

/** The head index: the only conflict a cycle insert may absorb. */
const CYCLE_HEAD_TARGET = [
  deliveryFixCycles.deliveryPrId,
  deliveryFixCycles.triggerHeadSha,
];

/**
 * Starts a fix cycle at `headSha`: in one transaction, moves the row from
 * `expectedPhase` to `fixing`, spends one cycle (only below DELIVERY_FIX_CAP)
 * and puts the cycle row in `dispatching`. A shadow row recorded at this head
 * (the repo ran in shadow, then went live at the same head) becomes the live
 * cycle; any other row at this head is a duplicate. Any guard failing changes
 * nothing.
 */
export async function startDeliveryFixCycle(
  db: DB,
  {
    deliveryPrId,
    expectedPhase,
    headSha,
    trigger,
    reviewId,
    failingChecks,
  }: {
    deliveryPrId: string;
    expectedPhase: DeliveryPhase;
    headSha: string;
    trigger: DeliveryFixTrigger;
    reviewId: number | null;
    failingChecks: string[];
  },
): Promise<StartFixCycleResult> {
  return await withSelfHealTx(db, async (tx) => {
    const row = await lockDeliveryPr(tx, deliveryPrId);
    if (!row || row.phase !== expectedPhase || row.headSha !== headSha) {
      return { kind: "stale" };
    }
    const existing = await cycleAtHead(tx, deliveryPrId, headSha);
    if (existing && existing.state !== "shadow") return { kind: "duplicate" };
    if (row.cyclesUsed >= DELIVERY_FIX_CAP) {
      return { kind: "cap_reached", cyclesUsed: row.cyclesUsed };
    }
    const cyclesUsed = row.cyclesUsed + 1;
    const live = {
      trigger,
      reviewId,
      failingChecks,
      state: "dispatching" as const,
    };
    const [cycle] = existing
      ? await tx
          .update(deliveryFixCycles)
          .set({ ...live, createdAt: new Date() })
          .where(eq(deliveryFixCycles.id, existing.id))
          .returning()
      : await tx
          .insert(deliveryFixCycles)
          .values({
            deliveryPrId,
            cycleNo: await nextCycleNo(tx, deliveryPrId),
            triggerHeadSha: headSha,
            ...live,
          })
          .onConflictDoNothing({ target: CYCLE_HEAD_TARGET })
          .returning();
    if (!cycle) return { kind: "duplicate" };
    await tx
      .update(deliveryPullRequests)
      .set({
        phase: "fixing",
        cyclesUsed,
        lastReason: `cycle ${cyclesUsed} (${trigger})`,
      })
      .where(eq(deliveryPullRequests.id, deliveryPrId));
    return { kind: "started", cycle };
  });
}

/**
 * Shadow mode: records the cycle the loop would have started at `headSha`,
 * without spending a cycle or moving the phase. Idempotent per head; takes
 * the same row lock as the live path, so `cycle_no` never collides.
 */
export async function recordShadowFixCycle(
  db: DB,
  {
    deliveryPrId,
    headSha,
    trigger,
    reviewId,
    failingChecks,
  }: {
    deliveryPrId: string;
    headSha: string;
    trigger: DeliveryFixTrigger;
    reviewId: number | null;
    failingChecks: string[];
  },
): Promise<boolean> {
  return await withSelfHealTx(db, async (tx) => {
    if (!(await lockDeliveryPr(tx, deliveryPrId))) return false;
    if (await cycleAtHead(tx, deliveryPrId, headSha)) return false;
    const rows = await tx
      .insert(deliveryFixCycles)
      .values({
        deliveryPrId,
        cycleNo: await nextCycleNo(tx, deliveryPrId),
        triggerHeadSha: headSha,
        trigger,
        reviewId,
        failingChecks,
        state: "shadow",
      })
      .onConflictDoNothing({ target: CYCLE_HEAD_TARGET })
      .returning({ id: deliveryFixCycles.id });
    return rows.length === 1;
  });
}

/** dispatching -> running, once the cycle's thread exists. */
export async function bindDeliveryFixCycleThread(
  db: DB,
  { cycleId, threadId }: { cycleId: string; threadId: string },
): Promise<boolean> {
  const rows = await db
    .update(deliveryFixCycles)
    .set({ threadId, state: "running" })
    .where(
      and(
        eq(deliveryFixCycles.id, cycleId),
        eq(deliveryFixCycles.state, "dispatching"),
      ),
    )
    .returning({ id: deliveryFixCycles.id });
  return rows.length === 1;
}

/** running -> pushed | no_push, when the cycle's thread finished. */
export async function settleDeliveryFixCycle(
  db: DB,
  {
    cycleId,
    state,
    resultHeadSha,
    now,
  }: {
    cycleId: string;
    state: "pushed" | "no_push";
    resultHeadSha: string | null;
    now: Date;
  },
): Promise<boolean> {
  const rows = await db
    .update(deliveryFixCycles)
    .set({ state, resultHeadSha, finishedAt: now })
    .where(
      and(
        eq(deliveryFixCycles.id, cycleId),
        inArray(deliveryFixCycles.state, ["dispatching", "running"]),
      ),
    )
    .returning({ id: deliveryFixCycles.id });
  return rows.length === 1;
}

/**
 * A cycle whose thread never started: marks it abandoned, refunds the cycle
 * and puts the row back in `restorePhase`, in one transaction. Only a
 * `dispatching` cycle of a row still in `fixing` is refunded.
 */
export async function abandonDeliveryFixCycle(
  db: DB,
  {
    cycleId,
    restorePhase,
    reason,
    now,
  }: {
    cycleId: string;
    restorePhase: DeliveryPhase;
    reason: string;
    now: Date;
  },
): Promise<boolean> {
  return await withSelfHealTx(db, async (tx) => {
    const [cycle] = await tx
      .update(deliveryFixCycles)
      .set({ state: "abandoned", finishedAt: now })
      .where(
        and(
          eq(deliveryFixCycles.id, cycleId),
          eq(deliveryFixCycles.state, "dispatching"),
        ),
      )
      .returning({ deliveryPrId: deliveryFixCycles.deliveryPrId });
    if (!cycle) return false;
    await tx
      .update(deliveryPullRequests)
      .set({
        phase: restorePhase,
        cyclesUsed: sql`greatest(${deliveryPullRequests.cyclesUsed} - 1, 0)`,
        lastReason: reason,
      })
      .where(
        and(
          eq(deliveryPullRequests.id, cycle.deliveryPrId),
          eq(deliveryPullRequests.phase, "fixing"),
        ),
      );
    return true;
  });
}

export async function listDeliveryFixCycles(
  db: DB,
  deliveryPrId: string,
): Promise<DeliveryFixCycleRow[]> {
  return await db
    .select()
    .from(deliveryFixCycles)
    .where(eq(deliveryFixCycles.deliveryPrId, deliveryPrId))
    .orderBy(asc(deliveryFixCycles.cycleNo));
}
