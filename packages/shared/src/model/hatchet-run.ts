import { DB } from "../db";
import { hatchetRun } from "../db/schema";
import { HatchetRun } from "../db/types";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
} from "drizzle-orm";
import { thread as threadTable } from "../db/schema";
import { reapableThreadStatuses, threadEffectiveStatusIn } from "./threads";
import { normalizeRepo } from "./repo-review-settings";

/**
 * Per-dispatch tracking of the Hatchet `agent-run` externalId, for #8 supersede.
 * Only PR-review dispatches write rows (mentions never supersede). When a newer
 * review run is dispatched for the same (org, repo, PR), the prior run's row is the
 * handle used to cancel it and mark it superseded.
 *
 * MULTI-TENANT: every read/write is fenced by `organizationId`. `repoFullName` is
 * lowercased on write AND read (case-insensitive GitHub slugs), matching
 * `repo-review-settings` — a case-mismatched slug must never silently miss a live run.
 */

/** Only in_flight rows this recent are supersede candidates (≈ the 75m stalled cutoff). */
export const SUPERSEDE_FRESHNESS_MS = 75 * 60 * 1000;

/**
 * Rows older than this are dead weight: far past SUPERSEDE_FRESHNESS_MS, they can
 * never again be a supersede candidate, so the hourly prune deletes them to bound
 * table growth. 24h keeps a generous debugging window (~19x the freshness window).
 */
export const HATCHET_RUN_PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Record a freshly-dispatched review run as `in_flight`. Called AFTER a successful
 * trigger with the externalId (`run.metadata.id`) so the run is cancellable if a
 * newer push supersedes it. No-op-safe to call once per dispatch.
 */
export async function recordHatchetRun({
  db,
  threadId,
  organizationId,
  repoFullName,
  prNumber,
  externalId,
  snapshot,
}: {
  db: DB;
  threadId: string;
  organizationId: string;
  repoFullName: string;
  prNumber: number;
  externalId: string;
  /** #125 C5: the policy snapshot stamped at dispatch (absent on legacy dispatches). */
  snapshot?: { policy: string; recheckOnComplete: boolean };
}): Promise<HatchetRun> {
  const [row] = await db
    .insert(hatchetRun)
    .values({
      threadId,
      organizationId,
      repoFullName: normalizeRepo(repoFullName),
      prNumber,
      externalId,
      ...(snapshot
        ? {
            supersedePolicy: snapshot.policy,
            recheckOnComplete: snapshot.recheckOnComplete,
          }
        : {}),
    })
    .returning();
  return row!;
}

/** The latest recorded run for one thread. */
export async function getLatestHatchetRunForThread({
  db,
  threadId,
}: {
  db: DB;
  threadId: string;
}): Promise<HatchetRun | undefined> {
  const [row] = await db
    .select()
    .from(hatchetRun)
    .where(eq(hatchetRun.threadId, threadId))
    .orderBy(desc(hatchetRun.createdAt))
    .limit(1);
  return row;
}

/**
 * Find the LIVE in_flight review runs for one (org, repo, PR) that a newer review
 * dispatch should supersede — every fresh in_flight row EXCEPT the current thread's
 * own (a dispatch never cancels itself). Bounded to the freshness window so a
 * long-finished run (whose row was never marked finished) is not a cancel target.
 */
export async function findSupersedableReviewRuns({
  db,
  organizationId,
  repoFullName,
  prNumber,
  excludeThreadId,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  prNumber: number;
  excludeThreadId: string;
  now?: Date;
}): Promise<HatchetRun[]> {
  return db
    .select()
    .from(hatchetRun)
    .where(
      and(
        eq(hatchetRun.organizationId, organizationId),
        eq(hatchetRun.repoFullName, normalizeRepo(repoFullName)),
        eq(hatchetRun.prNumber, prNumber),
        eq(hatchetRun.status, "in_flight"),
        ne(hatchetRun.threadId, excludeThreadId),
        gte(
          hatchetRun.createdAt,
          new Date(now.getTime() - SUPERSEDE_FRESHNESS_MS),
        ),
      ),
    );
}

/**
 * Delete rows older than HATCHET_RUN_PRUNE_AFTER_MS (any status). Rows are never
 * eagerly marked finished, so age is the only growth bound — the hourly
 * stalled-tasks cron calls this to keep the table from growing without limit.
 * Deliberately NOT org-fenced: it is maintenance over all orgs. Returns the
 * number of rows deleted.
 */
export async function pruneHatchetRuns({
  db,
  now = new Date(),
}: {
  db: DB;
  now?: Date;
}): Promise<number> {
  const deleted = await db
    .delete(hatchetRun)
    .where(
      lt(
        hatchetRun.createdAt,
        new Date(now.getTime() - HATCHET_RUN_PRUNE_AFTER_MS),
      ),
    )
    .returning({ id: hatchetRun.id });
  return deleted.length;
}

/** Mark rows `superseded` (their runs were cancelled by a newer review dispatch). */
export async function markHatchetRunsSuperseded({
  db,
  ids,
}: {
  db: DB;
  ids: string[];
}): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(hatchetRun)
    .set({ status: "superseded" })
    .where(inArray(hatchetRun.id, ids));
}

/**
 * Retire one run row from the supersede-candidate set (#125 C1/C4): the
 * status names WHY it left — `superseded` (a newer run took the PR) or
 * `terminal` (any other typed terminal; the cause itself lives on the
 * thread). Keyed by row id (sweep) or by Hatchet externalId (worker
 * terminal); always clears the sweep lease.
 */
