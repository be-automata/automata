import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";

import type { DB } from "../db";
import {
  auditEffects,
  auditFindings,
  auditFixAttempts,
  auditRuns,
} from "../db/schema";
import { normalizeRepo } from "./repo-review-settings";
import { withSelfHealTx } from "./self-heal-tx";

/**
 * Audit-run and finding ledger.
 *
 * MULTI-TENANT (ADR-001): every function takes `organizationId` and filters on
 * it, except the ones named in UNFENCED_SELF_HEAL_MODEL_FUNCTIONS (self-heal-breaker.ts), which
 * are cross-org by design (a sweep, or a token-authenticated report).
 */

export type AuditRunRow = typeof auditRuns.$inferSelect;
export type AuditFindingRow = typeof auditFindings.$inferSelect;
export type AuditFindingInsert = typeof auditFindings.$inferInsert;
export type AuditEffectRow = typeof auditEffects.$inferSelect;
export type AuditFixAttemptRow = typeof auditFixAttempts.$inferSelect;
export interface AuditCheckResult {
  fingerprint: string;
  outcome: "pass" | "fail" | "error";
}

/** An audit run claim is leased for 10 minutes (RES-08). */
export const AUDIT_RUN_LEASE_MS = 600_000;

export async function createAuditRunAtDispatch({
  db,
  organizationId,
  repoFullName,
  threadId,
  audit,
  requestedChecks,
  checkTokenHash,
  checkTokenExpiresAt,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  threadId: string;
  audit: string;
  requestedChecks?: unknown;
  checkTokenHash?: string;
  checkTokenExpiresAt?: Date;
}): Promise<void> {
  await db
    .insert(auditRuns)
    .values({
      organizationId,
      repoFullName: normalizeRepo(repoFullName),
      threadId,
      audit,
      status: "dispatched",
      requestedChecks: requestedChecks ?? null,
      checkTokenHash: checkTokenHash ?? null,
      checkTokenExpiresAt: checkTokenExpiresAt ?? null,
    })
    .onConflictDoNothing({ target: auditRuns.threadId });
}

/**
 * Lease the run for `leaseMs`. Wins when no row exists yet (insert), or the
 * row is 'dispatched', or it is 'claimed' with an expired lease. Returns null
 * for a loser. Runs in a timeout-bounded transaction.
 */
export async function claimAuditRun({
  db,
  organizationId,
  repoFullName,
  threadId,
  audit,
  leaseMs = AUDIT_RUN_LEASE_MS,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  threadId: string;
  audit: string;
  leaseMs?: number;
  now?: Date;
}): Promise<AuditRunRow | null> {
  const expires = new Date(now.getTime() + leaseMs);
  return withSelfHealTx(db, async (tx) => {
    const inserted = await tx
      .insert(auditRuns)
      .values({
        organizationId,
        repoFullName: normalizeRepo(repoFullName),
        threadId,
        audit,
        status: "claimed",
        claimedAt: now,
        claimExpiresAt: expires,
        claimCount: 1,
      })
      .onConflictDoNothing({ target: auditRuns.threadId })
      .returning();
    if (inserted[0]) return inserted[0];
    const updated = await tx
      .update(auditRuns)
      .set({
        status: "claimed",
        claimedAt: now,
        claimExpiresAt: expires,
        claimCount: sql`${auditRuns.claimCount} + 1`,
      })
      .where(
        and(
          eq(auditRuns.threadId, threadId),
          eq(auditRuns.organizationId, organizationId),
          or(
            eq(auditRuns.status, "dispatched"),
            and(
              eq(auditRuns.status, "claimed"),
              lt(auditRuns.claimExpiresAt, now),
            ),
          ),
        ),
      )
      .returning();
    return updated[0] ?? null;
  });
}

/** Hand a claimed run back so the sweep retries it (preflight unavailable). */
export async function releaseAuditRunClaim({
  db,
  organizationId,
  id,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  id: string;
  now?: Date;
}): Promise<void> {
  await withSelfHealTx(db, async (tx) => {
    await tx
      .update(auditRuns)
      .set({ status: "dispatched", claimExpiresAt: now })
      .where(
        and(
          eq(auditRuns.id, id),
          eq(auditRuns.organizationId, organizationId),
          eq(auditRuns.status, "claimed"),
        ),
      );
  });
}

export interface FinishAuditRunInput {
  db: DB;
  organizationId: string;
  id: string;
  status: "done" | "failed";
  mode?: string;
  outcome?: string;
  complete?: boolean;
  counts?: {
    parsed?: number;
    created?: number;
    updated?: number;
    closed?: number;
  };
  skipped?: unknown;
  decisions?: unknown;
  error?: string;
  now?: Date;
}

