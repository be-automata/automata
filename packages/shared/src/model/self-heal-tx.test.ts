import { describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { sql } from "drizzle-orm";

import { createDb } from "../db";
import { SELF_HEAL_TX_TIMEOUTS, withSelfHealTx } from "./self-heal-tx";

const db = createDb(env.DATABASE_URL!);

function firstValue(result: unknown): string {
  const rows = (result as { rows: Record<string, string>[] }).rows;
  return Object.values(rows[0] ?? {})[0] ?? "";
}

describe("withSelfHealTx (RES-07)", () => {
  it("exports the documented ceilings", () => {
    expect(SELF_HEAL_TX_TIMEOUTS).toEqual({
      statementTimeoutMs: 3000,
      lockTimeoutMs: 1000,
      idleInTransactionTimeoutMs: 5000,
    });
  });

  it("sets statement and lock timeouts inside, not outside", async () => {
    const inside = await withSelfHealTx(db, async (tx) => ({
      statement: firstValue(await tx.execute(sql`SHOW statement_timeout`)),
      lock: firstValue(await tx.execute(sql`SHOW lock_timeout`)),
      idle: firstValue(
        await tx.execute(sql`SHOW idle_in_transaction_session_timeout`),
      ),
    }));
    expect(inside).toEqual({ statement: "3s", lock: "1s", idle: "5s" });
    const outside = firstValue(await db.execute(sql`SHOW statement_timeout`));
    expect(outside).not.toBe("3s");
  });

  it("aborts a statement past the timeout and rolls back earlier writes", async () => {
    const table = `tx_probe_${Math.random().toString(36).slice(2, 10)}`;
    await db.execute(sql.raw(`CREATE TABLE ${table} (id int)`));
    try {
      await expect(
        withSelfHealTx(db, async (tx) => {
          await tx.execute(sql.raw(`INSERT INTO ${table} VALUES (1)`));
          await tx.execute(sql`SELECT pg_sleep(4)`);
        }),
      ).rejects.toThrow();
      const count = firstValue(
        await db.execute(sql.raw(`SELECT count(*) FROM ${table}`)),
      );
      expect(count).toBe("0");
    } finally {
      await db.execute(sql.raw(`DROP TABLE ${table}`));
    }
  }, 15_000);

  it("applies overrides and rejects out-of-bounds ones before opening", async () => {
    const statement = await withSelfHealTx(
      db,
      async (tx) => firstValue(await tx.execute(sql`SHOW statement_timeout`)),
      { statementTimeoutMs: 10_000 },
    );
    expect(statement).toBe("10s");
    let ran = false;
    for (const bad of [0, 30_001, 1.5]) {
      await expect(
        withSelfHealTx(
          db,
          async () => {
            ran = true;
          },
          { lockTimeoutMs: bad },
        ),
      ).rejects.toThrow(RangeError);
    }
    expect(ran).toBe(false);
  });
});
