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

function killSelf(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable: SIGKILL did not end the process");
}

function fileTarget(dir: string): EffectTarget<string> {
  return {
    async apply(key) {
      writeFileSync(join(dir, `${randomUUID()}.marker`), key);
    },
    async findByMarker(key) {
      return readdirSync(dir).some(
        (name) => readFileSync(join(dir, name), "utf8") === key,
      );
    },
  };
}

function withKillPoint(
  inner: EffectTarget<string>,
  killPoint: string | undefined,
): EffectTarget<string> {
  return {
    findByMarker: (key) => inner.findByMarker(key),
    async apply(key, payload) {
      if (killPoint === "before-apply") killSelf();
      await inner.apply(key, payload);
      if (killPoint === "after-apply") killSelf();
    },
  };
}

function withoutReconcile(inner: EffectTarget<string>): EffectTarget<string> {
  return { apply: inner.apply, findByMarker: async () => false };
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const db = createDb(databaseUrl);
  let target = withKillPoint(
    fileTarget(requireEnv("CRASH_DIR")),
    process.env.KILL_POINT,
  );
  if (process.env.NO_RECONCILE === "1") target = withoutReconcile(target);
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
