import { db } from "@/lib/db";
import { apikey } from "@terragon/shared/db/schema";
import { and, eq } from "drizzle-orm";

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
