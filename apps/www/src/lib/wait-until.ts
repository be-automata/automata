import { after } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";

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

/**
 * Register request-outliving I/O directly on the Cloudflare Workers
 * ExecutionContext so it survives after the Response is flushed.
 *
 * On Workers, an outbound `fetch()` whose completion is not tied to a live
 * `ctx.waitUntil` is torn down with "Network connection lost" the moment the
 * originating request ends — even when kicked off from `after()`, if that
 * `after()` isn't itself backed by `ctx.waitUntil` (e.g. a nested/background
 * scope where `after()` throws and we fall back to a plain fire-and-forget). This
 * is the same request-scoped-I/O-outliving-the-request class as the per-request
 * neon Pool hang. Registering the promise on `ctx.waitUntil` keeps the isolate
 * alive until it settles.
 *
 * Off Workers (self-host, tests) `getCloudflareContext()` throws → we fall back to
 * `waitUntil` (Next `after()` → direct fire), which is correct on a Node host.
 */
export function waitUntilOutlivesRequest(promise: Promise<unknown>): void {
  try {
    const ctx = getCloudflareContext()?.ctx;
    if (ctx?.waitUntil) {
      ctx.waitUntil(
        Promise.resolve(promise).catch((error) => {
          console.error(
            "waitUntilOutlivesRequest: background task failed",
            error,
          );
        }),
      );
      return;
    }
  } catch {
    // Not on Workers / no request context — fall through to the Node-host path.
  }
  waitUntil(promise);
}
