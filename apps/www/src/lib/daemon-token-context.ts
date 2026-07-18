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
  /**
   * The specific threadChat this token was minted for (ADR-003 F2). Null for
   * legacy/non-thread keys (e.g. CLI tokens). Daemon endpoints bind to it: a
   * token for one thread cannot pull/inject for another thread in the org.
   */
  threadChatId: string | null;
  /**
   * The specific thread this token was minted for (ADR-003 F2, threadId anchor).
   * threadChatId is the SHARED legacy sentinel when enableThreadChatCreation is
   * off, which would collapse the F2 binding to org-level; threadId is always
   * unique per thread, so daemon endpoints ALSO bind on it. Null for legacy keys.
   */
  threadId: string | null;
  /**
   * Purpose scope (ADR-003 F1). 'daemon' = minted for a sandbox/worker daemon
   * (agent-run only); null = a general user token (e.g. CLI). The CLI router
   * REJECTS 'daemon' tokens; daemon endpoints REQUIRE them.
   */
  tokenType: "daemon" | null;
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
  const rawThreadChatId = key?.metadata?.threadChatId;
  const threadChatId =
    typeof rawThreadChatId === "string" && rawThreadChatId.length > 0
      ? rawThreadChatId
      : null;
  const rawThreadId = key?.metadata?.threadId;
  const threadId =
    typeof rawThreadId === "string" && rawThreadId.length > 0
      ? rawThreadId
      : null;
  const tokenType = key?.metadata?.tokenType === "daemon" ? "daemon" : null;
  return { userId, organizationId, threadChatId, threadId, tokenType };
}
