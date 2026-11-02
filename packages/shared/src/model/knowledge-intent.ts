import { and, eq, lte, sql, type SQL } from "drizzle-orm";

import {
  RECONCILE_ALL_ERROR_CODES,
  type ReconcileErrorCode,
} from "@terragon/knowledge/reconcile-wire";

import { rowsOf, type DB } from "../db";
import { knowledgeIntent } from "../db/schema";

/**
 * Knowledge intent lifecycle. SYSTEM path, org-agnostic: called only by the
 * reconcile sweep (apps/www/src/server-lib/knowledge/reconcile-sweep.ts) and
 * the internal fail route (enforced by the static guard in
 * knowledge-access.static.test.ts). Never logs; callers log ids and counts.
 *
 * Claim semantics (D-12, D-13): one reconcile per (org, repo). The newest
 * pending intent of a repo is the target, older pending ones become
 * superseded. Off and offboarded orgs are never claimed and spend no
 * attempts. While `processing`, `next_attempt_at` is the lease deadline.
 */

/** PD-2: how long a claimed intent may stay `processing` before it is requeued. */
export const KNOWLEDGE_INTENT_LEASE_MS = 20 * 60_000;
/** D-14: attempts before an intent is `failed`. */
export const KNOWLEDGE_INTENT_MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;
/** Rows superseded per tick for repos that were not claimed (Step 3). */
const SUPERSEDE_SWEEP_LIMIT = 500;

/** 1m, 2m, 4m ... capped at 30m, with +/-25% jitter from the injected rng. */
export function knowledgeIntentBackoffMs(
  attempt: number,
  rng: () => number = Math.random,
): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
  return Math.round(base * (0.75 + rng() * 0.5));
}

/**
 * A JS Date as a `timestamp without time zone` bound parameter. Raw SQL does
 * not go through drizzle's column mapping, and the pg driver would serialise a
 * bare Date in the process-local zone. The ISO string is read as UTC.
 */
function ts(d: Date): SQL {
  return sql`${d.toISOString()}::timestamp`;
}

export interface ClaimedKnowledgeIntent {
  id: string;
  organizationId: string;
  repoFullName: string;
  targetSha: string;
}

interface Candidate {
  id: string;
  organization_id: string;
  repo_full_name: string;
  target_sha: string;
}

/**
 * Move due pending intents of engine-On, not-offboarded orgs to `processing`.
 * One transaction. The newest pending intent per (org, repo) is chosen in SQL
 * before the global limit applies, so a repo with any backlog is claimed at
 * its true newest row and the limit counts repos, not rows.
 */
