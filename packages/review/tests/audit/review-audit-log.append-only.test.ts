/**
 * Append-only enforcement test for review_audit_log.
 *
 * Covers FR-13, AC-10.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewAuditLog, type ReviewAuditLog } from '../../src/audit/review-audit-log';
import { openDatabase } from '../../src/shared/sqlite';

describe('review_audit_log append-only triggers', () => {
  let tmp: string;
  let dbPath: string;
  let log: ReviewAuditLog;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'review-audit-append-only-'));
    dbPath = join(tmp, 'review-audit.db');
    log = createReviewAuditLog(dbPath);
  });

  afterEach(async () => {
    await log.flush();
    log.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('AC-10: rejects UPDATE attempts and leaves the row unchanged', async () => {
    log.emit({ type: 'review.started', repo: 'a/b', prNumber: 1, payload: { keep: true } });
    await log.flush();
    log.close();

    const db = openDatabase(dbPath);
    try {
      assert.throws(
        () => db.exec("UPDATE review_audit_log SET type = 'review.completed' WHERE id = 1"),
        /append-only/i,
      );
      const row = db.prepare('SELECT type FROM review_audit_log WHERE id = 1').get() as { type: string };
      assert.equal(row.type, 'review.started');
    } finally {
      db.close();
    }
    log = createReviewAuditLog(dbPath);
  });

  it('AC-10: rejects DELETE attempts and leaves the row unchanged', async () => {
    log.emit({ type: 'review.started', repo: 'a/b', prNumber: 1, payload: {} });
    await log.flush();
    log.close();

    const db = openDatabase(dbPath);
    try {
      assert.throws(
        () => db.exec('DELETE FROM review_audit_log WHERE id = 1'),
        /append-only/i,
      );
      const row = db.prepare('SELECT COUNT(*) AS n FROM review_audit_log').get() as { n: number };
      assert.equal(row.n, 1);
    } finally {
      db.close();
    }
    log = createReviewAuditLog(dbPath);
  });
});
