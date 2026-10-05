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