export async function retireHatchetRun({
  db,
  key,
  as,
}: {
  db: DB;
  key: { id: string } | { externalId: string };
  as: "superseded" | "terminal";
}): Promise<void> {
  await db
    .update(hatchetRun)
    .set({ status: as, sweepLeaseUntil: null })
    .where(
      "id" in key
        ? eq(hatchetRun.id, key.id)
        : eq(hatchetRun.externalId, key.externalId),
    );
}

/** Sweep lease length (#125 C4): a tick owns a run this long; expired = retry next tick. */
export const SWEEP_LEASE_MS = 5 * 60 * 1000;

/**
 * Runs the #125 C4 sweep should inspect: still `in_flight` here, dispatched
 * more than `olderThanMs` ago, whose thread is NOT yet terminal, and not
 * currently leased by another tick. Bounded by the freshness window so the
 * sweep never chases runs the watchdog already owns.
 */
export async function findSweepCandidates({
  db,
  olderThanMs,
  now = new Date(),
  limit = SWEEP_BATCH_LIMIT,
}: {
  db: DB;
  olderThanMs: number;
  now?: Date;
  limit?: number;
}) {
  return db
    .select({
      id: hatchetRun.id,
      threadId: hatchetRun.threadId,
      organizationId: hatchetRun.organizationId,
      repoFullName: hatchetRun.repoFullName,
      prNumber: hatchetRun.prNumber,
      externalId: hatchetRun.externalId,
      createdAt: hatchetRun.createdAt,
    })
    .from(hatchetRun)
    .innerJoin(threadTable, eq(threadTable.id, hatchetRun.threadId))
    .where(
      and(
        eq(hatchetRun.status, "in_flight"),
        lt(hatchetRun.createdAt, new Date(now.getTime() - olderThanMs)),
        gte(
          hatchetRun.createdAt,
          new Date(now.getTime() - SUPERSEDE_FRESHNESS_MS),
        ),
        isNull(threadTable.terminalCause),
        threadEffectiveStatusIn(reapableThreadStatuses),
        or(
          isNull(hatchetRun.sweepLeaseUntil),
          lt(hatchetRun.sweepLeaseUntil, now),
        ),
      ),
    )
    .orderBy(hatchetRun.createdAt)
    .limit(limit);
}
export type SweepCandidate = Awaited<
  ReturnType<typeof findSweepCandidates>
>[number];

/** A bad hour must not blow the every-minute cron: leftovers are safe for the next tick (lease). */
export const SWEEP_BATCH_LIMIT = 50;

/**
 * Claim the sweep lease for a batch of runs in ONE compare-and-set UPDATE:
 * a row is won only when unleased or expired. Returns the ids won; a
 * concurrent tick gets the complement — two ticks never both act on a run.
 */
export async function claimSweepLeases({
  db,
  ids,
  now = new Date(),
  leaseMs = SWEEP_LEASE_MS,
}: {
  db: DB;
  ids: string[];
  now?: Date;
  leaseMs?: number;
}): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(hatchetRun)
    .set({ sweepLeaseUntil: new Date(now.getTime() + leaseMs) })
    .where(
      and(
        inArray(hatchetRun.id, ids),
        or(
          isNull(hatchetRun.sweepLeaseUntil),
          lt(hatchetRun.sweepLeaseUntil, now),
        ),
      ),
    )
    .returning({ id: hatchetRun.id });
  return rows.map((r) => r.id);
}

/** One-row convenience over claimSweepLeases (tests). */
export async function claimSweepLease(args: {
  db: DB;
  id: string;
  now?: Date;
  leaseMs?: number;
}): Promise<boolean> {
  return (await claimSweepLeases({ ...args, ids: [args.id] })).length > 0;
}

/**
 * Re-time a held lease: a run that is still LIVE on the engine is pushed out
 * to a longer horizon (no point re-reading it every 5 min), and a read
 * failure releases it so the next tick retries at once.
 */
export async function setSweepLease({
  db,
  id,
  until,
}: {
  db: DB;
  id: string;
  until: Date | null;
}): Promise<void> {
  await db
    .update(hatchetRun)
    .set({ sweepLeaseUntil: until })
    .where(eq(hatchetRun.id, id));
}

/**
 * Is there a run for the same (org, repo, PR) recorded AFTER `after`? Used by
 * the sweep's cause inference (a cancelled run with a newer sibling was
 * superseded) and by the queue-mode staleness self-check (a newer run is
 * already queued → skip). Org-fenced like every read here.
 */
export async function hasNewerRun(
  args: Parameters<typeof findNewerRun>[0],
): Promise<boolean> {
  return (await findNewerRun(args)) !== null;
}

/** The newest later sibling run for the same (org, repo, PR), if any. */
export async function findNewerRun({
  db,
  organizationId,
  repoFullName,
  prNumber,
  after,
  excludeExternalId,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  prNumber: number;
  after: Date;
  excludeExternalId?: string;
}): Promise<{ threadId: string; externalId: string } | null> {
  const rows = await db
    .select({
      threadId: hatchetRun.threadId,
      externalId: hatchetRun.externalId,
    })
    .from(hatchetRun)
    .where(
      and(
        eq(hatchetRun.organizationId, organizationId),
        eq(hatchetRun.repoFullName, normalizeRepo(repoFullName)),
        eq(hatchetRun.prNumber, prNumber),
        gt(hatchetRun.createdAt, after),
        ...(excludeExternalId
          ? [ne(hatchetRun.externalId, excludeExternalId)]
          : []),
      ),
    )
    .orderBy(desc(hatchetRun.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** The recorded row for one Hatchet externalId (any org — the caller is a daemon-token route). */
export async function getHatchetRunByExternalId({
  db,
  externalId,
}: {
  db: DB;
  externalId: string;
}): Promise<HatchetRun | undefined> {
  const [row] = await db
    .select()
    .from(hatchetRun)
    .where(eq(hatchetRun.externalId, externalId))
    .limit(1);
  return row;
}
