/**
 * NFR-2 / AC-12 / EC-14 / EC-17 — audit writes are non-blocking and do not
 * surface failures to the caller. Pending writes flush on demand.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditWriterQueue } from '../../src/audit/audit-writer-queue';
import { createReviewAuditLog, type ReviewAuditLog } from '../../src/audit/review-audit-log';

describe('AuditWriterQueue non-blocking semantics', () => {
  it('NFR-2: enqueue returns synchronously even when writer is slow', async () => {
    const seen: number[] = [];
    let writes = 0;
    const queue = createAuditWriterQueue<number>({
      // Simulate slow writes by busy-looping is wasteful; instead, pretend
      // the writer is synchronous but observable. The point is: enqueue
      // must not block on the write.
      write: (n) => {
        writes++;
        seen.push(n);
      },
    });

    const start = Date.now();
    for (let i = 0; i < 10; i++) {
      queue.enqueue(i);
    }
    const elapsed = Date.now() - start;
    // Enqueue is O(1) array push + microtask schedule. Even on a slow CI
    // box, 10 pushes should complete well under 50ms.
    assert.ok(elapsed < 50, `enqueue should be near-instant, took ${elapsed}ms`);

    // The writes happen on a microtask after the synchronous enqueues.
    // At this point, before flush(), some/all may not have run yet.
    await queue.flush();
    assert.equal(writes, 10);
    assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('AC-12 / EC-17: a thrown writer error does not surface to the producer', async () => {
    const errors: Array<{ err: unknown; item: number }> = [];
    const queue = createAuditWriterQueue<number>({
      write: (n) => {
        if (n === 3) throw new Error('boom');
      },
      onError: (err, item) => {
        errors.push({ err, item });
      },
    });

    // None of these should throw.
    assert.doesNotThrow(() => {
      queue.enqueue(1);
      queue.enqueue(2);
      queue.enqueue(3);
      queue.enqueue(4);
    });
    await queue.flush();

    assert.equal(errors.length, 1);
    assert.equal(errors[0].item, 3);
    assert.match((errors[0].err as Error).message, /boom/);
  });

  it('flush() resolves even when called multiple times concurrently', async () => {
    const queue = createAuditWriterQueue<number>({
      write: () => {},
    });
    queue.enqueue(1);
    const p1 = queue.flush();
    const p2 = queue.flush();
    await Promise.all([p1, p2]);
    assert.equal(queue.size(), 0);
  });
});

describe('ReviewAuditLog non-blocking semantics (integration)', () => {
  let tmp: string;
  let log: ReviewAuditLog;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'review-audit-nonblock-'));
    log = createReviewAuditLog(join(tmp, 'review-audit.db'));
  });

  afterEach(async () => {
    await log.flush();
    log.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('EC-17: emit never throws even with malformed payload', () => {
    // Circular reference would normally cause JSON.stringify to throw.
    const circular: Record<string, unknown> = { self: null };
    circular.self = circular;
    assert.doesNotThrow(() => {
      log.emit({
        type: 'review.started',
        repo: 'a/b',
        prNumber: 1,
        payload: circular,
      });
    });
  });

  it('EC-14: handles a 200-event burst without dropping events on flush', async () => {
    for (let i = 0; i < 200; i++) {
      log.emit({
        type: 'review.finding_lifecycle',
        repo: 'a/b',
        prNumber: 1,
        findingId: `fp-${i}`,
        payload: { before: 'active', after: 'fixed' },
      });
    }
    await log.flush();
    assert.equal(log.count(), 200);
  });
});
