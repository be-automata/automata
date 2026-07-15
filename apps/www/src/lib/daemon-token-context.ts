/**
 * Tenant context resolved from a daemon (X-Daemon-Token) API key.
 *
 * The Better Auth apiKey plugin round-trips per-key `metadata` through
 * `verifyApiKey`, so an `organizationId` stamped into a key's metadata at
 * creation is readable on the verification result. This is the seam the daemon
 * path uses to resolve a tenant directly instead of inferring it from the
 * user's active org. See docs/adr/ADR-001-tenant-scoping-enforcement.md §3.
 *
 * Kept dependency-free (no next/db/auth imports) so it is unit-testable and
 * cheap to import from the resolver.
 */
export type DaemonTokenContext = {
  userId: string;
  /** Null for personal (org-less) keys until the WI-5c apiKey retrofit. */
  organizationId: string | null;
};

type VerifiedApiKeyLike = {
  userId?: string | null;
  metadata?: Record<string, unknown> | null;
} | null;

/**
 * Map a verified apiKey record onto a tenant context. Returns null when the key
 * carries no user (invalid/unusable key). Pure — no I/O.
 */
export function daemonTokenContextFromApiKey(
  key: VerifiedApiKeyLike,
): DaemonTokenContext | null {
  const userId = key?.userId;
  if (!userId) {
    return null;
  }
  const rawOrg = key?.metadata?.organizationId;
  const organizationId =
    typeof rawOrg === "string" && rawOrg.length > 0 ? rawOrg : null;
  return { userId, organizationId };
}
