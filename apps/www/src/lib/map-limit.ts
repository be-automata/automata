/**
 * Run `fn` over `items` with at most `limit` in flight. A lane takes the next
 * item as soon as its previous one settles, so one slow item never holds back
 * the rest (unlike lock-step batches). `fn` must not throw: a rejection ends
 * its lane and rejects the whole call while the other lanes keep running.
 */
export async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        // In range: the loop condition checked `next` on this same tick.
        const item = items[next++]!;
        await fn(item);
      }
    }),
  );
}
