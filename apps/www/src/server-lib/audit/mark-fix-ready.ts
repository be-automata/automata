import { and, eq, isNotNull, or, sql } from "drizzle-orm";

import type { DB } from "@terragon/shared/db";
import { auditFindings } from "@terragon/shared/db/schema";
import { normalizeRepo } from "@terragon/shared/model/repo-review-settings";
import { withSelfHealTx } from "@terragon/shared/model/self-heal-tx";

/**
 * SC2 / BULK-01: the issue trigger for the fix loop only MARKS a ledger
 * finding ready; the dispatcher starts runs. Authority is ledger membership
 * plus the bot author from the signed webhook payload — labels are only a
 * filter, so an attacker labelling an issue on a public repo reaches nothing.
 * DB-only by design (WH-01/RES-21): no GitHub call inside the webhook budget.
 */
export type FixReadyOutcome =
  | "marked"
  | "already_ready"
  | "not_a_ledger_issue"
  | "author_not_bot"
  | "not_script_rule"
  | "status_not_open";

export interface FixReadyResult {
  outcome: FixReadyOutcome;
  /** The finding's fingerprint, null when the issue is not in the ledger. */
  fingerprint: string | null;
}

export interface MarkFindingFixReadyInput {
  db: DB;
  organizationId: string;
  repoFullName: string;
  issueNumber: number;
  issueAuthorLogin: string | null | undefined;
  botLogin: string;
  now: Date;
}

export async function markFindingFixReady({
  db,
  organizationId,
  repoFullName,
  issueNumber,
  issueAuthorLogin,
  botLogin,
  now,
}: MarkFindingFixReadyInput): Promise<FixReadyResult> {
  const repo = normalizeRepo(repoFullName);
  const ledgerRow = and(
    eq(auditFindings.organizationId, organizationId),
    eq(auditFindings.repoFullName, repo),
    eq(auditFindings.issueNumber, issueNumber),
  );
  const author = (issueAuthorLogin ?? "").trim().toLowerCase();
  if (!author || author !== botLogin.trim().toLowerCase()) {
    // Decided by the payload: read the fingerprint without the row lock.
    const rows = await withSelfHealTx(db, (tx) =>
      tx
        .select({ fingerprint: auditFindings.fingerprint })
        .from(auditFindings)
        .where(ledgerRow)
        .limit(1),
    );
    const row = rows[0];
    return row
      ? { outcome: "author_not_bot", fingerprint: row.fingerprint }
      : { outcome: "not_a_ledger_issue", fingerprint: null };
  }
  return withSelfHealTx(db, async (tx) => {
    const rows = await tx
      .select({
        id: auditFindings.id,
        fingerprint: auditFindings.fingerprint,
        status: auditFindings.status,
        checkKind: auditFindings.checkKind,
        fixReadyAt: auditFindings.fixReadyAt,
      })
      .from(auditFindings)
      .where(ledgerRow)
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) {
      return { outcome: "not_a_ledger_issue", fingerprint: null };
    }
    const fingerprint = row.fingerprint;
    if (row.checkKind !== "script") {
      return { outcome: "not_script_rule", fingerprint };
    }
    if (row.status !== "open") {
      return { outcome: "status_not_open", fingerprint };
    }
    await tx
      .update(auditFindings)
      .set({
        autoFixLabeled: true,
        fixReadyAt: sql`COALESCE(${auditFindings.fixReadyAt}, ${sql.param(now, auditFindings.fixReadyAt)})`,
      })
      .where(
        and(
          eq(auditFindings.id, row.id),
          eq(auditFindings.organizationId, organizationId),
          eq(auditFindings.status, "open"),
          eq(auditFindings.checkKind, "script"),
        ),
      );
    return {
      outcome: row.fixReadyAt ? "already_ready" : "marked",
      fingerprint,
    };
  });
}

export type FixUnreadyOutcome = "cleared" | "not_ready" | "not_a_ledger_issue";

export interface FixUnreadyResult {
  outcome: FixUnreadyOutcome;
  fingerprint: string | null;
}

/**
 * R7: the inverse of markFindingFixReady. The issue was closed, or the
 * trigger label was removed, so the dispatcher must not start a fix for it:
 * clear `fix_ready_at` and `auto_fix_labeled`. DB-only (no GitHub call inside
 * the webhook budget) and always safe to apply, so no author check: it only
 * narrows what the loop may do. An attempt already in flight is untouched.
 */
export async function clearFindingFixReady({
  db,
  organizationId,
  repoFullName,
  issueNumber,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  issueNumber: number;
}): Promise<FixUnreadyResult> {
  const ledgerRow = and(
    eq(auditFindings.organizationId, organizationId),
    eq(auditFindings.repoFullName, normalizeRepo(repoFullName)),
    eq(auditFindings.issueNumber, issueNumber),
  );
  return withSelfHealTx(db, async (tx) => {
    const cleared = await tx
      .update(auditFindings)
      .set({ autoFixLabeled: false, fixReadyAt: null })
      .where(
        and(
          ledgerRow,
          or(
            isNotNull(auditFindings.fixReadyAt),
            eq(auditFindings.autoFixLabeled, true),
          ),
        ),
      )
      .returning({ fingerprint: auditFindings.fingerprint });
    const row = cleared[0];
    if (row) return { outcome: "cleared", fingerprint: row.fingerprint };
    const existing = await tx
      .select({ fingerprint: auditFindings.fingerprint })
      .from(auditFindings)
      .where(ledgerRow)
      .limit(1);
    const found = existing[0];
    return found
      ? { outcome: "not_ready", fingerprint: found.fingerprint }
      : { outcome: "not_a_ledger_issue", fingerprint: null };
  });
}
