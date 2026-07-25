import { DB } from "../db";
import { hatchetRun } from "../db/schema";
import { HatchetRun } from "../db/types";
import { and, eq, gte, inArray, ne } from "drizzle-orm";

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

/** Normalize a repo slug for storage/lookup (case-insensitive GitHub slugs). */
function normalizeRepo(repoFullName: string): string {
  return repoFullName.trim().toLowerCase();
}

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