export async function finishAuditRun({
  db,
  organizationId,
  id,
  status,
  mode,
  outcome,
  complete,
  counts,
  skipped,
  decisions,
  error,
  now = new Date(),
}: FinishAuditRunInput): Promise<AuditRunRow | null> {
  return withSelfHealTx(db, async (tx) => {
    const rows = await tx
      .update(auditRuns)
      .set({
        status,
        mode: mode ?? null,
        outcome: outcome ?? null,
        complete: complete ?? null,
        parsedCount: counts?.parsed ?? 0,
        createdCount: counts?.created ?? 0,
        updatedCount: counts?.updated ?? 0,
        closedCount: counts?.closed ?? 0,
        skipped: skipped ?? null,
        decisions: decisions ?? null,
        error: error ?? null,
        claimExpiresAt: null,
        finishedAt: now,
      })
      .where(
        and(eq(auditRuns.id, id), eq(auditRuns.organizationId, organizationId)),
      )
      .returning();
    return rows[0] ?? null;
  });
}

/** UNFENCED: the sweep reclaims across all orgs. */
export async function listReclaimableAuditRuns({
  db,
  now = new Date(),
  limit = 20,
}: {
  db: DB;
  now?: Date;
  limit?: number;
}): Promise<AuditRunRow[]> {
  return withSelfHealTx(db, (tx) =>
    tx
      .select()
      .from(auditRuns)
      .where(
        and(eq(auditRuns.status, "claimed"), lt(auditRuns.claimExpiresAt, now)),
      )
      .orderBy(asc(auditRuns.claimExpiresAt))
      .limit(limit),
  );
}

