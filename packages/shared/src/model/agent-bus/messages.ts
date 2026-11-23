import { createValueRedactor } from "@terragon/utils/redact";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { DB } from "../../db";
import {
  agentApplied,
  agentMessages,
  thread,
  threadChat,
} from "../../db/schema";
import type { DBUserMessage } from "../../db/db-message";
import { sanitizeForJson } from "../../utils/sanitize-json";
import { appendQueuedMessagesSql } from "../queued-messages-sql";
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
 *
 * Poison messages (#758): the apply runs in a savepoint, so a throw rolls back only
 * the apply and its `agent_applied` row. The failure is then counted on the message
 * (`attempts`, `last_error`) and committed. A message that fails
 * `AGENT_MESSAGE_MAX_ATTEMPTS` times is dead-lettered (`dead_lettered_at`): it stays
 * unconsumed, is never claimed again, and no longer blocks its target.
 */

/** Failed apply attempts after which a message is dead-lettered (#758). */
export const AGENT_MESSAGE_MAX_ATTEMPTS = 5;

/** Longest `last_error` stored, in UTF-16 units. */
const LAST_ERROR_MAX_LENGTH = 500;

/** A message that can still be delivered: not consumed and not dead-lettered. */
const deliverable = and(
  isNull(agentMessages.consumedAt),
  isNull(agentMessages.deadLetteredAt),
);

/** The error's name for logs; a throwing getter must not turn a log line into a failure. */
function errorNameOf(error: unknown): string {
  try {
    return error instanceof Error ? error.name : typeof error;
  } catch {
    return "<unprintable>";
  }
}

export interface AgentMessage {
  id: number;
  fromRun: string;
  toRun: string;
  body: string;
  createdAt: Date;
}

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/** Runs INSIDE the receive transaction. */
export type ApplyMessage = (tx: Tx, message: AgentMessage) => Promise<void>;

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
  // Store (and compare) the sanitized body: Postgres text refuses NUL, and a
  // retry must see the same stored value, so the A1 check never flaps.
  const stored = sanitizeForJson(body);
  const inserted = await db
    .insert(agentMessages)
    .values({ idemKey: key, fromRun: from, toRun: to, body: stored })
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
  if (row.toRun !== to || row.body !== stored) return { conflict: true };
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
  logger = DEFAULT_LOGGER,
}: {
  db: DB;
  organizationId: string;
  from: string;
  to: string;
  key: string;
  body: string;
  apply: ApplyMessage;
  logger?: BusLogger;
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

  // The insert is committed: a delivery failure must not turn into a rejected
  // send (the caller would retry a message that is already stored). The row
  // stays unconsumed for the next receive / the sweeper. Log no body or PII.
  let applied = 0;
  try {
    await receiveFor({
      db,
      toRun: to,
      apply,
      logger,
      onApplied: (count) => {
        applied = count;
      },
    });
  } catch (error) {
    logger.error(
      "agent-bus send: delivery failed after the message committed",
      {
        messageId: inserted.id,
        toRun: to,
        errorName: errorNameOf(error),
      },
    );
  }
  return { ok: true, id: inserted.id, duplicate: inserted.duplicate, applied };
}

/**
 * Builds `last_error`: `"<name>: <message>"`, the message body redacted (and any
 * secret pattern), truncated to 500 units, then sanitized (no NUL bytes). Truncating
 * before sanitizing never leaves a lone surrogate.
 */
function buildLastError(error: unknown, body: string): string {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    // A thrown value with a throwing getter or no toString (Object.create(null))
    // must never turn the attempt count into a second failure.
    message = "<unprintable>";
  }
  const text = `${errorNameOf(error)}: ${message}`;
  // minLength 1: any non-empty body is redacted (the shared default skips values under 4).
  const redact = createValueRedactor(body.length > 0 ? [body] : [], 1);
  return sanitizeForJson(redact(text).slice(0, LAST_ERROR_MAX_LENGTH));
}

type ReceiveOutcome =
  | { kind: "empty" }
  | { kind: "applied" }
  | { kind: "skipped" }
  | {
      kind: "failed";
      error: unknown;
      messageId: number;
      fromRun: string;
      attempts: number;
      deadLettered: boolean;
    };

