import { timingSafeEqual } from "node:crypto";

/**
 * Shared security-invariant primitives for the per-run loopback credential
 * brokers (git-broker.ts / gh-broker.ts). Only the invariants both brokers
 * must agree on live here — fence POLICY (repo path, host, method/path
 * allowlists) stays per-broker by design.
 */

// HOP_BY_HOP / REQUEST_OWNED live in @terragon/utils (shared with the www
// remote-cell broker); re-exported so the worker brokers import them from here.
export { HOP_BY_HOP, REQUEST_OWNED } from "@terragon/utils/broker-headers";

export function timingSafeEqualStr(a: string, bBuf: Buffer): boolean {
  const ab = Buffer.from(a);
  // Length check first is safe: bearer length is not secret, and timingSafeEqual
  // throws on length mismatch. `bBuf` is precomputed once in the closure.
  return ab.length === bBuf.length && timingSafeEqual(ab, bBuf);
}