export async function claimDueKnowledgeIntents({
  db,
  now,
  limit = 10,
  leaseMs = KNOWLEDGE_INTENT_LEASE_MS,
}: {
  db: DB;
  now: Date;
  limit?: number;
  leaseMs?: number;
}): Promise<ClaimedKnowledgeIntent[]> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const leaseUntil = new Date(now.getTime() + leaseMs);

    // Step 1: candidates. No row lock here: Postgres refuses FOR UPDATE with
    // DISTINCT ON. The locks are taken per candidate in step 2.
    const candidates = rowsOf<Candidate>(
      await tx.execute(sql`
        WITH newest AS (
          SELECT DISTINCT ON (i.organization_id, i.repo_full_name)
            i.id, i.organization_id, i.repo_full_name, i.target_sha,
            i.created_at, i.next_attempt_at
          FROM knowledge_intent i
          JOIN organization_review_settings s
            ON s.organization_id = i.organization_id
           AND s.knowledge_engine IS TRUE
           AND s.knowledge_offboarded_at IS NULL
          WHERE i.state = 'pending'
          ORDER BY i.organization_id, i.repo_full_name,
                   i.created_at DESC, i.id DESC
        )
        SELECT n.id, n.organization_id, n.repo_full_name, n.target_sha
        FROM newest n
        WHERE n.next_attempt_at <= ${ts(now)}
          AND NOT EXISTS (
            SELECT 1 FROM knowledge_intent p
            WHERE p.organization_id = n.organization_id
              AND p.repo_full_name = n.repo_full_name
              AND p.state = 'processing'
          )
        ORDER BY n.created_at ASC, n.id ASC
        LIMIT ${limit}
      `),
    );

    const claimed: ClaimedKnowledgeIntent[] = [];
    for (const c of candidates) {
      // Step 2a: take the row, or skip it if another claimer holds it.
      const locked = rowsOf<{ id: string }>(
        await tx.execute(sql`
          SELECT id FROM knowledge_intent
          WHERE id = ${c.id} AND state = 'pending'
          FOR UPDATE SKIP LOCKED
        `),
      );
      if (locked.length === 0) continue;

      // Step 2b: one claimer per repo.
      const lock = rowsOf<{ ok: boolean }>(
        await tx.execute(sql`
          SELECT pg_try_advisory_xact_lock(
            hashtext(${c.organization_id} || ':' || ${c.repo_full_name})
          ) AS ok
        `),
      );
      if (lock[0]?.ok !== true) continue;

      // Step 2c: re-check in a fresh statement (READ COMMITTED), so a claim or
      // a newer push committed after step 1 is visible.
      const check = rowsOf<{ has_processing: boolean; has_newer: boolean }>(
        await tx.execute(sql`
          SELECT
            EXISTS (
              SELECT 1 FROM knowledge_intent p
              WHERE p.organization_id = ${c.organization_id}
                AND p.repo_full_name = ${c.repo_full_name}
                AND p.state = 'processing'
            ) AS has_processing,
            EXISTS (
              SELECT 1 FROM knowledge_intent p, knowledge_intent me
              WHERE me.id = ${c.id}
                AND p.organization_id = me.organization_id
                AND p.repo_full_name = me.repo_full_name
                AND p.state = 'pending'
                AND (p.created_at, p.id) > (me.created_at, me.id)
            ) AS has_newer
        `),
      );
      if (check[0]?.has_processing !== false) continue;
      if (check[0]?.has_newer !== false) continue;

      // Step 2d: claim, and supersede every older pending row of the pair.
      await tx.execute(sql`
        UPDATE knowledge_intent
        SET state = 'processing',
            next_attempt_at = ${ts(leaseUntil)},
            updated_at = ${ts(now)}
        WHERE id = ${c.id}
      `);
      await tx.execute(sql`
        UPDATE knowledge_intent
        SET state = 'superseded',
            processed_at = ${ts(now)},
            updated_at = ${ts(now)}
        WHERE id IN (
          SELECT o.id FROM knowledge_intent o, knowledge_intent me
          WHERE me.id = ${c.id}
            AND o.organization_id = me.organization_id
            AND o.repo_full_name = me.repo_full_name
            AND o.state = 'pending'
            AND (o.created_at, o.id) < (me.created_at, me.id)
          FOR UPDATE OF o SKIP LOCKED
        )
      `);
      claimed.push({
        id: c.id,
        organizationId: c.organization_id,
        repoFullName: c.repo_full_name,
        targetSha: c.target_sha,
      });
    }

    // Step 3: bounded supersede for repos not claimed this tick. Only orgs
    // the engine is On for: nothing is touched while Off or offboarded.
    await tx.execute(sql`
      UPDATE knowledge_intent
      SET state = 'superseded',
          processed_at = ${ts(now)},
          updated_at = ${ts(now)}
      WHERE id IN (
        SELECT o.id
        FROM knowledge_intent o
        JOIN organization_review_settings s
          ON s.organization_id = o.organization_id
         AND s.knowledge_engine IS TRUE
         AND s.knowledge_offboarded_at IS NULL
        WHERE o.state = 'pending'
          AND EXISTS (
            SELECT 1 FROM knowledge_intent n
            WHERE n.organization_id = o.organization_id
              AND n.repo_full_name = o.repo_full_name
              AND n.state IN ('pending', 'processing')
              AND (n.created_at, n.id) > (o.created_at, o.id)
          )
        LIMIT ${SUPERSEDE_SWEEP_LIMIT}
        FOR UPDATE OF o SKIP LOCKED
      )
    `);

    return claimed;
  });
}

export interface RequeuedKnowledgeIntent {
  id: string;
  organizationId: string;
  repoFullName: string;
  attempts: number;
  code: ReconcileErrorCode;
  state: "pending" | "failed";
  /** True only for the row this call flipped to failed (PD-3: alert once). */
  becameFailed: boolean;
}

/**
 * PD-2: return every expired lease to pending (attempts + 1, code
 * lease_expired), or to failed (code max_attempts) at the attempt cap.
 * Org gating does not apply: the claim skips an Off org's pending row.
 */
