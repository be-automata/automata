import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createDb } from "../../db";
import { runEffect, type EffectTarget } from "../control-effects";

/**
 * Child process of the #652 crash drill. It delivers one effect against a
 * file-backed fake target (one file per apply, holding the effect key as its
 * marker, so it survives SIGKILL) and may SIGKILL itself at a kill point.
 *
 * Reads process.env.DATABASE_URL directly: `@terragon/env` falls back to the dev
 * database when it is unset, which a drill must never reach.
 *
 * Env: DATABASE_URL, CRASH_DIR, ORG_ID, MISSION, OUTPUT_DIGEST (required);
 * KILL_POINT = before-apply | after-apply (optional);
 * NO_RECONCILE = 1 (negative control: findByMarker always answers false).
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

/**
 * One file per apply, holding the key as its marker. `killPoint` SIGKILLs the
 * process around the write; `reconcile: false` makes findByMarker answer false.
 */
function fileTarget(
  dir: string,
  opts: { killPoint?: string; reconcile: boolean },
): EffectTarget<string> {
  return {
    async apply(key) {
      if (opts.killPoint === "before-apply") killSelf("before-apply");
      writeFileSync(join(dir, `${randomUUID()}.marker`), key);
      if (opts.killPoint === "after-apply") killSelf("after-apply");
    },
    async findByMarker(key) {
      if (!opts.reconcile) return false;
      return readdirSync(dir).some(
        (name) => readFileSync(join(dir, name), "utf8") === key,
      );
    },
  };
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const db = createDb(databaseUrl);
  const target = fileTarget(requireEnv("CRASH_DIR"), {
    killPoint: process.env.KILL_POINT,
    reconcile: process.env.NO_RECONCILE !== "1",
  });
  const result = await runEffect({
    db,
    target,
    organizationId: requireEnv("ORG_ID"),
    mission: requireEnv("MISSION"),
    step: "summary",
    effect: "post",
    outputDigest: requireEnv("OUTPUT_DIGEST"),
    payload: "body",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  await db.$client.end();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
