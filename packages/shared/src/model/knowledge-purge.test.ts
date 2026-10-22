import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { createDb, type DB } from "../db";
import * as schema from "../db/schema";
import {
  KNOWLEDGE_PURGE_GRACE_MS,
  clearKnowledgeOffboard,
  offboardKnowledge,
} from "./knowledge-controls";
import {
  KnowledgeNotOffboardedError,
  listKnowledgeOrgsDueForPurge,
  purgeKnowledgeData,
} from "./knowledge-purge";
import { createTestOrg, createTestUser } from "./test-helpers";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-22T12:00:00Z");

describe("knowledge purge", () => {
  let db: DB;
  let userId: string;
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    db = createDb(process.env.DATABASE_URL!);
    const { user } = await createTestUser({ db });
    userId = user.id;
    orgA = await createTestOrg({ db, name: "Acme" });
    orgB = await createTestOrg({ db, name: "Globex" });
  });

  async function seed(organizationId: string): Promise<string[]> {
    const claimIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = `claim-${nanoid(8)}`;
      claimIds.push(id);
      await db.insert(schema.knowledgeClaim).values({
        id,
        organizationId,
        repoFullName: "acme/api",
        page: `page-${i}`,
        statement: "The service uses queues.",
      });
      await db.insert(schema.knowledgePin).values({
        organizationId,
        claimId: id,
        repoFullName: "acme/api",
        uri: `src/file-${i}.ts`,
        hash: "h",
        observedRev: "r",
      });
    }
    const opIds = [`op-${nanoid(8)}`, `op-${nanoid(8)}`];
    for (const [i, id] of opIds.entries()) {
      await db.insert(schema.knowledgeOp).values({
        id,
        organizationId,
        claimId: claimIds[i]!,
        repoFullName: "acme/api",
        kind: "update",
        baseVersion: 1,
        proposal: {},
        mergeRev: "m",
      });
    }
    await db.insert(schema.knowledgeDecision).values({
      organizationId,
      opId: opIds[0]!,
      repoFullName: "acme/api",
      actorUserId: userId,
      route: "org",
      choice: "approve",
    });
    await db.insert(schema.knowledgeCursor).values({
      organizationId,
      repoFullName: "acme/api",
      defaultBranch: "main",
    });
    await db.insert(schema.knowledgeIntent).values({
      id: `intent-${nanoid(8)}`,
      organizationId,
      repoFullName: "acme/api",
      defaultBranch: "main",
      targetSha: "a".repeat(40),
    });
    await db.insert(schema.knowledgeUsageWindow).values({
      organizationId,
      windowStart: new Date("2026-10-01T00:00:00Z"),
      capMicroUsd: 100,
    });
    await db.insert(schema.knowledgeAdminLog).values({
      organizationId,
      actorUserId: userId,
      action: "engine_toggle",
    });
    return claimIds;
  }

  async function snapshot(organizationId: string) {
    const t = schema;
    return {
      claims: await db
        .select()
        .from(t.knowledgeClaim)
        .where(eq(t.knowledgeClaim.organizationId, organizationId)),
      pins: await db
        .select()
        .from(t.knowledgePin)
        .where(eq(t.knowledgePin.organizationId, organizationId)),
      ops: await db
        .select()
        .from(t.knowledgeOp)
        .where(eq(t.knowledgeOp.organizationId, organizationId)),
      decisions: await db
        .select()
        .from(t.knowledgeDecision)
        .where(eq(t.knowledgeDecision.organizationId, organizationId)),
      cursors: await db
        .select()
        .from(t.knowledgeCursor)
        .where(eq(t.knowledgeCursor.organizationId, organizationId)),
      intents: await db
        .select()
        .from(t.knowledgeIntent)
        .where(eq(t.knowledgeIntent.organizationId, organizationId)),
      usage: await db
        .select()
        .from(t.knowledgeUsageWindow)
        .where(eq(t.knowledgeUsageWindow.organizationId, organizationId)),
      log: await db
        .select()
        .from(t.knowledgeAdminLog)
        .where(eq(t.knowledgeAdminLog.organizationId, organizationId)),
    };
  }

  async function markOffboarded(organizationId: string, at: Date) {
    await offboardKnowledge({
      db,
      organizationId,
      actorUserId: userId,
      now: at,
    });
  }

  it("purges only the offboarded org and retains usage and log rows", async () => {
    await seed(orgA);
    await seed(orgB);
    await markOffboarded(orgA, new Date(NOW.getTime() - 8 * DAY));
    const beforeB = await snapshot(orgB);

    const counts = await purgeKnowledgeData({
      db,
      organizationId: orgA,
      now: NOW,
    });
    expect(counts).toEqual({
      claims: 2,
      pins: 2,
      ops: 2,
      decisions: 1,
      cursors: 1,
      intents: 1,
    });
    const afterA = await snapshot(orgA);
    expect(afterA.claims).toHaveLength(0);
    expect(afterA.pins).toHaveLength(0);
    expect(afterA.ops).toHaveLength(0);
    expect(afterA.decisions).toHaveLength(0);
    expect(afterA.cursors).toHaveLength(0);
    expect(afterA.intents).toHaveLength(0);
    expect(afterA.usage).toHaveLength(1);
    expect(afterA.log.length).toBeGreaterThanOrEqual(1);
    const [row] = await db
      .select()
      .from(schema.organizationReviewSettings)
      .where(eq(schema.organizationReviewSettings.organizationId, orgA));
    expect(row?.knowledgePurgedAt).toEqual(NOW);
    expect(await snapshot(orgB)).toEqual(beforeB);
  });

  it("a second purge is a no-op with zero counts", async () => {
    await seed(orgA);
    await markOffboarded(orgA, new Date(NOW.getTime() - 8 * DAY));
    await purgeKnowledgeData({ db, organizationId: orgA, now: NOW });
    expect(
      await purgeKnowledgeData({ db, organizationId: orgA, now: NOW }),
    ).toEqual({
      claims: 0,
      pins: 0,
      ops: 0,
      decisions: 0,
      cursors: 0,
      intents: 0,
    });
  });

  it("refuses an org that is not offboarded and deletes nothing", async () => {
    await seed(orgA);
    await expect(
      purgeKnowledgeData({ db, organizationId: orgA }),
    ).rejects.toBeInstanceOf(KnowledgeNotOffboardedError);
    await offboardKnowledge({ db, organizationId: orgA, actorUserId: userId });
    await clearKnowledgeOffboard({
      db,
      organizationId: orgA,
      actorUserId: userId,
    });
    await expect(
      purgeKnowledgeData({ db, organizationId: orgA }),
    ).rejects.toBeInstanceOf(KnowledgeNotOffboardedError);
    expect((await snapshot(orgA)).claims).toHaveLength(2);
  });

  it("deletes a stray row of the org that points at another org's claim", async () => {
    await seed(orgA);
    const claimsB = await seed(orgB);
    await db.insert(schema.knowledgePin).values({
      organizationId: orgA,
      claimId: claimsB[0]!,
      repoFullName: "acme/api",
      uri: "stray.ts",
      hash: "h",
      observedRev: "r",
    });
    await markOffboarded(orgA, new Date(NOW.getTime() - 8 * DAY));
    const counts = await purgeKnowledgeData({
      db,
      organizationId: orgA,
      now: NOW,
    });
    expect(counts.pins).toBe(3);
    expect((await snapshot(orgA)).pins).toHaveLength(0);
    expect((await snapshot(orgB)).pins).toHaveLength(2);
  });

  describe("listKnowledgeOrgsDueForPurge", () => {
    const setMarks = (
      organizationId: string,
      offboardedAt: Date | null,
      purgedAt: Date | null,
    ) =>
      db
        .insert(schema.organizationReviewSettings)
        .values({
          organizationId,
          knowledgeOffboardedAt: offboardedAt,
          knowledgePurgedAt: purgedAt,
        })
        .onConflictDoUpdate({
          target: [schema.organizationReviewSettings.organizationId],
          set: {
            knowledgeOffboardedAt: offboardedAt,
            knowledgePurgedAt: purgedAt,
          },
        });
    const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
    const due = async (limit?: number) => {
      const ids = await listKnowledgeOrgsDueForPurge({ db, now: NOW, limit });
      return ids.filter((id) => [orgA, orgB, orgC].includes(id));
    };
    let orgC: string;
    beforeEach(async () => {
      orgC = await createTestOrg({ db, name: "Initech" });
    });

    it("lists 8-day-old marks, not 6-day-old ones", async () => {
      expect(KNOWLEDGE_PURGE_GRACE_MS).toBe(7 * DAY);
      await setMarks(orgA, ago(8), null);
      await setMarks(orgB, ago(6), null);
      expect(await due()).toEqual([orgA]);
    });

    it("skips purged marks, relists a re-offboarded org, ignores never-offboarded", async () => {
      await setMarks(orgA, ago(8), ago(1));
      await setMarks(orgB, ago(8), ago(20));
      await setMarks(orgC, null, null);
      expect(await due()).toEqual([orgB]);
    });

    it("orders oldest mark first and respects the limit", async () => {
      await setMarks(orgA, ago(9), null);
      await setMarks(orgB, ago(12), null);
      await setMarks(orgC, ago(10), null);
      const all = await listKnowledgeOrgsDueForPurge({
        db,
        now: NOW,
        limit: 1000,
      });
      const mine = all.filter((id) => [orgA, orgB, orgC].includes(id));
      expect(mine).toEqual([orgB, orgC, orgA]);
      expect(
        await listKnowledgeOrgsDueForPurge({ db, now: NOW, limit: 1 }),
      ).toHaveLength(1);
    });
  });
});
