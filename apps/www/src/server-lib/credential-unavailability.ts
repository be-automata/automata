import type { DB } from "@terragon/shared/db";
import { markAgentProviderCredentialUnavailable } from "@terragon/shared/model/agent-provider-credentials";
import type { CredentialUnavailableReason } from "@terragon/shared/model/credential-unavailable-reason";
import type { ProviderUnavailable } from "@/agent/msg/classify-provider-result";

/**
 * #442 (epic #440 C2): how a classified provider refusal (#441) marks the
 * credential the run was delivered.
 *
 * - `usage_limit` is timed: until its reset. An unknown or already-past
 *   reset marks one hour ahead — a self-resetting limit must never need an
 *   admin clear, and a bounded probe costs at most one failed run per lane
 *   per hour.
 * - `subscription_disabled` and `auth_rejected` (#472) are indefinite: they
 *   do not reset on their own; an admin clear (or a reconnect, which inserts
 *   a new row) ends them.
 * - `credit_exhausted` is never a mark: it concerns the built-in key, not a
 *   row (epic decision); it is the operator alert's (C4, #444).
 */
export const UNKNOWN_RESET_MARK_MS = 60 * 60 * 1000;

export interface CredentialMark {
  reason: CredentialUnavailableReason;
  /** NULL = indefinite. */
  until: Date | null;
}

export function credentialMarkFor(
  provider: ProviderUnavailable,
  now: number,
): CredentialMark | null {
  switch (provider.kind) {
    case "usage_limit": {
      const resetsAt =
        provider.resetsAt !== undefined && provider.resetsAt > now
          ? provider.resetsAt
          : now + UNKNOWN_RESET_MARK_MS;
      return { reason: "usage_limit", until: new Date(resetsAt) };
    }
    case "subscription_disabled":
    case "auth_rejected":
      return { reason: provider.kind, until: null };
    case "credit_exhausted":
      return null;
    default: {
      const exhaustive: never = provider.kind;
      throw new Error(`Unknown provider-unavailable kind: ${exhaustive}`);
    }
  }
}

/**
 * Mark the credential a run was delivered (thread/thread_chat
 * `delivered_credential_id`, recorded by /api/daemon/agent-credentials) after
 * its result was classified provider-unavailable. Targets that id only, so a
 * credential an operator switched to mid-run is never marked. Returns whether
 * a row changed; false when there is no delivered id (built-in credits, the
 * legacy sandbox plane), no mark for this kind, or the mark was a no-op.
 * Throws on a database error: the caller decides (it logs and continues).
 */
export async function markDeliveredCredentialUnavailable({
  db,
  userId,
  credentialId,
  provider,
  now,
}: {
  db: DB;
  userId: string;
  credentialId: string | null;
  provider: ProviderUnavailable;
  now: number;
}): Promise<boolean> {
  if (credentialId === null) {
    return false;
  }
  const mark = credentialMarkFor(provider, now);
  if (mark === null) {
    return false;
  }
  return markAgentProviderCredentialUnavailable({
    db,
    userId,
    credentialId,
    reason: mark.reason,
    until: mark.until,
  });
}