/**
 * Delivers every unconsumed, not dead-lettered message of `toRun`, oldest first,
 * one transaction per message. The `agent_applied` insert and `apply` run in a
 * savepoint. When `apply` throws, the savepoint rolls back (no `agent_applied` row,
 * no partial effect) and, still holding the row lock, ONE update counts the attempt
 * (`attempts`, `last_error`) and dead-letters the row once `attempts` reaches
 * `AGENT_MESSAGE_MAX_ATTEMPTS`. That commits, then:
 * - below the cap the original error is rethrown (strict FIFO: the failing message
 *   still blocks later ones, and the sweeper retries it);
 * - at the cap one `logger.error` is emitted and the loop moves on to the next
 *   message, so the target is unblocked. Dead-lettered messages count in
 *   `deadLettered`.
 *
 * A crash before that commit counts no attempt: we under-count, never over-count,
 * and never apply twice. `onApplied` and `onDeadLettered` report the running
 * counts as they change, so a caller still knows the partial counts when a later
 * message's error is rethrown.
 * `__testOnAttemptRecorded` is a test hook, called inside the transaction after the
 * attempt update and before COMMIT; it is not part of the bus contract.
 *
 * Each transaction locks the target thread row before claiming a message, so
 * concurrent receivers serialize per target and the queue order is id order. A
 * missing target thread has no row to lock, so there receivers can count attempts
 * on different messages in parallel and FIFO is not guaranteed.
 */
export async function receiveFor({
  db,
  toRun,
  apply,
  onApplied,
  onDeadLettered,
  logger = DEFAULT_LOGGER,
  __testOnAttemptRecorded,
}: {
  db: DB;
  toRun: string;
  apply: ApplyMessage;
  onApplied?: (applied: number) => void;
  onDeadLettered?: (deadLettered: number) => void;
  logger?: BusLogger;
  __testOnAttemptRecorded?: (info: {
    messageId: number;
    attempts: number;
    deadLettered: boolean;
  }) => void | Promise<void>;
}): Promise<{ applied: number; deadLettered: number }> {
  let applied = 0;
  let deadLettered = 0;
  for (;;) {
    const outcome = await db.transaction(
      async (tx): Promise<ReceiveOutcome> => {
        // A missing thread has no row to lock: proceed (the apply refuses it).
        await tx
          .select({ id: thread.id })
          .from(thread)
          .where(eq(thread.id, toRun))
          // NO KEY UPDATE: serializes receivers per target without blocking inserts
          // that reference the thread (they take KEY SHARE).
          .for("no key update");
        const rows = await tx
          .select()
          .from(agentMessages)
          .where(and(eq(agentMessages.toRun, toRun), deliverable))
          .orderBy(asc(agentMessages.id))
          .limit(1)
          .for("update", { skipLocked: true });
        const row = rows[0];
        if (!row) return { kind: "empty" };

        let wasNew: boolean;
        try {
          wasNew = await tx.transaction(async (savepoint) => {
            const recorded = await savepoint
              .insert(agentApplied)
              .values({ msgId: row.id, run: toRun })
              .onConflictDoNothing()
              .returning({ msgId: agentApplied.msgId });
            const isNew = recorded.length > 0;
            if (isNew) await apply(savepoint, row);
            return isNew;
          });
        } catch (error) {
          const [counted] = await tx
            .update(agentMessages)
            .set({
              attempts: sql`${agentMessages.attempts} + 1`,
              lastError: buildLastError(error, row.body),
              deadLetteredAt: sql`CASE WHEN ${agentMessages.attempts} + 1 >= ${AGENT_MESSAGE_MAX_ATTEMPTS} THEN now() END`,
            })
            .where(eq(agentMessages.id, row.id))
            .returning({
              attempts: agentMessages.attempts,
              deadLetteredAt: agentMessages.deadLetteredAt,
            });
          if (!counted) throw error;
          const info = {
            messageId: row.id,
            attempts: counted.attempts,
            deadLettered: counted.deadLetteredAt !== null,
          };
          await __testOnAttemptRecorded?.(info);
          return { kind: "failed", error, fromRun: row.fromRun, ...info };
        }
        await tx
          .update(agentMessages)
          .set({ consumedAt: sql`now()` })
          .where(eq(agentMessages.id, row.id));
        return { kind: wasNew ? "applied" : "skipped" };
      },
    );
    if (outcome.kind === "empty") return { applied, deadLettered };
    if (outcome.kind === "applied") {
      applied += 1;
      onApplied?.(applied);
    }
    if (outcome.kind === "failed") {
      if (!outcome.deadLettered) throw outcome.error;
      deadLettered += 1;
      onDeadLettered?.(deadLettered);
      logger.error("agent-bus: message dead-lettered", {
        messageId: outcome.messageId,
        fromRun: outcome.fromRun,
        toRun,
        attempts: outcome.attempts,
        errorName: errorNameOf(outcome.error),
      });
    }
  }
}

