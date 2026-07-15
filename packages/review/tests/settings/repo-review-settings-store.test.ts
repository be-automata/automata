/**
 * repo-review-settings-store — per-repo REQUESTED_CHANGES tolerance persistence.
 *
 * CRUD over the node:sqlite store, lowercased-slug normalization (a
 * case-mismatched override must never silently stop matching), upsert
 * updated_at movement, list ordering, cross-reopen durability, and the SQLite
 * CHECK constraint that rejects an out-of-vocabulary tolerance at the storage
 * layer. node:test + node:assert/strict only — no Jest/Vitest.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRepoReviewSettingsStore } from '../../src/settings/repo-review-settings-store';
import type { BlockTolerance, RepoReviewSettingsStore } from '../../src/settings/types';

describe('repo-review-settings-store', () => {
  let tmp: string;
  let dbPath: string;
  let store: RepoReviewSettingsStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'repo-review-store-'));
    dbPath = join(tmp, 'nested', 'repo-settings.db');
    store = createRepoReviewSettingsStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('set then get returns the stored row (CRUD happy path)', () => {
    const saved = store.set('owner/repo', 'error');
    assert.equal(saved.repo, 'owner/repo');
    assert.equal(saved.blockTolerance, 'error');
    assert.ok(saved.createdAt);
    assert.ok(saved.updatedAt);

    const got = store.get('owner/repo');
    assert.ok(got);
    assert.equal(got!.blockTolerance, 'error');
  });

  test('get returns undefined for an absent repo', () => {
    assert.equal(store.get('nobody/here'), undefined);
  });

  test('mkdirSync creates the nested db directory (dbPath under a fresh subdir)', () => {
    // The store was constructed with a two-level-deep path in beforeEach; that
    // it opened at all proves the directory was created.
    assert.ok(store.set('a/b', 'info'));
  });

  test('upsert overwrites the tolerance and advances updated_at while keeping created_at', async () => {
    const first = store.set('owner/repo', 'warning');
    // Ensure the ISO clock ticks so updated_at can differ.
    await new Promise((r) => setTimeout(r, 5));
    const second = store.set('owner/repo', 'error');

    assert.equal(second.blockTolerance, 'error');
    assert.equal(second.createdAt, first.createdAt, 'created_at is preserved across upsert');
    assert.notEqual(second.updatedAt, first.updatedAt, 'updated_at advances on upsert');
    assert.ok(
      new Date(second.updatedAt).getTime() >= new Date(first.updatedAt).getTime(),
      'updated_at moves forward',
    );

    // Exactly one row survives the upsert (no duplicate insert).
    assert.equal(store.list().length, 1);
  });

  test('lowercase normalization: mixed-case set is retrievable by any casing, one row only', () => {
    store.set('Owner/Repo', 'error');

    const lower = store.get('owner/repo');
    const upper = store.get('OWNER/REPO');
    const mixed = store.get('Owner/Repo');

    assert.ok(lower, 'lowercase lookup hits');
    assert.ok(upper, 'uppercase lookup hits');
    assert.ok(mixed, 'original-casing lookup hits');
    assert.equal(lower!.blockTolerance, 'error');
    assert.equal(upper!.blockTolerance, 'error');
    // The stored slug is the lowercased form.
    assert.equal(lower!.repo, 'owner/repo');

    // Only ONE physical row exists despite the mixed-case write.
    assert.equal(store.list().length, 1);

    // A second mixed-case write to the same slug still upserts (no duplicate).
    store.set('OWNER/repo', 'warning');
    assert.equal(store.list().length, 1);
    assert.equal(store.get('owner/repo')!.blockTolerance, 'warning');
  });

  test('remove deletes the override; get then returns undefined; remove of absent is a no-op', () => {
    store.set('owner/repo', 'error');
    assert.ok(store.get('owner/repo'));

    store.remove('OWNER/REPO'); // case-insensitive removal
    assert.equal(store.get('owner/repo'), undefined);

    // No-op on an already-absent repo (must not throw).
    assert.doesNotThrow(() => store.remove('owner/repo'));
  });

  test('list is ordered by repo slug ascending', () => {
    store.set('zeta/repo', 'info');
    store.set('alpha/repo', 'warning');
    store.set('mid/repo', 'error');

    const slugs = store.list().map((s) => s.repo);
    assert.deepEqual(slugs, ['alpha/repo', 'mid/repo', 'zeta/repo']);
  });

  test('rows survive close + reopen (durable persistence)', () => {
    store.set('owner/repo', 'error');
    store.set('other/repo', 'info');
    store.close();

    const reopened = createRepoReviewSettingsStore(dbPath);
    try {
      assert.equal(reopened.get('owner/repo')!.blockTolerance, 'error');
      assert.equal(reopened.get('other/repo')!.blockTolerance, 'info');
      assert.equal(reopened.list().length, 2);
    } finally {
      reopened.close();
    }
    // Re-open a fresh handle for the afterEach close() to act on.
    store = createRepoReviewSettingsStore(dbPath);
  });

  test('all three tolerances round-trip through the CHECK constraint', () => {
    for (const t of ['info', 'warning', 'error'] as BlockTolerance[]) {
      const saved = store.set(`repo/${t}`, t);
      assert.equal(saved.blockTolerance, t);
      assert.equal(store.get(`repo/${t}`)!.blockTolerance, t);
    }
  });

  test('SQLite CHECK rejects an out-of-vocabulary tolerance (critical / empty)', () => {
    // The store types forbid this, but a caller could bypass TypeScript; the
    // storage layer must still refuse it via the column CHECK.
    assert.throws(
      () => store.set('owner/repo', 'critical' as never),
      /CHECK|constraint/i,
      'critical must be rejected by the CHECK constraint',
    );
    assert.throws(
      () => store.set('owner/repo', '' as never),
      /CHECK|constraint/i,
      'empty string must be rejected by the CHECK constraint',
    );
    // The failed writes left no row behind.
    assert.equal(store.get('owner/repo'), undefined);
  });
});
