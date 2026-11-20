import { and, desc, eq, sql } from "drizzle-orm";

import type { DB } from "../db";
import { repoEgressAuditLog, type RepoEgressAuditAuthKind } from "../db/schema";
import type { EgressPolicyLevel, RepoEgressAuditLog } from "../db/types";
import { canonicalizeEgressEntries } from "./egress-policy";

/** One side of a repo egress change, as stored on repo_review_settings. */
export interface RepoEgressState {
  level: EgressPolicyLevel | null;
  allowlist: readonly string[] | null;
  registries: boolean | null;
}

/** Hosts in `after` and not in `before`, and the reverse; canonical, order-stable. */
export function diffEgressHosts(
  before: readonly string[] | null,
  after: readonly string[] | null,
): { added: string[]; removed: string[] } {
  const b = canonicalizeEgressEntries(before ?? []);
  const a = canonicalizeEgressEntries(after ?? []);
  const bSet = new Set(b);
  const aSet = new Set(a);
  return {
    added: a.filter((h) => !bSet.has(h)),
    removed: b.filter((h) => !aSet.has(h)),
  };
}

/**
 * Append one accepted repo egress change (#728, OD-3). Uses the CALLER's
 * db/tx (no own transaction) so the row commits, or rolls back, with the
 * settings change it describes. Returns the inserted row (its id is the
 * API's `auditId`). Append-only: this module exports no update or delete.
 */
export async function recordRepoEgressChange({
  db,
  organizationId,
  repoFullName,
  actorUserId,
  authKind,
  credentialId,
  before,
  after,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  actorUserId: string;
  authKind: RepoEgressAuditAuthKind;
  /** The apikey or session row id; never a token value. */
  credentialId: string | null;
  before: RepoEgressState;
  after: RepoEgressState;
}): Promise<RepoEgressAuditLog> {
  const { added, removed } = diffEgressHosts(before.allowlist, after.allowlist);
  const [row] = await db
    .insert(repoEgressAuditLog)
    .values({
      organizationId,
      repoFullName,
      actorUserId,
      authKind,
      credentialId,
      levelBefore: before.level,
      levelAfter: after.level,
      hostsAdded: added,
      hostsRemoved: removed,
      registriesBefore: before.registries,
      registriesAfter: after.registries,
    })
    .returning();
  if (!row) {
    throw new Error("recordRepoEgressChange: insert returned no row");
  }
  return row;
}

/** Keyset cursor: the `(createdAt, id)` of the last row of the previous page. */
export interface RepoEgressHistoryCursor {
  createdAt: Date;
  id: string;
}

export const REPO_EGRESS_HISTORY_MAX_LIMIT = 100;

/**
 * One org's history for one repo, newest first (`createdAt` then `id`, both
 * descending), fenced on the org: another org's rows for the same repo are
 * never returned. `before` continues after a previous page; `nextBefore` is
 * null on the last page. `limit` is clamped to 1..100.
 */
export async function listRepoEgressChanges({
  db,
  organizationId,
  repoFullName,
  limit = 50,
  before,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  limit?: number;
  before?: RepoEgressHistoryCursor;
}): Promise<{
  entries: RepoEgressAuditLog[];
  nextBefore: RepoEgressHistoryCursor | null;
}> {
  const pageSize = Math.min(
    Math.max(Math.trunc(limit), 1),
    REPO_EGRESS_HISTORY_MAX_LIMIT,
  );
  const rows = await db
    .select()
    .from(repoEgressAuditLog)
    .where(
      and(
        eq(repoEgressAuditLog.organizationId, organizationId),
        eq(repoEgressAuditLog.repoFullName, repoFullName),
        before
          ? // ISO (UTC) string cast to timestamp: the same form drizzle writes a Date column in.
            sql`(${repoEgressAuditLog.createdAt}, ${repoEgressAuditLog.id}) < (${before.createdAt.toISOString()}::timestamp, ${before.id})`
          : undefined,
      ),
    )
    .orderBy(desc(repoEgressAuditLog.createdAt), desc(repoEgressAuditLog.id))
    .limit(pageSize + 1);
  const entries = rows.slice(0, pageSize);
  const last = entries.at(-1);
  return {
    entries,
    nextBefore:
      rows.length > pageSize && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
  };
}
