/**
 * AuditWriterQueue — generalised async fire-and-forget queue for audit-log
 * writers. Lifted from the redaction discipline used in
 * `src/security/secret-audit.ts`; lives under `src/audit/` so future audit
 * surfaces (review, secret, anything else) reuse it.
 *
 * Implements Phase 3 §2 row 11.
 *
 * Contract (NFR-2):
 *   • `enqueue` returns synchronously and never throws.
 *   • Drain runs on a microtask queue independent of the producer.
 *   • Writer failures are surfaced via the injected error reporter; the
 *     queue keeps draining subsequent rows.
 *   • `flush()` resolves once the queue is empty (drain idle).
 */

export interface AuditWriterQueueDeps<T> {
  /** Synchronous writer invoked once per enqueued item. May throw. */
  write: (item: T) => void;
  /**
   * Optional error reporter — called with `(error, item)` when `write`
   * throws. Must not throw itself.
   */
  onError?: (err: unknown, item: T) => void;
}

export interface AuditWriterQueue<T> {
  /** Push an item onto the queue. Returns synchronously. Never throws. */
  enqueue(item: T): void;
  /** Resolve when the queue is empty. */
  flush(): Promise<void>;
  /** Number of items currently waiting (excluding any in-flight item). */
  size(): number;
}

export function createAuditWriterQueue<T>(deps: AuditWriterQueueDeps<T>): AuditWriterQueue<T> {
  const { write, onError } = deps;

  const queue: T[] = [];
  let draining = false;
  let drainPromise: Promise<void> | null = null;
  let drainResolve: (() => void) | null = null;

  function scheduleDrain(): void {
    if (draining) return;
    draining = true;

    // Use queueMicrotask so the drain runs *after* the current synchronous
    // task completes, preserving non-blocking semantics for the producer.
    queueMicrotask(async () => {
      try {
        while (queue.length > 0) {
          const item = queue.shift() as T;
          try {
            write(item);
          } catch (err) {
            try {
              onError?.(err, item);
            } catch {
              // Error reporter must not crash the drain. Swallow.
            }
          }
        }
      } finally {
        draining = false;
        if (drainResolve) {
          drainResolve();
          drainResolve = null;
          drainPromise = null;
        }
      }
    });
  }

  return {
    enqueue(item) {
      try {
        queue.push(item);
        scheduleDrain();
      } catch {
        // Defensive — array push should not throw, but enqueue must never
        // surface failure to the caller per NFR-2.
      }
    },
    flush() {
      if (queue.length === 0 && !draining) return Promise.resolve();
      if (drainPromise) return drainPromise;
      drainPromise = new Promise<void>((resolve) => {
        drainResolve = resolve;
      });
      // Re-poke the drain in case it had idled between checks.
      scheduleDrain();
      return drainPromise;
    },
    size() {
      return queue.length;
    },
  };
}
