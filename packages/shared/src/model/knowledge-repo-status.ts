import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";

import type { DB } from "../db";
import {
  automations,
  knowledgeClaim,
  knowledgeCursor,
  knowledgeIntent,
  repoReviewSettings,
  type KnowledgeIntentState,
} from "../db/schema";
import { recordKnowledgeAdminAction } from "./knowledge-admin-log";
import { assertIntentFields } from "./knowledge-minimize";
import { insertKnowledgeIntent } from "./knowledge-store";

/**
 * Record a default-branch push: the reconcile intent, the observed head and
 * the push liveness stamp (`last_push_at`) in ONE transaction. A redelivery
 * inserts no second intent but still bumps `last_push_at`. The cursor row is
 * created with `last_sha` NULL when absent (never advanced here).
 */
export async function recordKnowledgePush({
  db,
  organizationId,
  repoFullName,
  defaultBranch,
  targetSha,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  defaultBranch: string;
  targetSha: string;
  now?: Date;
}): Promise<{ intentId: string; inserted: boolean }> {
  const fields = assertIntentFields({ repoFullName, defaultBranch, targetSha });
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const { id, inserted } = await insertKnowledgeIntent({
      db: tx,
      organizationId,
      ...fields,
    });
    await tx
      .insert(knowledgeCursor)
      .values({
        organizationId,
        repoFullName: fields.repoFullName,
        defaultBranch: fields.defaultBranch,
        observedHeadSha: fields.targetSha,
        lastPushAt: now,
      })
      .onConflictDoUpdate({
        target: [knowledgeCursor.organizationId, knowledgeCursor.repoFullName],
        set: {
          observedHeadSha: fields.targetSha,
          defaultBranch: fields.defaultBranch,
          lastPushAt: now,
        },
      });
    return { intentId: id, inserted };
  });
}

/**
 * D-19: a repo is pending validation while a newer head was observed than the
 * one reconciled, or while an intent is open (pending or processing). A claim
 * is pending iff its repo is pending (Phase 16 may narrow by pinned paths).
 * Derived, never stored. Reused by the Phase 14 claims list and the Phase 16
 * serve gate.
 */
export function isKnowledgeRepoPendingValidation({
  lastSha,
  observedHeadSha,
  hasOpenIntent,
}: {
  lastSha: string | null;
  observedHeadSha: string | null;
  hasOpenIntent: boolean;
}): boolean {
  if (hasOpenIntent) return true;
  return observedHeadSha !== null && observedHeadSha !== lastSha;
}

export interface KnowledgeRepoStatusRow {
  repoFullName: string;
  defaultBranch: string | null;
  lastSha: string | null;
  observedHeadSha: string | null;
  /** Null = this repo has never seen a push. */
  lastPushAt: Date | null;
  latestIntent: {
    id: string;
    state: KnowledgeIntentState;
    attempts: number;
    lastErrorCode: string | null;
    targetSha: string;
    createdAt: Date;
    processedAt: Date | null;
  } | null;
  pending: boolean;
  pendingSince: Date | null;
  affectedClaimCount: number;
}

/**
 * Per-repo liveness and pending-validation status (D-17, D-19). Onboarded
 * repos (PD-13) are the union of the org's cursors, repo review settings
 * (minus the `*` sentinel) and automations, lowercased and deduped. Every
 * query is fenced on `organization_id`.
 */
