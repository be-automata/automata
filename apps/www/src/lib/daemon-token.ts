import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { apikey, thread as threadTable } from "@terragon/shared/db/schema";
import { and, eq, like, sql, type SQL } from "drizzle-orm";
import {
  CELL_EVENT_TOKEN_INFIX,
  DAEMON_EVENT_SCOPE,
  RETIRED_TOKEN_SUFFIX,
} from "@/lib/daemon-token-context";
import { CELL_RUN_TTL_MS } from "@terragon/types/cell";

/** A retired token's remaining life: the teardown margin of CELL_RUN_TTL_MS. */
export const RETIRED_DAEMON_TOKEN_GRACE_MS = 15 * 60 * 1000;

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
  return (await createDaemonApiKey({ userId, threadId, threadChatId, name }))
    .key;
}

/**
 * The one createApiKey every daemon token goes through: the thread's org, the
 * F1/F2 metadata and the plugin-minimum 1-day expiry. `scope` adds the #693
 * event-only marker.
 */
async function createDaemonApiKey({
  userId,
  threadId,
  threadChatId,
  name,
  scope,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  name?: string;
  scope?: typeof DAEMON_EVENT_SCOPE;
}): Promise<{ id: string; key: string }> {
  const [threadRow] = await db
    .select({ organizationId: threadTable.organizationId })
    .from(threadTable)
    .where(eq(threadTable.id, threadId))
    .limit(1);
  const organizationId = threadRow?.organizationId ?? null;
  const apiKey = await auth.api.createApiKey({
    body: {
      ...(name === undefined ? {} : { name }),
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
        ...(scope === undefined ? {} : { scope }),
      },
    },
  });
  return { id: apiKey.id, key: apiKey.key };
}

/**
 * Which cell tokens a call acts on (#693). `stepKey` is the cell step of the
 * worker's run token (`cellStepKey(apiKeyId)`), so two runs of one thread never
 * touch each other's tokens, even though `attempt` restarts at 1 per step.
 */
export interface CellTokenStep {
  userId: string;
  threadId: string;
  threadChatId: string;
  stepKey: string;
}

/** `${daemonRunKey}:cell-event:${stepKey}:${attempt}`. */
export function cellEventTokenName(
  step: Omit<CellTokenStep, "userId"> & { attempt: number },
): string {
  return `${cellEventTokenPrefix(step)}${step.attempt}`;
}

function cellEventTokenPrefix(step: Omit<CellTokenStep, "userId">): string {
  return `${daemonRunKey(step)}${CELL_EVENT_TOKEN_INFIX}${step.stepKey}:`;
}

function stepTokensPredicate(step: Omit<CellTokenStep, "userId">): SQL {
  return like(apikey.name, `${escapeLikePattern(cellEventTokenPrefix(step))}%`);
}

/**
 * Mint the cell's own daemon credential for one attempt (#693): an
 * event-scoped token that only `POST /api/daemon-event` accepts
 * (verifyDaemonApiKey refuses it everywhere else), so a cell's vault never
 * holds the worker's run token.
 *
 *  1. Creates the key with the F1/F2 metadata plus `scope: "daemon-event"`,
 *     unnamed, because the name is longer than the plugin's 64-character cap.
 *  2. One UPDATE fenced by id and owner sets the name and caps `expires_at`
 *     at now + CELL_RUN_TTL_MS (UTC, as retire does). A failure deletes the
 *     new row and rethrows. A row a failed delete leaves behind is inert: its
 *     value was never returned, and it is still event-scoped.
 *
 * Earlier tokens are NOT deleted here: the caller supersedes them only once
 * its plan has won (supersedeCellEventTokens), so a lost or failed replay never
 * kills the token of the response the worker kept.
 */
export async function mintCellEventToken({
  attempt,
  stepKey,
  ...run
}: CellTokenStep & { attempt: number }): Promise<{
  token: string;
  apiKeyId: string;
}> {
  const { userId } = run;
  const created = await createDaemonApiKey({
    ...run,
    scope: DAEMON_EVENT_SCOPE,
  });
  try {
    const named = await db
      .update(apikey)
      .set({
        name: cellEventTokenName({ ...run, stepKey, attempt }),
        expiresAt: cappedExpiresAt(CELL_RUN_TTL_MS),
      })
      .where(and(eq(apikey.id, created.id), eq(apikey.referenceId, userId)))
      .returning({ id: apikey.id });
    if (named.length !== 1) {
      throw new Error("cell event token row not found after create");
    }
  } catch (error) {
    await revokeDaemonTokenById({ userId, apiKeyId: created.id });
    throw error;
  }
  return { token: created.key, apiKeyId: created.id };
}

/**
 * After a plan wins (its bearer was minted), delete the step's cell tokens
 * created BEFORE `keepApiKeyId`: earlier attempts and earlier responses of a
 * replay. "Older than mine", not "every other", so two racing replays converge
 * on the newest token instead of deleting each other's. A same-millisecond tie
 * leaves both, each event-only and capped at CELL_RUN_TTL_MS.
 */
export async function supersedeCellEventTokens({
  keepApiKeyId,
  ...step
}: CellTokenStep & { keepApiKeyId: string }): Promise<number> {
  const keptCreatedAt = sql`(SELECT ${apikey.createdAt} FROM ${apikey} WHERE ${apikey.id} = ${keepApiKeyId})`;
  return deleteDaemonTokens(
    and(
      stepTokensPredicate(step),
      sql`${apikey.createdAt} < ${keptCreatedAt}`,
    ) as SQL,
    step.userId,
    "superseded cell event token(s)",
    { threadId: step.threadId, stepKey: step.stepKey },
  );
}

