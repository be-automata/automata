/**
 * ReviewAuditLog — append-only SQLite-backed log for the six `review.*`
 * lifecycle events.
 *
 * Implements Phase 3 §2 row 10 / §4.2 / §5.4.
 *
 * Schema invariants (FR-13):
 *   • UPDATE and DELETE on `review_audit_log` raise via SQLite triggers.
 *   • `payload_json` is the redacted payload (NFR-7) serialized as JSON.
 *
 * Runtime invariants (NFR-2):
 *   • `emit` returns synchronously and never throws.
 *   • Writes drain via `AuditWriterQueue` on a microtask queue independent
 *     of the caller.
 *   • `flush()` is bound to `process.beforeExit` by the composition root.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase } from '../shared/sqlite';
import { redactSecrets } from './redact-secrets';
import { createAuditWriterQueue } from './audit-writer-queue';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewAuditEventType =
  | 'review.started'
  | 'review.completed'
  | 'review.finding_lifecycle'
  | 'review.dismissed'
  | 'review.break_glass'
  | 'review.token_usage'
  // O1: work-blocked parity with review.break_glass — single audit log,
  // shared invariants (append-only, redacted payload, async drain).
  | 'work.blocked';

export interface ReviewAuditEvent {
  ts: string;
  type: ReviewAuditEventType;
  repo: string;
  prNumber: number | null;
  findingId?: string | null;
  actor?: string | null;
  auditId?: string | null;
  payload: Record<string, unknown>;
}

export interface ReviewAuditLog {
  /** Async fire-and-forget enqueue. Never throws to the caller (NFR-2). */
  emit(event: Omit<ReviewAuditEvent, 'ts'>): void;
  /** Resolve once pending writes have drained. */
  flush(): Promise<void>;
  list(
    filter?: { repo?: string; prNumber?: number; type?: ReviewAuditEventType },
    limit?: number,
  ): ReviewAuditEvent[];
  count(): number;
  close(): void;
}

