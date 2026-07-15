import { after } from "next/server";

/**
 * Self-host-safe replacement for `waitUntil` from `@vercel/functions`.
 *
 * Uses Next's `after()` to run background work after the response is flushed, which
 * works on any Node host (not just Vercel's edge/functions runtime). When `after()`
 * is unavailable — e.g. called outside a request scope such as a script or the daemon
 * — it falls back to firing the promise directly and logging any rejection so the work
 * still runs and errors are not swallowed.
 *
 * Note: this preserves the fire-and-forget lifetime-extension semantics of the
 * original. Durable background work is migrated to Hatchet separately.
 */
export function waitUntil(promise: Promise<unknown>): void {
  try {
    after(() => promise);
  } catch {
    void Promise.resolve(promise).catch((error) => {
      console.error("waitUntil: background task failed", error);
    });
  }
}
