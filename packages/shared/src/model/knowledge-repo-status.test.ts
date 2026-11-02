import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { createDb, type DB } from "../db";
import * as schema from "../db/schema";
import { forKnowledge } from "./knowledge-access";
import {
  isKnowledgeRepoPendingValidation,
  listKnowledgeRepoStatus,
  recordKnowledgePush,
  retryKnowledgeIntent,
} from "./knowledge-repo-status";
import { createTestOrg, createTestUser } from "./test-helpers";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const REPO = "acme/docs";

describe("knowledge repo status", () => {
  let db: DB;
  let orgA: string;
  let orgB: string;
  let actor: string;

  beforeEach(async () => {
    db = createDb(process.env.DATABASE_URL!);
    orgA = await createTestOrg({ db, name: "Acme" });
    orgB = await createTestOrg({ db, name: "Globex" });
    actor = (await createTestUser({ db })).user.id;
  });

  const push = (organizationId: string, targetSha: string, now = new Date()) =>
    recordKnowledgePush({
      db,
      organizationId,
      repoFullName: REPO,
      defaultBranch: "main",
      targetSha,
      now,
    });

  const cursorOf = async (organizationId: string) =>
    (
      await db
        .select()
        .from(schema.knowledgeCursor)
        .where(eq(schema.knowledgeCursor.organizationId, organizationId))
    )[0];

  describe("recordKnowledgePush", () => {
    it("writes the intent, the observed head and last_push_at", async () => {
      const t1 = new Date("2026-11-02T10:00:00Z");
      const res = await push(orgA, SHA, t1);
      expect(res).toEqual({
        intentId: `intent:${orgA}:${REPO}@${SHA}`,
        inserted: true,
      });
      const [intent] = await db
        .select()
        .from(schema.knowledgeIntent)
        .where(eq(schema.knowledgeIntent.id, res.intentId));
      expect(intent?.state).toBe("pending");
      const cursor = await cursorOf(orgA);
      expect(cursor?.observedHeadSha).toBe(SHA);
      expect(cursor?.lastSha).toBeNull();
      expect(cursor?.lastPushAt?.getTime()).toBe(t1.getTime());
    });

    it("a redelivery inserts no second intent but bumps last_push_at", async () => {
      await push(orgA, SHA, new Date("2026-11-02T10:00:00Z"));
      const t2 = new Date("2026-11-02T11:00:00Z");
      expect((await push(orgA, SHA, t2)).inserted).toBe(false);
      const intents = await db
        .select()
        .from(schema.knowledgeIntent)
        .where(eq(schema.knowledgeIntent.organizationId, orgA));
      expect(intents).toHaveLength(1);
      expect((await cursorOf(orgA))?.lastPushAt?.getTime()).toBe(t2.getTime());
    });
  });

  describe("isKnowledgeRepoPendingValidation", () => {
    it.each([
      [{ lastSha: "a", observedHeadSha: "b", hasOpenIntent: false }, true],
      [{ lastSha: "a", observedHeadSha: "a", hasOpenIntent: false }, false],
      [{ lastSha: "a", observedHeadSha: "a", hasOpenIntent: true }, true],
      [{ lastSha: null, observedHeadSha: null, hasOpenIntent: false }, false],
    ])("%j -> %s", (input, expected) => {
      expect(isKnowledgeRepoPendingValidation(input)).toBe(expected);
    });
  });

  describe("listKnowledgeRepoStatus", () => {
    it("unions onboarded repos and reports pending state per repo", async () => {
      await db
        .insert(schema.repoReviewSettings)
        .values({ organizationId: orgA, repoFullName: "acme/only-settings" });
      await db
        .insert(schema.repoReviewSettings)
        .values({ organizationId: orgA, repoFullName: "*" });
      await push(orgA, SHA);
      await push(orgB, SHA2);
      await db.insert(schema.knowledgeClaim).values([
        {
          id: "c1",
          organizationId: orgA,
          repoFullName: REPO,
          page: "p",
          statement: "s",
        },
        {
          id: "c2",
          organizationId: orgA,
          repoFullName: REPO,
          page: "p",
          statement: "s",
        },
      ]);

      const rows = await listKnowledgeRepoStatus({ db, organizationId: orgA });
      expect(rows.map((r) => r.repoFullName)).toEqual([
        REPO,
        "acme/only-settings",
      ]);
      const [docs, settingsOnly] = rows;
      expect(docs?.pending).toBe(true);
      expect(docs?.lastPushAt).not.toBeNull();
      expect(docs?.latestIntent?.state).toBe("pending");
      expect(docs?.pendingSince).toEqual(docs?.latestIntent?.createdAt);
      expect(docs?.affectedClaimCount).toBe(2);
      expect(settingsOnly?.lastPushAt).toBeNull();
      expect(settingsOnly?.latestIntent).toBeNull();
      expect(settingsOnly?.pending).toBe(false);
      expect(settingsOnly?.affectedClaimCount).toBe(0);
    });

    it("a reconciled repo is not pending and counts no affected claims", async () => {
      await push(orgA, SHA);
      await db
        .update(schema.knowledgeCursor)
        .set({ lastSha: SHA })
        .where(eq(schema.knowledgeCursor.organizationId, orgA));
      await db
        .update(schema.knowledgeIntent)
        .set({ state: "processed" })
        .where(eq(schema.knowledgeIntent.organizationId, orgA));
      const [row] = await listKnowledgeRepoStatus({ db, organizationId: orgA });
      expect(row?.pending).toBe(false);
      expect(row?.pendingSince).toBeNull();
      expect(row?.affectedClaimCount).toBe(0);
    });

    it("never shows another org's rows", async () => {
      await push(orgB, SHA);
      expect(
        await listKnowledgeRepoStatus({ db, organizationId: orgA }),
      ).toEqual([]);
    });
  });

  describe("retryKnowledgeIntent", () => {
    it("resets a failed intent and logs intent_retry", async () => {
      const { intentId } = await push(orgA, SHA);
      await db
        .update(schema.knowledgeIntent)
        .set({
          state: "failed",
          attempts: 8,
          lastErrorCode: "boom",
          nextAttemptAt: new Date("2030-01-01T00:00:00Z"),
        })
        .where(eq(schema.knowledgeIntent.id, intentId));
      const now = new Date("2026-11-02T12:00:00Z");
      expect(
        await retryKnowledgeIntent({
          db,
          organizationId: orgA,
          intentId,
          actorUserId: actor,
          now,
        }),
      ).toEqual({ result: "retried" });
      const [row] = await db
        .select()
        .from(schema.knowledgeIntent)
        .where(eq(schema.knowledgeIntent.id, intentId));
      expect(row).toMatchObject({
        state: "pending",
        attempts: 0,
        lastErrorCode: null,
      });
      expect(row?.nextAttemptAt.getTime()).toBe(now.getTime());
      const log = await db
        .select()
        .from(schema.knowledgeAdminLog)
        .where(
          and(
            eq(schema.knowledgeAdminLog.organizationId, orgA),
            eq(schema.knowledgeAdminLog.action, "intent_retry"),
          ),
        );
      expect(log).toHaveLength(1);
      expect(log[0]?.target).toEqual({ targetSha: SHA, attemptsWas: 8 });
    });

    it("a non-failed or foreign intent is not_found and writes nothing", async () => {
      const { intentId } = await push(orgA, SHA);
      expect(
        await retryKnowledgeIntent({
          db,
          organizationId: orgA,
          intentId,
          actorUserId: actor,
        }),
      ).toEqual({ result: "not_found" });
      await db
        .update(schema.knowledgeIntent)
        .set({ state: "failed" })
        .where(eq(schema.knowledgeIntent.id, intentId));
      expect(
        await retryKnowledgeIntent({
          db,
          organizationId: orgB,
          intentId,
          actorUserId: actor,
        }),
      ).toEqual({ result: "not_found" });
      const log = await db
        .select()
        .from(schema.knowledgeAdminLog)
        .where(eq(schema.knowledgeAdminLog.action, "intent_retry"));
      expect(log.filter((l) => l.organizationId === orgA)).toHaveLength(0);
      expect(log.filter((l) => l.organizationId === orgB)).toHaveLength(0);
    });
  });

  describe("accessor", () => {
    it("an Off org records a push; gated insertIntent still refuses", async () => {
      const a = forKnowledge({ db, organizationId: orgA });
      const res = await a.store.recordPushUnlessOffboarded({
        repoFullName: REPO,
        defaultBranch: "main",
        targetSha: SHA,
      });
      expect(res.ok).toBe(true);
      expect(await cursorOf(orgA)).toMatchObject({ observedHeadSha: SHA });
      expect(
        await a.store.insertIntent({
          repoFullName: REPO,
          defaultBranch: "main",
          targetSha: SHA2,
        }),
      ).toEqual({ ok: false, reason: "engine_off" });
    });

    it("an offboarded org records nothing", async () => {
      const a = forKnowledge({ db, organizationId: orgA });
      await a.admin.offboard({ actorUserId: actor });
      expect(
        await a.store.recordPushUnlessOffboarded({
          repoFullName: REPO,
          defaultBranch: "main",
          targetSha: SHA,
        }),
      ).toEqual({ ok: false, reason: "offboarded" });
      expect(await cursorOf(orgA)).toBeUndefined();
      const intents = await db
        .select()
        .from(schema.knowledgeIntent)
        .where(eq(schema.knowledgeIntent.organizationId, orgA));
      expect(intents).toHaveLength(0);
    });
  });
});