/** Distinct targets with a message consumed in the last `withinMs` (the sweeper's re-kick set). */
export async function recentlyDeliveredTargets({
  db,
  withinMs = 120_000,
  limit = 200,
}: {
  db: DB;
  withinMs?: number;
  limit?: number;
}): Promise<string[]> {
  const rows = await db
    .select({ toRun: agentMessages.toRun })
    .from(agentMessages)
    .where(
      and(
        isNotNull(agentMessages.consumedAt),
        sql`${agentMessages.consumedAt} > now() - (${withinMs}::double precision * interval '1 millisecond')`,
      ),
    )
    .groupBy(agentMessages.toRun)
    .orderBy(desc(sql`max(${agentMessages.consumedAt})`))
    .limit(limit);
  return rows.map((r) => r.toRun);
}

/**
 * Safety net: delivers messages still unconsumed after `olderThanMs` (their
 * receive never ran). Dead-lettered messages are not selected, so poison targets
 * leave the top `limit` after at most `AGENT_MESSAGE_MAX_ATTEMPTS` ticks. One
 * target's failure is logged (error name only) and does not stop the rest;
 * `deadLettered` sums the messages dead-lettered during this pass. A target whose
 * receive applied a message and then failed on a later one still counts, and is
 * still returned in `targets`.
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
}): Promise<{ targets: string[]; applied: number; deadLettered: number }> {
  // Inner join: a row whose target thread is gone is inert, not a poison target.
  const rows = await db
    .select({ toRun: agentMessages.toRun })
    .from(agentMessages)
    .innerJoin(thread, eq(thread.id, agentMessages.toRun))
    .where(
      and(
        deliverable,
        sql`${agentMessages.createdAt} < now() - (${olderThanMs}::double precision * interval '1 millisecond')`,
      ),
    )
    .groupBy(agentMessages.toRun)
    .orderBy(asc(sql`min(${agentMessages.createdAt})`))
    .limit(limit);
  const targets: string[] = [];
  let applied = 0;
  let deadLettered = 0;
  for (const { toRun } of rows) {
    // Counted through the callbacks, so a receive that applies or dead-letters
    // some messages and then fails on a later one still reports them.
    let targetApplied = 0;
    let targetDeadLettered = 0;
    try {
      await receiveFor({
        db,
        toRun,
        apply,
        logger,
        onApplied: (count) => {
          targetApplied = count;
        },
        onDeadLettered: (count) => {
          targetDeadLettered = count;
        },
      });
    } catch (error) {
      logger.error(`agent-bus sweep: delivery to ${toRun} failed`, {
        toRun,
        errorName: errorNameOf(error),
      });
    }
    // Only targets that actually received a message (the caller broadcasts for them).
    if (targetApplied > 0) targets.push(toRun);
    applied += targetApplied;
    deadLettered += targetDeadLettered;
  }
  return { targets, applied, deadLettered };
}

/**
 * The production apply: appends the message to the target run's primary chat
 * (oldest `thread_chat`) as ONE queued user message, framed with its sender so a
 * body starting with `/` is never taken for a slash command. A legacy thread
 * (no `thread_chat` row; `enableThreadChatCreation` is off by default) queues on
 * `thread.queued_messages` instead. Runs in the receive transaction; the caller
 * broadcasts and kicks after commit. Throws only when the thread is missing.
 */
export const queuedFollowUpApply: ApplyMessage = async (tx, message) => {
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
  const chat = await tx
    .update(threadChat)
    .set({
      queuedMessages: appendQueuedMessagesSql(threadChat.queuedMessages, [
        queued,
      ]),
    })
    .where(
      eq(
        threadChat.id,
        sql`(SELECT id FROM thread_chat WHERE thread_id = ${message.toRun} ORDER BY created_at ASC LIMIT 1)`,
      ),
    )
    .returning({ id: threadChat.id });
  if (chat.length > 0) return;
  const legacy = await tx
    .update(thread)
    .set({
      queuedMessages: appendQueuedMessagesSql(thread.queuedMessages, [queued]),
    })
    .where(eq(thread.id, message.toRun))
    .returning({ id: thread.id });
  if (legacy.length === 0) {
    throw new Error(`agent bus: thread ${message.toRun} not found`);
  }
};
