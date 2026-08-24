import { DB } from "../db";
import { hatchetRun } from "../db/schema";
import { HatchetRun } from "../db/types";
import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { thread as threadTable } from "../db/schema";
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
}: {
  db: DB;
  threadId: string;
  organizationId: string;
  repoFullName: string;
  prNumber: number;
  externalId: string;
}): Promise<HatchetRun> {
  const [row] = await db
    .insert(hatchetRun)
    .values({
      threadId,
      organizationId,
      repoFullName: normalizeRepo(repoFullName),
      prNumber,
      externalId,
    })
    .returning();
  return row!;
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
 * Mark the row for ONE run `superseded` by its Hatchet externalId (#125 C1:
 * the worker's own terminal). No-op when untracked (non-review run).
 */
export async function markHatchetRunSupersededByExternalId({
  db,
  externalId,
}: {
  db: DB;
  externalId: string;
}): Promise<void> {
  await db
    .update(hatchetRun)
    .set({ status: "superseded" })
    .where(eq(hatchetRun.externalId, externalId));
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
}: {
  db: DB;
  olderThanMs: number;
  now?: Date;
}): Promise<
  {
    id: string;
    threadId: string;
    organizationId: string;
    repoFullName: string;
    prNumber: number;
    externalId: string;
    createdAt: Date;
  }[]
> {
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
        inArray(threadTable.status, [
          "booting",
          "stopping",
          "working",
          "working-done",
          "working-error",
          "checkpointing",
        ]),
        or(
          isNull(hatchetRun.sweepLeaseUntil),
          lt(hatchetRun.sweepLeaseUntil, now),
        ),
      ),
    );
}

/**
 * Claim the sweep lease for one run (compare-and-set): succeeds only when the
 * row is unleased or its lease expired. The caller acts ONLY on `true`; a
 * concurrent tick gets `false` and skips — two ticks never both act.
 */
export async function claimSweepLease({
  db,
  id,
  now = new Date(),
  leaseMs = SWEEP_LEASE_MS,
}: {
  db: DB;
  id: string;
  now?: Date;
  leaseMs?: number;
}): Promise<boolean> {
  const rows = await db
    .update(hatchetRun)
    .set({ sweepLeaseUntil: new Date(now.getTime() + leaseMs) })
    .where(
      and(
        eq(hatchetRun.id, id),
        or(
          isNull(hatchetRun.sweepLeaseUntil),
          lt(hatchetRun.sweepLeaseUntil, now),
        ),
      ),
    )
    .returning({ id: hatchetRun.id });
  return rows.length > 0;
}

/**
 * Is there a run for the same (org, repo, PR) recorded AFTER `after`? Used by
 * the sweep's cause inference (a cancelled run with a newer sibling was
 * superseded) and by the queue-mode staleness self-check (a newer run is
 * already queued → skip). Org-fenced like every read here.
 */
export async function hasNewerRun({
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
}): Promise<boolean> {
  const rows = await db
    .select({ id: hatchetRun.id })
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
    .limit(1);
  return rows.length > 0;
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

/** Mark one run row terminal-by-sweep so it is never a supersede candidate again. */
export async function markHatchetRunSwept({
  db,
  id,
}: {
  db: DB;
  id: string;
}): Promise<void> {
  await db
    .update(hatchetRun)
    .set({ status: "superseded", sweepLeaseUntil: sql`NULL` })
    .where(eq(hatchetRun.id, id));
}
