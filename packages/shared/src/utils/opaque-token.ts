import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The one format for opaque bearer tokens: 32 random bytes as base64url,
 * stored only as the sha256 hex of the token. Self-heal check/gate tokens
 * and remote-cell bearers both use it, so a stored hash written by one
 * version keeps verifying in the next. Changing the encoding or the length
 * here invalidates every token already minted.
 */
export function mintOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time check of a presented token against its stored hash. */
export function opaqueTokenMatches(
  presented: string,
  storedHash: string,
): boolean {
  const a = Buffer.from(hashOpaqueToken(presented), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
