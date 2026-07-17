import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { R2BucketLike } from "@terragon/r2";

/**
 * Resolve a native R2 binding by name (Workers). Returns the binding when running
 * on Cloudflare Workers within a request (via OpenNext's getCloudflareContext),
 * else undefined — which routes packages/r2 to its S3 path (self-host, tests).
 *
 * getCloudflareContext is a static ESM import (workerd is ESM and has no `require`;
 * a lazy require would silently never resolve the binding on Workers). Outside the
 * Workers/OpenNext runtime the call throws ("context not available") → caught here
 * → undefined → S3. The import itself is side-effect-free in node/vitest.
 */
export function getR2Binding(bindingName: string): R2BucketLike | undefined {
  try {
    const ctx = getCloudflareContext();
    const env = ctx?.env as Record<string, R2BucketLike | undefined> | undefined;
    return env?.[bindingName];
  } catch {
    return undefined;
  }
}