export async function requeueExpiredKnowledgeIntents({
  db,
  now,
  rng = Math.random,
  limit = 50,
}: {
  db: DB;
  now: Date;
  rng?: () => number;
  limit?: number;
}): Promise<RequeuedKnowledgeIntent[]> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const expired = await tx
      .select()
      .from(knowledgeIntent)
      .where(
        and(
          eq(knowledgeIntent.state, "processing"),
          lte(knowledgeIntent.nextAttemptAt, now),
        ),
      )
      .limit(limit)
      .for("update", { skipLocked: true });
    const out: RequeuedKnowledgeIntent[] = [];
    for (const r of expired) {
      const attempts = r.attempts + 1;
      const exhausted = attempts >= KNOWLEDGE_INTENT_MAX_ATTEMPTS;
      const code: ReconcileErrorCode = exhausted
        ? "max_attempts"
        : "lease_expired";
      await tx
        .update(knowledgeIntent)
        .set(
          exhausted
            ? {
                state: "failed",
                attempts,
                lastErrorCode: code,
                processedAt: now,
                updatedAt: now,
              }
            : {
                state: "pending",
                attempts,
                lastErrorCode: code,
                nextAttemptAt: new Date(
                  now.getTime() + knowledgeIntentBackoffMs(attempts, rng),
                ),
                updatedAt: now,
              },
        )
        .where(eq(knowledgeIntent.id, r.id));
      out.push({
        id: r.id,
        organizationId: r.organizationId,
        repoFullName: r.repoFullName,
        attempts,
        code,
        state: exhausted ? "failed" : "pending",
        becameFailed: exhausted,
      });
    }
    return out;
  });
}

/** Give a claimed intent back untouched (for example a dispatch skipped by a cap). */
export async function releaseKnowledgeIntent({
  db,
  intentId,
  now,
}: {
  db: DB;
  intentId: string;
  now: Date;
}): Promise<{ result: "released" | "not_processing" }> {
  const rows = await db
    .update(knowledgeIntent)
    .set({ state: "pending", nextAttemptAt: now, updatedAt: now })
    .where(
      and(
        eq(knowledgeIntent.id, intentId),
        eq(knowledgeIntent.state, "processing"),
      ),
    )
    .returning({ id: knowledgeIntent.id });
  return { result: rows.length > 0 ? "released" : "not_processing" };
}

export type FailKnowledgeIntentResult =
  | {
      result: "recorded";
      state: "pending" | "failed";
      attempts: number;
      code: ReconcileErrorCode;
      /** True only for the row this call flipped to failed (PD-3). */
      becameFailed: boolean;
      organizationId: string;
      repoFullName: string;
    }
  | { result: "not_processing" };

function isReconcileErrorCode(value: unknown): value is ReconcileErrorCode {
  return (
    typeof value === "string" &&
    (RECONCILE_ALL_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** Record a failed attempt of a processing intent: backoff, or failed at the cap. */
export async function failKnowledgeIntent({
  db,
  intentId,
  code,
  now,
  rng = Math.random,
}: {
  db: DB;
  intentId: string;
  code: ReconcileErrorCode;
  now: Date;
  rng?: () => number;
}): Promise<FailKnowledgeIntentResult> {
  // Closed enum, checked before any write; the value is never echoed.
  if (!isReconcileErrorCode(code)) {
    throw new Error("code is not a reconcile error code");
  }
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [r] = await tx
      .select()
      .from(knowledgeIntent)
      .where(eq(knowledgeIntent.id, intentId))
      .for("update");
    if (!r || r.state !== "processing") return { result: "not_processing" };
    const attempts = r.attempts + 1;
    const exhausted = attempts >= KNOWLEDGE_INTENT_MAX_ATTEMPTS;
    await tx
      .update(knowledgeIntent)
      .set(
        exhausted
          ? {
              state: "failed",
              attempts,
              lastErrorCode: code,
              processedAt: now,
              updatedAt: now,
            }
          : {
              state: "pending",
              attempts,
              lastErrorCode: code,
              nextAttemptAt: new Date(
                now.getTime() + knowledgeIntentBackoffMs(attempts, rng),
              ),
              updatedAt: now,
            },
      )
      .where(eq(knowledgeIntent.id, intentId));
    return {
      result: "recorded",
      state: exhausted ? "failed" : "pending",
      attempts,
      code,
      becameFailed: exhausted,
      organizationId: r.organizationId,
      repoFullName: r.repoFullName,
    };
  });
}
