import { createDb } from "../src/db";
import { env } from "@terragon/env/pkg-shared";
import { sql } from "drizzle-orm";

/**
 * #153 read-tear fix backfill. The generation fence reads terminalCause and
 * activeRunExternalId exclusively from the thread_chat row; both columns are
 * new mirrors of the thread row, stamped going forward by markThreadsTerminal
 * and setThreadActiveRun. A chat-mode thread that reached its (one-time)
 * terminal BEFORE the deploy never gets restamped, so without this backfill
 * its chat row reads terminalCause = NULL forever and a late daemon event is
 * wrongly ADMITTED — reopening the #125 C1 cancel race for historical rows.
 *
 * Copies each column from the thread row wherever the chat mirror is NULL
 * and the thread row has a value. Idempotent (the WHERE makes a rerun a
 * no-op) and safe to run before OR after the deploy: it never overwrites a
 * value the new writers already stamped.
 *
 * Run: pnpm tsx scripts/backfill-thread-chat-fence-mirrors.ts
 */
export async function backfillThreadChatFenceMirrors(
  db = createDb(env.DATABASE_URL!),
) {
  console.log("Backfilling thread_chat fence mirrors (#153)...");
  const result = await db.execute(sql`
    UPDATE thread_chat AS tc
    SET
      terminal_cause = COALESCE(tc.terminal_cause, t.terminal_cause),
      active_run_external_id = COALESCE(
        tc.active_run_external_id,
        t.active_run_external_id
      )
    FROM thread AS t
    WHERE tc.thread_id = t.id
      AND (
        (tc.terminal_cause IS NULL AND t.terminal_cause IS NOT NULL)
        OR (
          tc.active_run_external_id IS NULL
          AND t.active_run_external_id IS NOT NULL
        )
      )
  `);
  console.log(`Backfilled ${result.rowCount ?? 0} thread_chat rows`);
  return result.rowCount ?? 0;
}

// Run only when executed directly (keeps the module importable in tests).
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  backfillThreadChatFenceMirrors()
    .then(() => {
      console.log("Backfill completed successfully");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Backfill failed:", error);
      process.exit(1);
    });
}
