import { createDb, type DB } from "../../../db";
import {
  queuedFollowUpApply,
  receiveFor,
  sendMessage,
  type ApplyMessage,
} from "../messages";

/**
 * Child process of the #660 crash drill. It runs the real delivery path with the
 * production apply (`queuedFollowUpApply`) and may SIGKILL itself right after the
 * Nth apply: after the effect, before the receive transaction commits.
 *
 * Reads process.env.DATABASE_URL directly: `@terragon/env` falls back to the dev
 * database when it is unset, which a drill must never reach.
 *
 * Env: DATABASE_URL, MODE = receive | send (required);
 * receive: TO_RUN; send: ORG_ID, FROM, TO, KEY, BODY;
 * KILL_POINT = after-apply (optional), KILL_AT_APPLY = N (default 1);
 * UNSAFE = 1 (receive only: negative control, apply outside the transaction).
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Prints the sentinel the driver checks, so a spawn timeout cannot pass as a kill. */
function killSelf(point: string): never {
  process.stderr.write(`killing at ${point}\n`);
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable: SIGKILL did not end the process");
}

/** The production apply, killing the process after the Nth call when asked. */
function killingApply(db: DB): ApplyMessage {
  const killAt = Number(process.env.KILL_AT_APPLY ?? "1");
  let calls = 0;
  const outsideTransaction = process.env.UNSAFE === "1";
  return async (tx, message) => {
    // UNSAFE=1 (negative control): the effect runs on the plain db, not the
    // receive transaction, which proves the transaction is what makes it exactly-once.
    await queuedFollowUpApply(
      outsideTransaction ? (db as unknown as typeof tx) : tx,
      message,
    );
    calls += 1;
    if (process.env.KILL_POINT === "after-apply" && calls === killAt) {
      killSelf("after-apply");
    }
  };
}

async function main(): Promise<void> {
  const db = createDb(requireEnv("DATABASE_URL"));
  const apply = killingApply(db);
  const mode = requireEnv("MODE");
  let result: unknown;
  if (mode === "receive") {
    result = await receiveFor({
      db,
      toRun: requireEnv("TO_RUN"),
      apply,
    });
  } else if (mode === "send") {
    result = await sendMessage({
      db,
      organizationId: requireEnv("ORG_ID"),
      from: requireEnv("FROM"),
      to: requireEnv("TO"),
      key: requireEnv("KEY"),
      body: requireEnv("BODY"),
      apply,
    });
  } else {
    throw new Error(`unknown MODE ${mode}`);
  }
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
  await db.$client.end();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
