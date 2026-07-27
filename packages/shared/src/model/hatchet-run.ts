import { DB } from "../db";
import { hatchetRun } from "../db/schema";
import { HatchetRun } from "../db/types";
import { and, eq, gte, inArray, lt, ne } from "drizzle-orm";
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