export async function getAuditRunByThread({
  db,
  organizationId,
  threadId,
}: {
  db: DB;
  organizationId: string;
  threadId: string;
}): Promise<AuditRunRow | null> {
  const rows = await db
    .select()
    .from(auditRuns)
    .where(
      and(
        eq(auditRuns.threadId, threadId),
        eq(auditRuns.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** UNFENCED: the check token is the authority; the row carries organizationId. */
export async function getAuditRunForCheckReport({
  db,
  threadId,
}: {
  db: DB;
  threadId: string;
}): Promise<AuditRunRow | null> {
  const rows = await db
    .select()
    .from(auditRuns)
    .where(eq(auditRuns.threadId, threadId))
    .limit(1);
  return rows[0] ?? null;
}

/** First report wins; returns true only for the call that stored it. */
export async function recordAuditCheckResults({
  db,
  organizationId,
  threadId,
  results,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  threadId: string;
  results: AuditCheckResult[];
  now?: Date;
}): Promise<boolean> {
  const rows = await db
    .update(auditRuns)
    .set({ checkResults: results, checksReportedAt: now })
    .where(
      and(
        eq(auditRuns.threadId, threadId),
        eq(auditRuns.organizationId, organizationId),
        isNull(auditRuns.checkResults),
      ),
    )
    .returning({ id: auditRuns.id });
  return rows.length > 0;
}

export async function listFindingsForRepo({
  db,
  organizationId,
  repoFullName,
  statuses,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  statuses?: AuditFindingRow["status"][];
}): Promise<AuditFindingRow[]> {
  return db
    .select()
    .from(auditFindings)
    .where(
      and(
        eq(auditFindings.organizationId, organizationId),
        eq(auditFindings.repoFullName, normalizeRepo(repoFullName)),
        statuses && statuses.length > 0
          ? inArray(auditFindings.status, statuses)
          : undefined,
      ),
    );
}

export async function getFindingByIssue({
  db,
  organizationId,
  repoFullName,
  issueNumber,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  issueNumber: number;
}): Promise<AuditFindingRow | null> {
  const rows = await db
    .select()
    .from(auditFindings)
    .where(
      and(
        eq(auditFindings.organizationId, organizationId),
        eq(auditFindings.repoFullName, normalizeRepo(repoFullName)),
        eq(auditFindings.issueNumber, issueNumber),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Insert, or return the existing row for the same (org, repo, fingerprint). */
export async function insertFinding({
  db,
  organizationId,
  finding,
}: {
  db: DB;
  organizationId: string;
  finding: Omit<AuditFindingInsert, "organizationId" | "id"> & {
    repoFullName: string;
  };
}): Promise<AuditFindingRow> {
  const repo = normalizeRepo(finding.repoFullName);
  const inserted = await db
    .insert(auditFindings)
    .values({ ...finding, organizationId, repoFullName: repo })
    .onConflictDoNothing({
      target: [
        auditFindings.organizationId,
        auditFindings.repoFullName,
        auditFindings.fingerprint,
      ],
    })
    .returning();
  if (inserted[0]) return inserted[0];
  const existing = await db
    .select()
    .from(auditFindings)
    .where(
      and(
        eq(auditFindings.organizationId, organizationId),
        eq(auditFindings.repoFullName, repo),
        eq(auditFindings.fingerprint, finding.fingerprint),
      ),
    )
    .limit(1);
  const row = existing[0];
  if (!row) {
    throw new Error(
      "insertFinding: conflicting row vanished before it could be read",
    );
  }
  return row;
}

export async function updateFinding({
  db,
  organizationId,
  id,
  patch,
}: {
  db: DB;
  organizationId: string;
  id: string;
  patch: Partial<
    Omit<AuditFindingInsert, "id" | "organizationId" | "repoFullName">
  >;
}): Promise<AuditFindingRow | null> {
  const rows = await db
    .update(auditFindings)
    .set(patch)
    .where(
      and(
        eq(auditFindings.id, id),
        eq(auditFindings.organizationId, organizationId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Findings that currently hold a GitHub issue (candidate/open/needs_human). */
export async function countOpenFindingIssues({
  db,
  organizationId,
  repoFullName,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
}): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditFindings)
    .where(
      and(
        eq(auditFindings.organizationId, organizationId),
        eq(auditFindings.repoFullName, normalizeRepo(repoFullName)),
        inArray(auditFindings.status, ["open", "needs_human"]),
        sql`${auditFindings.issueNumber} is not null`,
      ),
    );
  return rows[0]?.n ?? 0;
}

/** Run row without the check-token hash (admin and export reads). */
export type AuditRunPublicRow = Omit<AuditRunRow, "checkTokenHash">;
/** Fix-attempt row without the gate-token hash. */
export type AuditFixAttemptPublicRow = Omit<
  AuditFixAttemptRow,
  "gateTokenHash"
>;

const { checkTokenHash: _runTokenHash, ...AUDIT_RUN_PUBLIC_COLUMNS } =
  getTableColumns(auditRuns);
const { gateTokenHash: _gateTokenHash, ...FIX_ATTEMPT_PUBLIC_COLUMNS } =
  getTableColumns(auditFixAttempts);

/** Newest first. Never selects check_token_hash (OBS-01 / T-08-18-1). */
export async function listAuditRunsForRepo({
  db,
  organizationId,
  repoFullName,
  limit,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  limit: number;
}): Promise<AuditRunPublicRow[]> {
  return db
    .select(AUDIT_RUN_PUBLIC_COLUMNS)
    .from(auditRuns)
    .where(
      and(
        eq(auditRuns.organizationId, organizationId),
        eq(auditRuns.repoFullName, normalizeRepo(repoFullName)),
      ),
    )
    .orderBy(desc(auditRuns.createdAt), desc(auditRuns.id))
    .limit(limit);
}

/** Newest first. Never selects gate_token_hash. Empty until Phase 9. */
export async function listFixAttemptsForRepo({
  db,
  organizationId,
  repoFullName,
  limit,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  limit: number;
}): Promise<AuditFixAttemptPublicRow[]> {
  return db
    .select(FIX_ATTEMPT_PUBLIC_COLUMNS)
    .from(auditFixAttempts)
    .where(
      and(
        eq(auditFixAttempts.organizationId, organizationId),
        eq(auditFixAttempts.repoFullName, normalizeRepo(repoFullName)),
      ),
    )
    .orderBy(desc(auditFixAttempts.createdAt), desc(auditFixAttempts.id))
    .limit(limit);
}

/** Newest first; the export feeds the benchmark scorer. */
export async function listEffectsForRepo({
  db,
  organizationId,
  repoFullName,
  limit,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  limit: number;
}): Promise<AuditEffectRow[]> {
  return db
    .select()
    .from(auditEffects)
    .where(
      and(
        eq(auditEffects.organizationId, organizationId),
        eq(auditEffects.repoFullName, normalizeRepo(repoFullName)),
      ),
    )
    .orderBy(desc(auditEffects.createdAt), desc(auditEffects.id))
    .limit(limit);
}

export interface OutboxSummary {
  pending: number;
  failed: number;
  oldestPendingAt: Date | null;
}

export async function summarizeOutbox({
  db,
  organizationId,
  repoFullName,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
}): Promise<OutboxSummary> {
  const where = (status: "pending" | "failed") =>
    and(
      eq(auditEffects.organizationId, organizationId),
      eq(auditEffects.repoFullName, normalizeRepo(repoFullName)),
      eq(auditEffects.status, status),
    );
  // Timestamps are read through the column decoder (never a raw aggregate:
  // the timestamp-without-tz columns mis-parse in the process timezone).
  const [counts, oldest] = await Promise.all([
    db
      .select({
        status: auditEffects.status,
        count: sql<number>`count(*)::int`,
      })
      .from(auditEffects)
      .where(
        and(
          eq(auditEffects.organizationId, organizationId),
          eq(auditEffects.repoFullName, normalizeRepo(repoFullName)),
          inArray(auditEffects.status, ["pending", "failed"]),
        ),
      )
      .groupBy(auditEffects.status),
    db
      .select({
        pendingSince: auditEffects.pendingSince,
        createdAt: auditEffects.createdAt,
      })
      .from(auditEffects)
      .where(where("pending"))
      .orderBy(
        asc(
          sql`coalesce(${auditEffects.pendingSince}, ${auditEffects.createdAt})`,
        ),
      )
      .limit(1),
  ]);
  const pending = counts.find((r) => r.status === "pending");
  const failed = counts.find((r) => r.status === "failed");
  const first = oldest[0];
  return {
    pending: pending?.count ?? 0,
    failed: failed?.count ?? 0,
    oldestPendingAt: first ? (first.pendingSince ?? first.createdAt) : null,
  };
}
