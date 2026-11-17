import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { DB } from "../../db";
import { agentApplied, agentMessages, threadChat } from "../../db/schema";
import type { DBUserMessage } from "../../db/db-message";
import { sanitizeForJson } from "../../utils/sanitize-json";
import { getRunForOrg } from "./agent-run";
import { authorizeSend, type AgentBusError } from "./capabilities";

/**
 * Exactly-once message delivery between runs (#660, S2).
 *
 * A message is committed first (`insertMessage`, keyed by `(from_run, idem_key)`),
 * then delivered by `receiveFor`: per message, ONE transaction claims the row
 * (`FOR UPDATE SKIP LOCKED`), records it in `agent_applied`, runs the caller's
 * `apply` and sets `consumed_at`. A crash or a throw before COMMIT rolls all of it
 * back, so a message is applied zero or one time. `sweepUnconsumed` is the safety
 * net for a message whose receive never ran.
 */

export interface AgentMessage {
  id: number;
  fromRun: string;
  toRun: string;
  body: string;
  createdAt: Date;
}

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/** Runs INSIDE the receive transaction (a plain `DB` only in the test-only unsafe path). */
export type ApplyMessage = (
  tx: Tx | DB,
  message: AgentMessage,
) => Promise<void>;

export type SendError = AgentBusError | "idem_key_conflict";

export type SendResult =
  | { ok: true; id: number; duplicate: boolean; applied: number }
  | { ok: false; error: SendError };

interface BusLogger {
  error: (message: string, error: unknown) => void;
}

const DEFAULT_LOGGER: BusLogger = {
  error: (message, error) => console.error(message, error),
};

/**
 * Inserts the message under `(from, key)`. A retry with the same key returns the
 * stored id with `duplicate: true`; a retry whose `(to, body)` differ is a caller
 * bug and returns `{ conflict: true }`.
 */
export async function insertMessage({
  db,
  from,
  to,
  key,
  body,
}: {
  db: DB;
  from: string;
  to: string;
  key: string;
  body: string;
}): Promise<{ id: number; duplicate: boolean } | { conflict: true }> {
  const inserted = await db
    .insert(agentMessages)
    .values({ idemKey: key, fromRun: from, toRun: to, body })
    .onConflictDoNothing({
      target: [agentMessages.fromRun, agentMessages.idemKey],
    })
    .returning({ id: agentMessages.id });
  const fresh = inserted[0];
  if (fresh) return { id: fresh.id, duplicate: false };

  const existing = await db
    .select({
      id: agentMessages.id,
      toRun: agentMessages.toRun,
      body: agentMessages.body,
    })
    .from(agentMessages)
    .where(and(eq(agentMessages.fromRun, from), eq(agentMessages.idemKey, key)))
    .limit(1);
  const row = existing[0];
  if (!row) {
    throw new Error(`agent_messages (${from}, ${key}): conflict without a row`);
  }
  if (row.toRun !== to || row.body !== body) return { conflict: true };
  return { id: row.id, duplicate: true };
}

/**
 * Authorizes, stores and delivers one message. A refusal writes nothing. The
 * authorization runs on every call, retries included: a retry after the target
 * ended is refused even though the first send committed (the committed row is
 * still delivered by `receiveFor` / the sweeper).
 */
export async function sendMessage({
  db,
  organizationId,
  from,
  to,
  key,
  body,
  apply,
}: {
  db: DB;
  organizationId: string;
  from: string;
  to: string;
  key: string;
  body: string;
  apply: ApplyMessage;
}): Promise<SendResult> {
  const [fromRun, toRun] = await Promise.all([
    getRunForOrg({ db, organizationId, threadId: from }),
    getRunForOrg({ db, organizationId, threadId: to }),
  ]);
  if (!fromRun) return { ok: false, error: "not_found" };
  const verdict = authorizeSend(fromRun, toRun);
  if (verdict !== "ok") return { ok: false, error: verdict };

  const inserted = await insertMessage({ db, from, to, key, body });
  if ("conflict" in inserted) return { ok: false, error: "idem_key_conflict" };

  const { applied } = await receiveFor({ db, toRun: to, apply });
  return { ok: true, id: inserted.id, duplicate: inserted.duplicate, applied };
}

/**
 * Delivers every unconsumed message of `toRun`, oldest first, one transaction per
 * message. `apply` that throws rolls its transaction back (the message stays
 * unconsumed for the sweeper) and the error is rethrown.
 *
 * `unsafeApplyOutsideTransaction` is TEST-ONLY: it runs `apply` on the plain `db`
 * instead of the receive transaction, which is the negative control that proves
 * the transaction is what makes delivery exactly-once. Never set it in production.
 */
