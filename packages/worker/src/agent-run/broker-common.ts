import { timingSafeEqual } from "node:crypto";

/**
 * Shared security-invariant primitives for the per-run loopback credential
 * brokers (git-broker.ts / gh-broker.ts). Only the invariants both brokers
 * must agree on live here — fence POLICY (repo path, host, method/path
 * allowlists) stays per-broker by design.
 */

// Hop-by-hop / body-framing headers neither direction may copy verbatim — Node
// (response) and fetch (request) re-frame the body, so a stale
// length/encoding/connection header corrupts it.
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "upgrade",
]);

// Request headers the broker OWNS — everything else is forwarded VERBATIM
// (a denylist, symmetric with HOP_BY_HOP on the response side). `authorization`
// is replaced with the injected credential (never the client's bearer); `host`
// is set by fetch to the upstream. A denylist forwards future git/gh headers by
// default — the allowlist trap already bit us once: `git-protocol` was
// load-bearing and its omission silently downgraded protocol v2→v0.
export const REQUEST_OWNED = new Set([...HOP_BY_HOP, "authorization", "host"]);

export function timingSafeEqualStr(a: string, bBuf: Buffer): boolean {
  const ab = Buffer.from(a);
  // Length check first is safe: bearer length is not secret, and timingSafeEqual
  // throws on length mismatch. `bBuf` is precomputed once in the closure.
  return ab.length === bBuf.length && timingSafeEqual(ab, bBuf);
}
