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
 *   - metadata.threadChatId    — F2 binding: the endpoints reject any other thread
 *   - metadata.tokenType='daemon' — F1 scope: CLI rejects, daemon endpoints require
 * `name` is the revoke key (revokeDaemonTokensForSandbox deletes by it on terminal);
 * expiresIn is the plugin-minimum 1-day backstop (F3 — revocation is primary).
 * Returns the raw token string.
 */
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
export async function revokeDaemonTokensForSandbox({
  userId,
  sandboxId,
}: {
  userId: string;
  sandboxId: string;
}): Promise<number> {
  const deleted = await db
    .delete(apikey)
    .where(and(eq(apikey.userId, userId), eq(apikey.name, sandboxId)))
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
