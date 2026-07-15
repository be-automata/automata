/**
 * repo-review-settings-audit — append-only audit log for tolerance mutations.
 *
 * Each set/delete writes exactly one row carrying the acting token id, the
 * before/after values, a lowercased repo slug, and a timestamp. The log is
 * append-only: two records produce two rows (never an in-place update).
 *
 * The audit interface itself exposes only `record`/`close`, so these tests read
 * the rows back directly from the same SQLite file (the store and audit share
 * one db per the module contract). node:test + node:assert/strict only.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createRepoReviewSettingsAudit } from '../../src/settings/repo-review-settings-audit';
import type { RepoReviewSettingsAudit } from '../../src/settings/types';

interface AuditRow {
  id: number;
  token_id: string | null;
  repo: string;
  action: string;
  before_value: string | null;
  after_value: string | null;
  at: string;
}

describe('repo-review-settings-audit', () => {
  let tmp: string;
  let dbPath: string;
  let audit: RepoReviewSettingsAudit;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'repo-review-audit-'));
    dbPath = join(tmp, 'repo-settings.db');
    audit = createRepoReviewSettingsAudit(dbPath);
  });

  afterEach(() => {
    audit.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Read all audit rows directly (audit exposes no reader of its own). */
  function readRows(): AuditRow[] {
    const db = new DatabaseSync(dbPath);
    try {
      return db
        .prepare('SELECT * FROM repo_review_settings_audit ORDER BY id')
        .all() as unknown as AuditRow[];
    } finally {
      db.close();
    }
  }

  test('a set writes one row with tokenId, before/after values and a timestamp', () => {
    audit.record({
      tokenId: 'tok-123',
      repo: 'owner/repo',
      action: 'set',
      beforeValue: null,
      afterValue: 'error',
    });

    const rows = readRows();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.token_id, 'tok-123');
    assert.equal(row.repo, 'owner/repo');
    assert.equal(row.action, 'set');
    assert.equal(row.before_value, null);
    assert.equal(row.after_value, 'error');
    assert.ok(row.at, 'a timestamp is written');
    assert.ok(!Number.isNaN(Date.parse(row.at)), 'timestamp is ISO-parseable');
  });

  test('a delete writes a row with the prior value in before_value and null after_value', () => {
    audit.record({
      tokenId: 'tok-9',
      repo: 'owner/repo',
      action: 'delete',
      beforeValue: 'warning',
      afterValue: null,
    });

    const rows = readRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'delete');
    assert.equal(rows[0].before_value, 'warning');
    assert.equal(rows[0].after_value, null);
  });

  test('repo slug is lowercased before storage', () => {
    audit.record({
      tokenId: 'tok-1',
      repo: 'Owner/Repo',
      action: 'set',
      beforeValue: null,
      afterValue: 'info',
    });
    assert.equal(readRows()[0].repo, 'owner/repo');
  });

  test('a null tokenId (unauthenticated / missing) is stored as NULL', () => {
    audit.record({
      tokenId: null,
      repo: 'owner/repo',
      action: 'set',
      beforeValue: null,
      afterValue: 'info',
    });
    assert.equal(readRows()[0].token_id, null);
  });

  test('append-only: two records produce two distinct rows (never an update)', () => {
    audit.record({
      tokenId: 'tok-1',
      repo: 'owner/repo',
      action: 'set',
      beforeValue: null,
      afterValue: 'warning',
    });
    audit.record({
      tokenId: 'tok-2',
      repo: 'owner/repo',
      action: 'set',
      beforeValue: 'warning',
      afterValue: 'error',
    });

    const rows = readRows();
    assert.equal(rows.length, 2, 'two mutations → two rows');
    // Monotonic autoincrement ids, distinct.
    assert.ok(rows[1].id > rows[0].id);
    assert.equal(rows[0].after_value, 'warning');
    assert.equal(rows[1].before_value, 'warning');
    assert.equal(rows[1].after_value, 'error');
  });
});
