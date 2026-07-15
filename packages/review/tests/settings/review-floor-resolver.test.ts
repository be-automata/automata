/**
 * review-floor-resolver — the per-repo approve-floor precedence chain.
 *
 * Precedence: settings-store row (dashboard) > env-derived policy > locked
 * default. The store is read LIVE on every call, so a dashboard write applies
 * to the next resolved run without a restart. node:test + node:assert/strict.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createReviewApproveFloorResolver } from '../../src/settings/review-floor-resolver';
import {
  DEFAULT_APPROVE_SEVERITY_POLICY,
  toleranceToPolicy,
  type ApproveSeverityPolicy,
} from '../../src/review/severity-policy';
import type { BlockTolerance, RepoReviewSetting } from '../../src/settings/types';

/** Minimal in-memory stub of the store's `get`, mutable between calls. */
function stubStore(initial: Record<string, BlockTolerance> = {}) {
  const rows = new Map<string, BlockTolerance>(Object.entries(initial));
  return {
    rows,
    get(repo: string): RepoReviewSetting | undefined {
      const tol = rows.get(repo);
      if (!tol) return undefined;
      return {
        repo,
        blockTolerance: tol,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
    },
  };
}

describe('review-floor-resolver — precedence matrix', () => {
  test('row present → toleranceToPolicy(row.blockTolerance) wins over env and default', () => {
    const store = stubStore({ 'owner/repo': 'error' });
    const envPolicy: ApproveSeverityPolicy = { blockSeverity: 'critical', surfaceSeverity: 'info' };
    const resolve = createReviewApproveFloorResolver({ store, envPolicy });

    assert.deepEqual(resolve('owner/repo'), toleranceToPolicy('error'));
    assert.deepEqual(resolve('owner/repo'), { blockSeverity: 'error', surfaceSeverity: 'warning' });
  });

  test('no row + envPolicy → envPolicy', () => {
    const store = stubStore();
    const envPolicy: ApproveSeverityPolicy = { blockSeverity: 'error', surfaceSeverity: 'warning' };
    const resolve = createReviewApproveFloorResolver({ store, envPolicy });

    assert.deepEqual(resolve('owner/repo'), envPolicy);
  });

  test('no row + no envPolicy → the locked DEFAULT policy', () => {
    const store = stubStore();
    const resolve = createReviewApproveFloorResolver({ store });

    assert.deepEqual(resolve('owner/repo'), DEFAULT_APPROVE_SEVERITY_POLICY);
  });

  test('each tolerance maps to its full policy when present as a row', () => {
    const store = stubStore();
    const resolve = createReviewApproveFloorResolver({ store });
    const cases: Array<[BlockTolerance, ApproveSeverityPolicy]> = [
      ['info', { blockSeverity: 'info', surfaceSeverity: 'info' }],
      ['warning', { blockSeverity: 'warning', surfaceSeverity: 'warning' }],
      ['error', { blockSeverity: 'error', surfaceSeverity: 'warning' }],
    ];
    for (const [tol, policy] of cases) {
      store.rows.set('owner/repo', tol);
      assert.deepEqual(resolve('owner/repo'), policy, `tolerance ${tol}`);
    }
  });
});

describe('review-floor-resolver — LIVE read', () => {
  test('a store mutation between two calls is reflected in the second call (no snapshot)', () => {
    const store = stubStore();
    const envPolicy: ApproveSeverityPolicy = { blockSeverity: 'warning', surfaceSeverity: 'warning' };
    const resolve = createReviewApproveFloorResolver({ store, envPolicy });

    // No override yet → falls back to the env policy.
    assert.deepEqual(resolve('owner/repo'), envPolicy);

    // Dashboard writes an override AFTER the resolver was created.
    store.rows.set('owner/repo', 'info');
    assert.deepEqual(
      resolve('owner/repo'),
      toleranceToPolicy('info'),
      'the resolver reads the store live, not a boot-time snapshot',
    );

    // Removing the override reverts to the env policy on the next call.
    store.rows.delete('owner/repo');
    assert.deepEqual(resolve('owner/repo'), envPolicy);
  });
});