/**
 * Delete a step's cell tokens: one attempt's (teardown), or every attempt's
 * when `attempt` is omitted (terminal read). Owner-fenced; returns the count.
 */
export async function revokeCellEventTokens({
  attempt,
  ...step
}: CellTokenStep & { attempt?: number }): Promise<number> {
  const predicate =
    attempt === undefined
      ? stepTokensPredicate(step)
      : eq(apikey.name, cellEventTokenName({ ...step, attempt }));
  return deleteDaemonTokens(
    predicate,
    step.userId,
    "revoked cell event token(s)",
    {
      threadId: step.threadId,
      stepKey: step.stepKey,
      ...(attempt === undefined ? {} : { attempt: String(attempt) }),
    },
  );
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
  return deleteDaemonTokens(
    eq(apikey.id, apiKeyId),
    userId,
    "revoked run token on terminal (by id)",
    { apiKeyId },
  );
}

/**
 * Cell terminal read: retire the run's token instead of deleting it. One
 * UPDATE, fenced by id and owner, that
 *  - appends `:retired` to `name`: the double-dispatch guard (which matches
 *    the bare run key) stops seeing the run as in flight, while sweep rule
 *    (iii)'s `${threadId}:` prefix still matches it;
 *  - caps `expires_at` at now + RETIRED_DAEMON_TOKEN_GRACE_MS
 *    (cappedExpiresAt: never later, compared in UTC).
 * Idempotent: a second call matches no row and returns false.
 */
export async function retireDaemonTokenById({
  userId,
  apiKeyId,
}: {
  userId: string;
  apiKeyId: string;
}): Promise<boolean> {
  const retired = await db
    .update(apikey)
    .set({
      // COALESCE matches the WHERE below: NULL || text is NULL in SQL, so a
      // null name would "retire" without ever carrying the suffix.
      name: sql`COALESCE(${apikey.name}, '') || ${RETIRED_TOKEN_SUFFIX}`,
      expiresAt: cappedExpiresAt(RETIRED_DAEMON_TOKEN_GRACE_MS),
    })
    .where(
      and(
        eq(apikey.id, apiKeyId),
        eq(apikey.referenceId, userId),
        sql`COALESCE(${apikey.name}, '') NOT LIKE ${`%${RETIRED_TOKEN_SUFFIX}`}`,
      ),
    )
    .returning({ id: apikey.id });
  if (retired.length > 0) {
    console.log("[daemon-token] retired run token (cell terminal read)", {
      userId,
      apiKeyId,
    });
  }
  return retired.length > 0;
}

/**
 * cell-teardown `report`: delete the caller's token, but only if it was
 * retired. A token still live (no terminal read happened) is left alone, and
 * so is a follow-up run's live token. Returns how many were deleted (0 or 1).
 */
export async function revokeRetiredDaemonTokenById({
  userId,
  apiKeyId,
}: {
  userId: string;
  apiKeyId: string;
}): Promise<number> {
  return deleteDaemonTokens(
    and(
      eq(apikey.id, apiKeyId),
      sql`COALESCE(${apikey.name}, '') LIKE ${`%${RETIRED_TOKEN_SUFFIX}`}`,
    ) as SQL,
    userId,
    "deleted retired run token (cell report)",
    { apiKeyId },
  );
}

/**
 * #380 sweep rule (iii): revoke every REMOTE-path daemon token of a thread
 * by the per-run key prefix `${threadId}:` (daemonRunKey). The sweep knows
 * the thread but not which threadChatId the run was minted under, and a
 * token left live after the thread is terminal blocks the double-dispatch
 * guard for its 1-day backstop TTL. In-process sandbox tokens are named by
 * sandboxId (never a thread id), so the prefix can only match remote runs
 * of THIS thread. Returns how many were deleted.
 */
export async function revokeDaemonTokensForThread({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}): Promise<number> {
  return deleteDaemonTokens(
    like(apikey.name, `${escapeLikePattern(threadId)}:%`),
    userId,
    "revoked run token(s) for thread",
    { threadId },
  );
}

/**
 * The one delete every revoke goes through: ALWAYS fenced by the owning
 * user, returning the count, logging one line (ids only, never a key).
 */
async function deleteDaemonTokens(
  predicate: SQL,
  userId: string,
  logLabel: string,
  logFields: Record<string, string>,
): Promise<number> {
  const deleted = await db
    .delete(apikey)
    .where(and(eq(apikey.referenceId, userId), predicate))
    .returning({ id: apikey.id });
  if (deleted.length > 0) {
    console.log(`[daemon-token] ${logLabel}`, {
      userId,
      ...logFields,
      count: deleted.length,
    });
  }
  return deleted.length;
}

/**
 * `expires_at` capped at now + `ms`. LEAST means no call can ever move the
 * expiry later. The column is a `timestamp` without a time zone that the
 * api-key plugin writes in UTC, so the cap compares in UTC.
 */
function cappedExpiresAt(ms: number): SQL {
  const cap = sql`((now() AT TIME ZONE 'UTC') + make_interval(secs => ${ms / 1000}::double precision))`;
  return sql`LEAST(COALESCE(${apikey.expiresAt}, ${cap}), ${cap})`;
}

/** `%`, `_` and `\` are LIKE metacharacters; a thread id never holds them, but escape anyway. */
function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function revokeDaemonTokensForSandbox({
  userId,
  sandboxId,
}: {
  userId: string;
  sandboxId: string;
}): Promise<number> {
  return deleteDaemonTokens(
    eq(apikey.name, sandboxId),
    userId,
    "revoked on thread terminal",
    { sandboxId },
  );
}
