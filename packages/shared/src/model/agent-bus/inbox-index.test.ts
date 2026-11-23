import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../../db";
import { agentMessages } from "../../db/schema";
import { AGENT_MESSAGE_MAX_ATTEMPTS } from "./messages";

const db = createDb(env.DATABASE_URL!);

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function indexNames(node: PlanNode): string[] {
  return [
    ...(node["Index Name"] ? [node["Index Name"]] : []),
    ...(node.Plans ?? []).flatMap(indexNames),
  ];
}

/**
 * #767: the inbox index holds deliverable rows only
 * (`consumed_at IS NULL AND dead_lettered_at IS NULL`), so the receiveFor claim
 * no longer walks past dead-lettered rows.
 */
describe("agent_messages_inbox_deliverable (#767)", () => {
  it("is partial on the deliverable predicate, and the old inbox index is gone", async () => {
    const result = await db.execute<{ name: string; predicate: string | null }>(
      sql`SELECT c.relname AS name, pg_get_expr(ix.indpred, ix.indrelid) AS predicate
            FROM pg_index ix
            JOIN pg_class c ON c.oid = ix.indexrelid
           WHERE ix.indrelid = 'agent_messages'::regclass
             AND c.relname IN ('agent_messages_inbox', 'agent_messages_inbox_deliverable')`,
    );
    expect(result.rows).toEqual([
      {
        name: "agent_messages_inbox_deliverable",
        predicate: "((consumed_at IS NULL) AND (dead_lettered_at IS NULL))",
      },
    ]);
  });

  it("serves the receiveFor claim with dead-lettered rows ahead of the deliverable one", async () => {
    const toRun = `inbox-index-${randomUUID()}`;
    const fromRun = `inbox-index-sender-${randomUUID()}`;
    // Three dead-lettered rows sort before the deliverable one by id; one consumed row.
    await db.insert(agentMessages).values([
      ...[0, 1, 2].map((i) => ({
        idemKey: `dead-${i}`,
        fromRun,
        toRun,
        body: "poison",
        attempts: AGENT_MESSAGE_MAX_ATTEMPTS,
        deadLetteredAt: new Date(),
      })),
      {
        idemKey: "consumed",
        fromRun,
        toRun,
        body: "done",
        consumedAt: new Date(),
      },
      { idemKey: "live", fromRun, toRun, body: "live" },
    ]);

    await db.transaction(async (tx) => {
      // The test table is tiny: keep the planner off a sequential scan so the
      // plan shows which index the claim can use.
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      // The claim of receiveFor (messages.ts), as drizzle emits it.
      const claim = sql`SELECT "id" FROM "agent_messages"
          WHERE ("agent_messages"."to_run" = ${toRun}
                 AND "agent_messages"."consumed_at" IS NULL
                 AND "agent_messages"."dead_lettered_at" IS NULL)
          ORDER BY "agent_messages"."id" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`;
      const explained = await tx.execute<{
        "QUERY PLAN": [{ Plan: PlanNode }];
      }>(sql`EXPLAIN (FORMAT JSON) ${claim}`);
      const plan = explained.rows[0]?.["QUERY PLAN"][0]?.Plan;
      expect(plan).toBeDefined();
      expect(indexNames(plan as PlanNode)).toEqual([
        "agent_messages_inbox_deliverable",
      ]);

      // Through that index, the target's whole inbox is the one deliverable row:
      // an index-only count sees no dead-lettered or consumed row.
      const counted = await tx.execute<{
        "QUERY PLAN": [{ Plan: PlanNode & { "Actual Rows": number } }];
      }>(
        sql`EXPLAIN (ANALYZE, FORMAT JSON)
            SELECT "id" FROM "agent_messages"
             WHERE "to_run" = ${toRun}
               AND "consumed_at" IS NULL AND "dead_lettered_at" IS NULL`,
      );
      const scan = counted.rows[0]?.["QUERY PLAN"][0]?.Plan;
      expect(scan?.["Index Name"]).toBe("agent_messages_inbox_deliverable");
      expect(scan?.["Actual Rows"]).toBe(1);
    });

    const claimed = await db.execute<{ idem_key: string }>(
      sql`SELECT "idem_key" FROM "agent_messages"
           WHERE "to_run" = ${toRun} AND "consumed_at" IS NULL AND "dead_lettered_at" IS NULL
           ORDER BY "id" ASC LIMIT 1`,
    );
    expect(claimed.rows).toEqual([{ idem_key: "live" }]);
  });
});