export interface ReviewAuditLogDeps {
  /** Optional sink for internal write errors. */
  onWriteError?: (err: unknown, event: ReviewAuditEvent) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReviewAuditLog(
  dbPath: string,
  deps: ReviewAuditLogDeps = {},
): ReviewAuditLog {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = openDatabase(dbPath);

  // Schema v2 adds 'work.blocked' to the CHECK list. The migration is
  // additive: existing rows pass the new constraint. For fresh installs
  // the new schema is created up front; for installs created with the v1
  // schema we recreate the table preserving rows. SQLite cannot ALTER a
  // CHECK constraint in place; the table-rebuild dance below is the
  // standard idiom (see the SQLite docs on "Making Other Kinds Of Table
  // Schema Changes").
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_audit_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT    NOT NULL,
      type         TEXT    NOT NULL CHECK (type IN (
                      'review.started',
                      'review.completed',
                      'review.finding_lifecycle',
                      'review.dismissed',
                      'review.break_glass',
                      'review.token_usage',
                      'work.blocked'
                   )),
      repo         TEXT    NOT NULL,
      pr_number    INTEGER,
      finding_id   TEXT,
      actor        TEXT,
      audit_id     TEXT,
      payload_json TEXT    NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS review_audit_no_update
      BEFORE UPDATE ON review_audit_log
      BEGIN
        SELECT RAISE(ABORT, 'review_audit_log is append-only');
      END;
    CREATE TRIGGER IF NOT EXISTS review_audit_no_delete
      BEFORE DELETE ON review_audit_log
      BEGIN
        SELECT RAISE(ABORT, 'review_audit_log is append-only');
      END;

    CREATE INDEX IF NOT EXISTS idx_review_audit_pr
      ON review_audit_log (repo, pr_number, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_review_audit_type
      ON review_audit_log (type, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_review_audit_finding
      ON review_audit_log (repo, pr_number, finding_id);
  `);

  // Migrate v1 -> v2 if the existing table's CHECK list does not contain
  // 'work.blocked'. This is the rebuild-and-rename idiom from the SQLite
  // docs. The drop-trigger / recreate-trigger sequence is required
  // because SQLite triggers attach by name, not by table.
  migrateAuditSchemaIfNeeded(db);

  const insertStmt = db.prepare(`
    INSERT INTO review_audit_log (ts, type, repo, pr_number, finding_id, actor, audit_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const listAllStmt = db.prepare(`
    SELECT ts, type, repo, pr_number, finding_id, actor, audit_id, payload_json
    FROM review_audit_log
    ORDER BY id DESC
    LIMIT ?
  `);
  const listByRepoStmt = db.prepare(`
    SELECT ts, type, repo, pr_number, finding_id, actor, audit_id, payload_json
    FROM review_audit_log
    WHERE repo = ?
    ORDER BY id DESC
    LIMIT ?
  `);
  const listByPrStmt = db.prepare(`
    SELECT ts, type, repo, pr_number, finding_id, actor, audit_id, payload_json
    FROM review_audit_log
    WHERE repo = ? AND pr_number = ?
    ORDER BY id DESC
    LIMIT ?
  `);
  const listByTypeStmt = db.prepare(`
    SELECT ts, type, repo, pr_number, finding_id, actor, audit_id, payload_json
    FROM review_audit_log
    WHERE type = ?
    ORDER BY id DESC
    LIMIT ?
  `);
  const listByPrAndTypeStmt = db.prepare(`
    SELECT ts, type, repo, pr_number, finding_id, actor, audit_id, payload_json
    FROM review_audit_log
    WHERE repo = ? AND pr_number = ? AND type = ?
    ORDER BY id DESC
    LIMIT ?
  `);
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM review_audit_log');

  function rowToEvent(row: Record<string, unknown>): ReviewAuditEvent {
    return {
      ts: row.ts as string,
      type: row.type as ReviewAuditEventType,
      repo: row.repo as string,
      prNumber: (row.pr_number as number | null) ?? null,
      findingId: (row.finding_id as string | null) ?? null,
      actor: (row.actor as string | null) ?? null,
      auditId: (row.audit_id as string | null) ?? null,
      payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
    };
  }

  function writeRow(event: ReviewAuditEvent): void {
    insertStmt.run(
      event.ts,
      event.type,
      event.repo,
      event.prNumber,
      event.findingId ?? null,
      event.actor ?? null,
      event.auditId ?? null,
      JSON.stringify(event.payload),
    );
  }

  const queue = createAuditWriterQueue<ReviewAuditEvent>({
    write: writeRow,
    onError: (err, event) => {
      try {
        deps.onWriteError?.(err, event);
      } catch {
        // Reporter must not crash the drain.
      }
    },
  });

  let closed = false;

  return {
    emit(input) {
      if (closed) return;
      try {
        const event: ReviewAuditEvent = {
          ts: new Date().toISOString(),
          type: input.type,
          repo: input.repo,
          prNumber: input.prNumber,
          findingId: input.findingId ?? null,
          actor: input.actor ?? null,
          auditId: input.auditId ?? null,
          payload: redactSecrets(input.payload) as Record<string, unknown>,
        };
        queue.enqueue(event);
      } catch {
        // NFR-2: emit must never throw.
      }
    },
    async flush() {
      await queue.flush();
    },
    list(filter, limit = 200): ReviewAuditEvent[] {
      const lim = Math.max(1, Math.min(10_000, limit));
      let rows: Record<string, unknown>[];
      if (filter?.repo && filter?.prNumber !== undefined && filter?.type) {
        rows = listByPrAndTypeStmt.all(filter.repo, filter.prNumber, filter.type, lim) as Record<string, unknown>[];
      } else if (filter?.repo && filter?.prNumber !== undefined) {
        rows = listByPrStmt.all(filter.repo, filter.prNumber, lim) as Record<string, unknown>[];
      } else if (filter?.repo) {
        rows = listByRepoStmt.all(filter.repo, lim) as Record<string, unknown>[];
      } else if (filter?.type) {
        rows = listByTypeStmt.all(filter.type, lim) as Record<string, unknown>[];
      } else {
        rows = listAllStmt.all(lim) as Record<string, unknown>[];
      }
      return rows.map(rowToEvent);
    },
    count(): number {
      const row = countStmt.get() as { n: number };
      return row.n;
    },
    close(): void {
      if (closed) return;
      closed = true;
      // Best-effort: drain pending before close. Caller should `await flush()`
      // first if they care (the composition root binds flush to beforeExit).
      db.close();
    },
  };
}

/**
 * Schema-migration shim (O1): if the existing `review_audit_log` table's
 * CHECK constraint does not allow `'work.blocked'`, rebuild the table.
 * Idempotent — does nothing on fresh installs (the new schema is already
 * in place via the CREATE TABLE IF NOT EXISTS above).
 */
function migrateAuditSchemaIfNeeded(db: import('node:sqlite').DatabaseSync): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE type='table' AND name='review_audit_log'`)
    .get() as { sql?: string } | undefined;
  if (!row || typeof row.sql !== 'string') return;
  if (row.sql.includes("'work.blocked'")) return; // already migrated.

  db.exec(`
    BEGIN;
    DROP TRIGGER IF EXISTS review_audit_no_update;
    DROP TRIGGER IF EXISTS review_audit_no_delete;
    ALTER TABLE review_audit_log RENAME TO review_audit_log_v1;
    CREATE TABLE review_audit_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT    NOT NULL,
      type         TEXT    NOT NULL CHECK (type IN (
                      'review.started',
                      'review.completed',
                      'review.finding_lifecycle',
                      'review.dismissed',
                      'review.break_glass',
                      'review.token_usage',
                      'work.blocked'
                   )),
      repo         TEXT    NOT NULL,
      pr_number    INTEGER,
      finding_id   TEXT,
      actor        TEXT,
      audit_id     TEXT,
      payload_json TEXT    NOT NULL
    );
    INSERT INTO review_audit_log
      (id, ts, type, repo, pr_number, finding_id, actor, audit_id, payload_json)
    SELECT id, ts, type, repo, pr_number, finding_id, actor, audit_id, payload_json
    FROM review_audit_log_v1;
    DROP TABLE review_audit_log_v1;
    CREATE TRIGGER review_audit_no_update
      BEFORE UPDATE ON review_audit_log
      BEGIN
        SELECT RAISE(ABORT, 'review_audit_log is append-only');
      END;
    CREATE TRIGGER review_audit_no_delete
      BEFORE DELETE ON review_audit_log
      BEGIN
        SELECT RAISE(ABORT, 'review_audit_log is append-only');
      END;
    CREATE INDEX IF NOT EXISTS idx_review_audit_pr
      ON review_audit_log (repo, pr_number, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_review_audit_type
      ON review_audit_log (type, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_review_audit_finding
      ON review_audit_log (repo, pr_number, finding_id);
    COMMIT;
  `);
}