export async function listKnowledgeRepoStatus({
  db,
  organizationId,
  limit = 200,
}: {
  db: DB;
  organizationId: string;
  limit?: number;
}): Promise<KnowledgeRepoStatusRow[]> {
  const [cursorNames, settingNames, automationNames] = await Promise.all([
    db
      .select({ name: knowledgeCursor.repoFullName })
      .from(knowledgeCursor)
      .where(eq(knowledgeCursor.organizationId, organizationId)),
    db
      .select({ name: repoReviewSettings.repoFullName })
      .from(repoReviewSettings)
      .where(
        and(
          eq(repoReviewSettings.organizationId, organizationId),
          ne(repoReviewSettings.repoFullName, "*"),
        ),
      ),
    db
      .select({ name: automations.repoFullName })
      .from(automations)
      .where(eq(automations.organizationId, organizationId)),
  ]);
  const repos = [
    ...new Set(
      [...cursorNames, ...settingNames, ...automationNames].map((r) =>
        r.name.toLowerCase(),
      ),
    ),
  ]
    .sort()
    .slice(0, limit);
  if (repos.length === 0) return [];

  const [cursors, latest, open, claims] = await Promise.all([
    db
      .select()
      .from(knowledgeCursor)
      .where(
        and(
          eq(knowledgeCursor.organizationId, organizationId),
          inArray(sql`lower(${knowledgeCursor.repoFullName})`, repos),
        ),
      ),
    db
      .selectDistinctOn([knowledgeIntent.repoFullName])
      .from(knowledgeIntent)
      .where(
        and(
          eq(knowledgeIntent.organizationId, organizationId),
          inArray(knowledgeIntent.repoFullName, repos),
        ),
      )
      .orderBy(
        asc(knowledgeIntent.repoFullName),
        sql`${knowledgeIntent.createdAt} DESC`,
        sql`${knowledgeIntent.id} DESC`,
      ),
    db
      .select({
        repo: knowledgeIntent.repoFullName,
        since: sql<Date>`min(${knowledgeIntent.createdAt})`.mapWith(
          knowledgeIntent.createdAt,
        ),
      })
      .from(knowledgeIntent)
      .where(
        and(
          eq(knowledgeIntent.organizationId, organizationId),
          inArray(knowledgeIntent.repoFullName, repos),
          inArray(knowledgeIntent.state, ["pending", "processing"]),
        ),
      )
      .groupBy(knowledgeIntent.repoFullName),
    db
      .select({
        repo: knowledgeClaim.repoFullName,
        count: sql<number>`count(*)::int`,
      })
      .from(knowledgeClaim)
      .where(
        and(
          eq(knowledgeClaim.organizationId, organizationId),
          inArray(knowledgeClaim.repoFullName, repos),
        ),
      )
      .groupBy(knowledgeClaim.repoFullName),
  ]);

  const cursorBy = new Map(
    cursors.map((c) => [c.repoFullName.toLowerCase(), c]),
  );
  const latestBy = new Map(latest.map((i) => [i.repoFullName, i]));
  const openBy = new Map(open.map((o) => [o.repo, o.since]));
  const claimBy = new Map(claims.map((c) => [c.repo, c.count]));

  return repos.map((repo) => {
    const cursor = cursorBy.get(repo);
    const intent = latestBy.get(repo);
    const openSince = openBy.get(repo) ?? null;
    const pending = isKnowledgeRepoPendingValidation({
      lastSha: cursor?.lastSha ?? null,
      observedHeadSha: cursor?.observedHeadSha ?? null,
      hasOpenIntent: openSince !== null,
    });
    return {
      repoFullName: repo,
      defaultBranch: cursor?.defaultBranch ?? null,
      lastSha: cursor?.lastSha ?? null,
      observedHeadSha: cursor?.observedHeadSha ?? null,
      lastPushAt: cursor?.lastPushAt ?? null,
      latestIntent: intent
        ? {
            id: intent.id,
            state: intent.state,
            attempts: intent.attempts,
            lastErrorCode: intent.lastErrorCode,
            targetSha: intent.targetSha,
            createdAt: intent.createdAt,
            processedAt: intent.processedAt,
          }
        : null,
      pending,
      pendingSince: pending ? (openSince ?? intent?.createdAt ?? null) : null,
      affectedClaimCount: pending ? (claimBy.get(repo) ?? 0) : 0,
    };
  });
}

/**
 * Admin Retry (D-16): a failed intent goes back to pending with attempts and
 * backoff reset, and the action is logged in the same transaction. A
 * non-failed or foreign intent writes nothing.
 */
export async function retryKnowledgeIntent({
  db,
  organizationId,
  intentId,
  actorUserId,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  intentId: string;
  actorUserId: string;
  now?: Date;
}): Promise<{ result: "retried" | "not_found" }> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [before] = await tx
      .select({
        targetSha: knowledgeIntent.targetSha,
        attempts: knowledgeIntent.attempts,
      })
      .from(knowledgeIntent)
      .where(
        and(
          eq(knowledgeIntent.id, intentId),
          eq(knowledgeIntent.organizationId, organizationId),
          eq(knowledgeIntent.state, "failed"),
        ),
      )
      .for("update");
    if (!before) return { result: "not_found" as const };
    const rows = await tx
      .update(knowledgeIntent)
      .set({
        state: "pending",
        attempts: 0,
        nextAttemptAt: now,
        lastErrorCode: null,
      })
      .where(
        and(
          eq(knowledgeIntent.id, intentId),
          eq(knowledgeIntent.organizationId, organizationId),
          eq(knowledgeIntent.state, "failed"),
        ),
      )
      .returning({ id: knowledgeIntent.id });
    if (rows.length === 0) return { result: "not_found" as const };
    await recordKnowledgeAdminAction({
      db: tx,
      organizationId,
      actorUserId,
      action: "intent_retry",
      // The intent id (org:repo@sha) is not a log-safe token; the sha and
      // the attempts reset are, and with the actor and org they identify it.
      target: { targetSha: before.targetSha, attemptsWas: before.attempts },
    });
    return { result: "retried" as const };
  });
}