export async function receiveFor({
  db,
  toRun,
  apply,
  unsafeApplyOutsideTransaction = false,
}: {
  db: DB;
  toRun: string;
  apply: ApplyMessage;
  unsafeApplyOutsideTransaction?: boolean;
}): Promise<{ applied: number }> {
  let applied = 0;
  for (;;) {
    const outcome = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(agentMessages)
        .where(
          and(eq(agentMessages.toRun, toRun), isNull(agentMessages.consumedAt)),
        )
        .orderBy(asc(agentMessages.id))
        .limit(1)
        .for("update", { skipLocked: true });
      const row = rows[0];
      if (!row) return "empty" as const;

      const recorded = await tx
        .insert(agentApplied)
        .values({ msgId: row.id, run: toRun })
        .onConflictDoNothing()
        .returning({ msgId: agentApplied.msgId });
      let didApply = false;
      if (recorded.length > 0) {
        const message: AgentMessage = {
          id: row.id,
          fromRun: row.fromRun,
          toRun: row.toRun,
          body: row.body,
          createdAt: row.createdAt,
        };
        await apply(unsafeApplyOutsideTransaction ? db : tx, message);
        didApply = true;
      }
      await tx
        .update(agentMessages)
        .set({ consumedAt: sql`now()` })
        .where(eq(agentMessages.id, row.id));
      return didApply ? ("applied" as const) : ("skipped" as const);
    });
    if (outcome === "empty") return { applied };
    if (outcome === "applied") applied += 1;
  }
}

/** Distinct targets with a message consumed in the last `withinMs` (the sweeper's re-kick set). */
export async function recentlyDeliveredTargets({
  db,
  withinMs = 300_000,
}: {
  db: DB;
  withinMs?: number;
}): Promise<string[]> {
  const rows = await db
    .selectDistinct({ toRun: agentMessages.toRun })
    .from(agentMessages)
    .where(
      and(
        isNotNull(agentMessages.consumedAt),
        sql`${agentMessages.consumedAt} > now() - (${withinMs}::double precision * interval '1 millisecond')`,
      ),
    );
  return rows.map((r) => r.toRun);
}

/**
 * Safety net: delivers messages still unconsumed after `olderThanMs` (their
 * receive never ran). One target's failure is logged and does not stop the rest.
 */
export async function sweepUnconsumed({
  db,
  apply,
  olderThanMs = 10_000,
  limit = 100,
  logger = DEFAULT_LOGGER,
}: {
  db: DB;
  apply: ApplyMessage;
  olderThanMs?: number;
  limit?: number;
  logger?: BusLogger;
}): Promise<{ targets: string[]; applied: number }> {
  const rows = await db
    .selectDistinct({ toRun: agentMessages.toRun })
    .from(agentMessages)
    .where(
      and(
        isNull(agentMessages.consumedAt),
        sql`${agentMessages.createdAt} < now() - (${olderThanMs}::double precision * interval '1 millisecond')`,
      ),
    )
    .limit(limit);
  const targets: string[] = [];
  let applied = 0;
  for (const { toRun } of rows) {
    try {
      const result = await receiveFor({ db, toRun, apply });
      targets.push(toRun);
      applied += result.applied;
    } catch (error) {
      logger.error(`agent-bus sweep: delivery to ${toRun} failed`, error);
    }
  }
  return { targets, applied };
}

/**
 * The production apply: appends the message to the target run's primary chat
 * (oldest `thread_chat`) as ONE queued user message, framed with its sender so a
 * body starting with `/` is never taken for a slash command. Runs in the receive
 * transaction; the caller broadcasts and kicks after commit.
 */
export const queuedFollowUpApply: ApplyMessage = async (tx, message) => {
  const chats = await tx
    .select({ id: threadChat.id })
    .from(threadChat)
    .where(eq(threadChat.threadId, message.toRun))
    .orderBy(asc(threadChat.createdAt))
    .limit(1)
    .for("update");
  const primary = chats[0];
  if (!primary) {
    throw new Error(`agent bus: thread ${message.toRun} has no thread chat`);
  }
  const queued: DBUserMessage = {
    type: "user",
    model: null,
    parts: [
      {
        type: "text",
        text: `Message from agent run ${message.fromRun}:\n\n${message.body}`,
      },
    ],
    timestamp: new Date().toISOString(),
  };
  const json = JSON.stringify(sanitizeForJson([queued]));
  await tx
    .update(threadChat)
    .set({
      queuedMessages: sql`COALESCE(${threadChat.queuedMessages}, '[]'::jsonb) || ${json}::jsonb`,
    })
    .where(eq(threadChat.id, primary.id));
};
