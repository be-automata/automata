import { exists, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";

import { thread, threadChat } from "../db/schema";
import type { ThreadStatus } from "../db/types";

/**
 * SQL predicate: the thread's EFFECTIVE status is one of `statuses`. A legacy
 * thread carries it on the thread row; a chat-mode thread
 * (enableThreadChatCreation) carries it on its threadChat row(s) while the
 * thread row keeps its creation value. Every reaper/sweep predicate on
 * "thread status" must use this, or chat-mode threads are invisible to it.
 */
export function threadEffectiveStatusIn(statuses: ThreadStatus[]) {
  return or(
    inArray(thread.status, statuses),
    exists(selectChatStatus(statuses)),
  );
}

function selectChatStatus(statuses: ThreadStatus[]) {
  return sql`(select 1 from ${threadChat} where ${threadChat.threadId} = ${thread.id} and ${threadChat.status} in (${sql.join(
    statuses.map((s) => sql`${s}`),
    sql`, `,
  )}))`;
}

/**
 * SQL expression: the thread's EFFECTIVE last write — the later of the thread
 * row's `updatedAt` and its threadChat rows' (a chat-mode thread moves to
 * `booting` on a retry/follow-up through the chat row only; the thread row
 * is touched later, best effort). Every sweep age anchor and compare-and-set
 * fence on "when was this thread last written" must use this, or a chat-mode
 * thread re-dispatched moments ago looks as old as its previous attempt
 * (#380 rule (iii), the rule (i) generation guard, markThreadsTerminal).
 * Decoded as a Date like `thread.updatedAt`.
 */
export function threadLastWriteAt() {
  return sql<Date>`greatest(${thread.updatedAt}, coalesce((select max(${threadChat.updatedAt}) from ${threadChat} where ${threadChat.threadId} = ${thread.id}), ${thread.updatedAt}))`.mapWith(
    thread.updatedAt,
  );
}

/**
 * A Date bound for comparing against `threadLastWriteAt()`. With an SQL
 * expression on the left, drizzle does not run the right-hand Date through a
 * column's encoder, so the driver would send LOCAL wall-clock time against a
 * `timestamp without time zone` column — hours off on any non-UTC host.
 * Encoded exactly as a `thread.updatedAt` parameter is.
 */
export function threadTimestampParam(at: Date) {
  return sql.param(at, thread.updatedAt);
}

/** Effective statuses after which a self-heal thread can no longer use the box or report. */
export const TERMINAL_THREAD_STATUSES: ThreadStatus[] = [
  "complete",
  "stopped",
  "error",
  "working-stopped",
];

/**
 * The thread is terminal: a typed terminal cause, or a terminal status on the
 * thread row or on any of its threadChat rows. Column refs are
 * table-qualified, so the predicate also works inside a subquery or an
 * ON CONFLICT DO UPDATE ... WHERE.
 */
export function threadIsTerminal(): SQL {
  return sql`(${isNotNull(thread.terminalCause)} or ${threadEffectiveStatusIn(TERMINAL_THREAD_STATUSES)})`;
}

/**
 * The thread's effective status as a column: its newest thread chat's status,
 * else the thread row's (chat-mode threads keep status on threadChat).
 */
export function threadEffectiveStatusSql(): SQL<ThreadStatus> {
  return sql<ThreadStatus>`COALESCE((select ${threadChat.status} from ${threadChat} where ${threadChat.threadId} = ${thread.id} order by ${threadChat.updatedAt} desc limit 1), ${thread.status})`;
}

/** The error message that goes with threadEffectiveStatusSql(). */
export function threadEffectiveErrorSql(): SQL<string | null> {
  return sql<
    string | null
  >`COALESCE((select ${threadChat.errorMessage} from ${threadChat} where ${threadChat.threadId} = ${thread.id} order by ${threadChat.updatedAt} desc limit 1), ${thread.errorMessage})`;
}
