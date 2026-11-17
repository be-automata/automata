import { sql, type SQL } from "drizzle-orm";

import type { thread, threadChat } from "../db/schema";
import { sanitizeForJson } from "../utils/sanitize-json";

/**
 * `COALESCE(<column>, '[]') || <messages>` for a thread / thread_chat
 * `queued_messages` column. Its own module (type-only schema import) so the
 * agent bus, which also runs in a bare-node child, does not pull in `threads.ts`.
 */
export function appendQueuedMessagesSql(
  column: typeof thread.queuedMessages | typeof threadChat.queuedMessages,
  messages: unknown[],
): SQL {
  return sql`COALESCE(${column}, '[]'::jsonb) || ${JSON.stringify(sanitizeForJson(messages))}::jsonb`;
}
