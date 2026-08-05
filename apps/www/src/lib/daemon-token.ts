import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { apikey, thread as threadTable } from "@terragon/shared/db/schema";
import { and, eq } from "drizzle-orm";

/**
 * Mint the org-scoped, thread-bound, daemon-purpose token a daemon uses to talk
 * to www (events + next-message pull). Single source of the ADR-003 F1/F2/F3
 * metadata so the in-process (sendDaemonMessage) and remote (Hatchet dispatch)
 * paths mint identically:
 *   - metadata.organizationId  — the THREAD's org (WI-5; unambiguous, nullable-safe)
 *   - metadata.threadChatId    — F2 binding: the endpoints reject any other threadChat
 *   - metadata.threadId        — F2 anchor: unique per thread (threadChatId is the
 *                                shared legacy sentinel when enableThreadChatCreation
 *                                is off), so endpoints bind per-thread, not org-level
 *   - metadata.tokenType='daemon' — F1 scope: CLI rejects, daemon endpoints require
 * `name` is the revoke key (revokeDaemonTokensForSandbox deletes by it on terminal);
 * expiresIn is the plugin-minimum 1-day backstop (F3 — revocation is primary).
 * Returns the raw token string.
 */
/**
 * The per-run key used to NAME the remote (Hatchet) daemon token — the revoke key
 * AND the double-dispatch dedup key (ADR-003 F3 / idempotency).
 *
 * It MUST be unique per thread run. threadChatId alone is NOT: when the
 * `enableThreadChatCreation` feature flag is off (its default), createThread
 * returns the shared sentinel LEGACY_THREAD_CHAT_ID for EVERY thread, so keying on
 * threadChatId made one thread's leftover token block all future dispatches. threadId
 * is always unique per thread; the composite is unique in both flag states (flag on:
 * threadChatId already unique; flag off: threadId disambiguates the sentinel).
 */
export function daemonRunKey({
  threadId,
  threadChatId,
}: {
  threadId: string;
  threadChatId: string;
}): string {
  return `${threadId}:${threadChatId}`;
}

export async function mintDaemonToken({
  userId,
  threadId,
  threadChatId,
  name,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  name: string;
}): Promise<string> {
  const [threadRow] = await db
    .select({ organizationId: threadTable.organizationId })
    .from(threadTable)
    .where(eq(threadTable.id, threadId))
    .limit(1);
  const organizationId = threadRow?.organizationId ?? null;
  const apiKey = await auth.api.createApiKey({
    body: {
      name,
      expiresIn: 60 * 60 * 24 * 1, // 1 day (plugin minimum) — backstop only
      userId,
      metadata: {
        ...(organizationId ? { organizationId } : {}),
        threadChatId,
        // F2 anchor (ADR-003): threadChatId is the shared legacy sentinel when
        // enableThreadChatCreation is off, collapsing the binding to org-level;
        // threadId is unique per thread, so endpoints bind on it too.
        threadId,
        tokenType: "daemon",
      },
    },
  });
  return apiKey.key;
}

/**
 * Revoke the daemon token(s) minted for a sandbox/thread run (ADR-003 F3).
 *
 * Daemon tokens are created with `name = sandboxId` (see sendDaemonMessage), a
 * value used only for daemon tokens — so deleting the user's apikeys with that
 * name revokes exactly this run's daemon token(s), immediately, on thread
 * terminal. The 1-day expiry (better-auth plugin minimum) is only a backstop for runs that never reach terminal.
 * Returns how many were revoked (0 is normal — e.g. resumed threads or the
 * remote path once it mints per-run).
 */
/**
 * Whether a live daemon token exists for the given name (ADR-003 double-dispatch
 * guard). Daemon tokens are minted with `name = threadChatId` on the remote path
 * and revoked on thread-terminal, so an existing one means a dispatch/run is
 * already in flight for that threadChat — the caller skips re-triggering. Best-
 * effort (a tight race can still double-mint; the Hatchet v1 trigger has no
 * server-side dedup, so this is the www-side guard).
 */
export async function hasActiveDaemonToken({
  userId,
  name,
}: {
  userId: string;
  name: string;
}): Promise<boolean> {
  const rows = await db
    .select({ id: apikey.id })
    .from(apikey)
    .where(and(eq(apikey.referenceId, userId), eq(apikey.name, name)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Revoke ONE daemon token by its exact apikey id (ADR-003 F3, burst-safe). Used at
 * thread-finish to revoke the run's OWN token — the one that authenticated the
 * terminal daemon-event (ctx.apiKeyId). This can never delete a sibling run's token,
 * unlike revoke-by-name/thread, which under a burst let a delayed finish for run A
 * delete run B's freshly-minted same-keyed token, killing B mid-work (S12). userId
 * is an extra fence. Returns how many were deleted (0 or 1).
 */
export async function revokeDaemonTokenById({
  userId,
  apiKeyId,
}: {
  userId: string;
  apiKeyId: string;
}): Promise<number> {
  const deleted = await db
    .delete(apikey)
    .where(and(eq(apikey.referenceId, userId), eq(apikey.id, apiKeyId)))
    .returning({ id: apikey.id });
  if (deleted.length > 0) {
    console.log("[daemon-token] revoked run token on terminal (by id)", {
      userId,
      apiKeyId,
    });
  }
  return deleted.length;
}

export async function revokeDaemonTokensForSandbox({
  userId,
  sandboxId,
}: {
  userId: string;
  sandboxId: string;
}): Promise<number> {
  const deleted = await db
    .delete(apikey)
    .where(and(eq(apikey.referenceId, userId), eq(apikey.name, sandboxId)))
    .returning({ id: apikey.id });
  if (deleted.length > 0) {
    console.log("[daemon-token] revoked on thread terminal", {
      userId,
      sandboxId,
      count: deleted.length,
    });
  }
  return deleted.length;
}
