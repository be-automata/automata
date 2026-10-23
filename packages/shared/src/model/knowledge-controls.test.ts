import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { createDb, type DB } from "../db";
import * as schema from "../db/schema";
import {
  DEFAULT_KNOWLEDGE_CAP_MICRO_USD,
  KNOWLEDGE_BUDGET_ABSOLUTE_MAX_MICRO_USD,
  KNOWLEDGE_BUDGET_CEILING_DEFAULT_MICRO_USD,
  knowledgeWindowStart,
  reserveKnowledgeBudget,
  settleKnowledgeBudget,
} from "./knowledge";
import { listKnowledgeAdminActions } from "./knowledge-admin-log";
import {
  KNOWLEDGE_PURGE_GRACE_MS,
  KnowledgeControlsConflictError,
  KnowledgeOffboardedError,
  canSetKnowledgeBudget,
  clearKnowledgeOffboard,
  getKnowledgeBudgetCeiling,
  getKnowledgeControls,
  getKnowledgeSpend,
  offboardKnowledge,
  setKnowledgeBudgetCeiling,
  updateKnowledgeControls,
} from "./knowledge-controls";
import { MinimizationError } from "./knowledge-minimize";
import { recordKnowledgeAdminAction } from "./knowledge-admin-log";
import { createTestOrg, createTestUser } from "./test-helpers";

const NOW = new Date("2026-10-19T12:00:00Z");

describe("knowledge controls", () => {
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
    // the platform settings row is a singleton shared by the test database
    await db.delete(schema.knowledgePlatformSettings);
  });

  const logOf = (organizationId: string) =>
    listKnowledgeAdminActions({ db, organizationId });
  const windowOf = async (organizationId: string) =>
    (
      await db
        .select()
        .from(schema.knowledgeUsageWindow)
        .where(eq(schema.knowledgeUsageWindow.organizationId, organizationId))
    )[0];
  const update = (
    organizationId: string,
    patch: { engine?: boolean; budgetMicroUsd?: number | null },
    extra: {
      expectedUpdatedAt?: Date | null;
      via?: "org_admin" | "platform_admin";
    } = {},
  ) =>
    updateKnowledgeControls({
      db,
      organizationId,
      actorUserId: userId,
      patch,
      now: NOW,
      ...extra,
    });

  describe("read", () => {
    it("reports OFF with defaults for an org without a row", async () => {
      expect(await getKnowledgeControls({ db, organizationId: orgA })).toEqual({
        engine: null,
        budgetMicroUsd: null,
        effectiveBudgetMicroUsd: DEFAULT_KNOWLEDGE_CAP_MICRO_USD,
        ceilingMicroUsd: KNOWLEDGE_BUDGET_CEILING_DEFAULT_MICRO_USD,
        offboardedAt: null,
        purgeAfter: null,
        purgedAt: null,
        enabled: false,
        gateReason: "engine_off",
        updatedAt: null,
      });
    });
  });

  describe("platform ceiling", () => {
    it("defaults to $100 with no row or a NULL ceiling", async () => {
      expect(await getKnowledgeBudgetCeiling(db)).toBe(100_000_000);
      await setKnowledgeBudgetCeiling(db, { micro: null, actorUserId: userId });
      expect(await getKnowledgeBudgetCeiling(db)).toBe(100_000_000);
    });

    it("stores the ceiling in one singleton row with provenance", async () => {
      await setKnowledgeBudgetCeiling(db, {
        micro: 50_000_000,
        actorUserId: userId,
      });
      await setKnowledgeBudgetCeiling(db, {
        micro: 50_000_000,
        actorUserId: userId,
      });
      expect(await getKnowledgeBudgetCeiling(db)).toBe(50_000_000);
      const rows = await db.select().from(schema.knowledgePlatformSettings);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.updatedByUserId).toBe(userId);
      expect(
        (await getKnowledgeControls({ db, organizationId: orgA }))
          .ceilingMicroUsd,
      ).toBe(50_000_000);
    });

    it("rejects out-of-range values and writes nothing", async () => {
      for (const micro of [
        Number.NaN,
        -1,
        1.5,
        KNOWLEDGE_BUDGET_ABSOLUTE_MAX_MICRO_USD + 1,
      ])
        await expect(
          setKnowledgeBudgetCeiling(db, { micro, actorUserId: userId }),
        ).rejects.toThrow(RangeError);
      expect(await db.select().from(schema.knowledgePlatformSettings)).toEqual(
        [],
      );
    });

    it("lowering the ceiling leaves org budgets alone and only gates raises", async () => {
      await update(
        orgA,
        { budgetMicroUsd: 80_000_000 },
        { via: "platform_admin" },
      );
      await setKnowledgeBudgetCeiling(db, {
        micro: 50_000_000,
        actorUserId: userId,
      });
      const controls = await getKnowledgeControls({ db, organizationId: orgA });
      expect(controls.budgetMicroUsd).toBe(80_000_000);
      expect((await windowOf(orgA))?.capMicroUsd).toBe(80_000_000);
      const ceilingMicroUsd = await getKnowledgeBudgetCeiling(db);
      const rule = (next: number) =>
        canSetKnowledgeBudget({
          next,
          current: 80_000_000,
          isPlatformAdmin: false,
          ceilingMicroUsd,
        });
      expect(rule(90_000_000)).toEqual({ ok: false, reason: "above_ceiling" });
      expect(rule(60_000_000)).toEqual({ ok: true });
    });
  });

  describe("updateKnowledgeControls", () => {
    it("enables the engine, logs the toggle and keeps the review floor", async () => {
      await db
        .insert(schema.organizationReviewSettings)
        .values({ organizationId: orgA, blockTolerance: "warning" });
      const c = await update(orgA, { engine: true });
      expect(c.enabled).toBe(true);
      const [row] = await db
        .select()
        .from(schema.organizationReviewSettings)
        .where(eq(schema.organizationReviewSettings.organizationId, orgA));
      expect(row?.blockTolerance).toBe("warning");
      expect(row?.updatedByUserId).toBe(userId);
      const log = await logOf(orgA);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        action: "engine_toggle",
        target: { from: null, to: true, via: "org_admin" },
      });
    });

    it("logs a platform admin budget write with via and updates the open window", async () => {
      await db.insert(schema.knowledgeUsageWindow).values({
        organizationId: orgA,
        windowStart: knowledgeWindowStart(NOW),
        capMicroUsd: 20_000_000,
      });
      await update(
        orgA,
        { budgetMicroUsd: 150_000_000 },
        { via: "platform_admin" },
      );
      expect((await windowOf(orgA))?.capMicroUsd).toBe(150_000_000);
      const log = await logOf(orgA);
      expect(log[0]).toMatchObject({
        action: "budget_change",
        actorUserId: userId,
        target: {
          fromMicroUsd: null,
          toMicroUsd: 150_000_000,
          via: "platform_admin",
        },
      });
    });

    it("lowers the open window cap in the same write", async () => {
      await db.insert(schema.knowledgeUsageWindow).values({
        organizationId: orgA,
        windowStart: knowledgeWindowStart(NOW),
        capMicroUsd: 20_000_000,
      });
      await update(orgA, { budgetMicroUsd: 5_000_000 });
      expect((await windowOf(orgA))?.capMicroUsd).toBe(5_000_000);
      expect((await logOf(orgA))[0]?.target).toMatchObject({
        fromMicroUsd: null,
        toMicroUsd: 5_000_000,
      });
    });

    it("a raise clears the alert claim; a lowering keeps it", async () => {
      await db.insert(schema.knowledgeUsageWindow).values({
        organizationId: orgA,
        windowStart: knowledgeWindowStart(NOW),
        capMicroUsd: 1_000,
        capAlertedAt: NOW,
      });
      await update(orgA, { budgetMicroUsd: 500 });
      expect((await windowOf(orgA))?.capAlertedAt).not.toBeNull();
      await update(orgA, { budgetMicroUsd: 5_000 });
      expect((await windowOf(orgA))?.capAlertedAt).toBeNull();
    });

    it("lowering below spend makes the next reserve deny", async () => {
      await update(orgA, { engine: true, budgetMicroUsd: 1_000 });
      const r = await reserveKnowledgeBudget({
        db,
        organizationId: orgA,
        estimateMicroUsd: 800,
        now: NOW,
        log: { error: () => {} },
      });
      if (!r.ok) throw new Error("expected a reservation");
      await settleKnowledgeBudget({
        db,
        organizationId: orgA,
        windowStart: r.windowStart,
        reservedMicroUsd: r.reservedMicroUsd,
        spentMicroUsd: 800,
      });
      await update(orgA, { budgetMicroUsd: 500 });
      expect(
        await reserveKnowledgeBudget({
          db,
          organizationId: orgA,
          estimateMicroUsd: 1,
          now: NOW,
          log: { error: () => {} },
        }),
      ).toMatchObject({ ok: false, reason: "cap_exceeded" });
    });

    it("checks expectedUpdatedAt and writes nothing on a conflict", async () => {
      const first = await update(orgA, { engine: true });
      const stale = new Date(first.updatedAt!.getTime() - 1000);
      await expect(
        update(orgA, { engine: false }, { expectedUpdatedAt: stale }),
      ).rejects.toThrow(KnowledgeControlsConflictError);
      await expect(
        update(orgA, { engine: false }, { expectedUpdatedAt: null }),
      ).rejects.toThrow(KnowledgeControlsConflictError);
      expect(await logOf(orgA)).toHaveLength(1);
      expect(
        (await getKnowledgeControls({ db, organizationId: orgA })).engine,
      ).toBe(true);
      const ok = await update(
        orgA,
        { engine: false },
        { expectedUpdatedAt: first.updatedAt },
      );
      expect(ok.engine).toBe(false);
      await update(orgA, { engine: true });
      expect(await logOf(orgA)).toHaveLength(3);
      await update(orgB, { engine: true }, { expectedUpdatedAt: null });
    });

    it("keeps its stamp apart from the PR-review settings' updatedAt", async () => {
      const reviewRow = async () => {
        const [row] = await db
          .select()
          .from(schema.organizationReviewSettings)
          .where(eq(schema.organizationReviewSettings.organizationId, orgA));
        if (!row) throw new Error("expected a settings row");
        return row;
      };
      const first = await update(orgA, { engine: true });
      const reviewStampBefore = (await reviewRow()).updatedAt.getTime();

      // A PR-review save bumps updatedAt; the knowledge stamp still matches.
      await db
        .update(schema.organizationReviewSettings)
        .set({ trustedAuthorThreshold: "MEMBER" })
        .where(eq(schema.organizationReviewSettings.organizationId, orgA));
      const reviewStampAfterReviewSave = (
        await reviewRow()
      ).updatedAt.getTime();
      expect(reviewStampAfterReviewSave).not.toBe(reviewStampBefore);
      const second = await update(
        orgA,
        { budgetMicroUsd: 5_000_000 },
        { expectedUpdatedAt: first.updatedAt },
      );
      expect(second.budgetMicroUsd).toBe(5_000_000);

      // Knowledge writes (update, offboard, undo) leave updatedAt alone.
      await offboardKnowledge({
        db,
        organizationId: orgA,
        actorUserId: userId,
      });
      await clearKnowledgeOffboard({
        db,
        organizationId: orgA,
        actorUserId: userId,
      });
      expect((await reviewRow()).updatedAt.getTime()).toBe(
        reviewStampAfterReviewSave,
      );
    });

    it("refuses to enable while offboarded", async () => {
      await offboardKnowledge({
        db,
        organizationId: orgA,
        actorUserId: userId,
      });
      await expect(update(orgA, { engine: true })).rejects.toThrow(
        KnowledgeOffboardedError,
      );
      expect(await logOf(orgA)).toHaveLength(1);
    });
  });

  describe("offboarding", () => {
    it("forces Off, schedules the purge and is idempotent", async () => {
      await update(orgA, { engine: true });
      const c = await offboardKnowledge({
        db,
        organizationId: orgA,
        actorUserId: userId,
        now: NOW,
      });
      expect(c.engine).toBe(false);
      expect(c.offboardedAt).toEqual(NOW);
      expect(c.purgeAfter).toEqual(
        new Date(NOW.getTime() + KNOWLEDGE_PURGE_GRACE_MS),
      );
      expect(c.gateReason).toBe("offboarded");
      const again = await offboardKnowledge({
        db,
        organizationId: orgA,
        actorUserId: userId,
        now: new Date(NOW.getTime() + 1000),
      });
      expect(again.offboardedAt).toEqual(NOW);
      const log = await logOf(orgA);
      expect(log.filter((l) => l.action === "offboard")).toHaveLength(1);
      expect(log.find((l) => l.action === "offboard")?.target).toEqual({
        engineWas: true,
      });
    });

    it("undo clears the mark, keeps the engine Off and logs purged", async () => {
      await offboardKnowledge({
        db,
        organizationId: orgA,
        actorUserId: userId,
      });
      const c = await clearKnowledgeOffboard({
        db,
        organizationId: orgA,
        actorUserId: userId,
      });
      expect(c.offboardedAt).toBeNull();
      expect(c.engine).toBe(false);
      const undo = (await logOf(orgA)).filter(
        (l) => l.action === "offboard_undo",
      );
      expect(undo).toHaveLength(1);
      expect(undo[0]?.target).toEqual({ purged: false });
      await clearKnowledgeOffboard({
        db,
        organizationId: orgA,
        actorUserId: userId,
      });
      expect(
        (await logOf(orgA)).filter((l) => l.action === "offboard_undo"),
      ).toHaveLength(1);
    });
  });

  describe("getKnowledgeSpend", () => {
    it("reports the effective budget with zeros when no window exists", async () => {
      const s = await getKnowledgeSpend({ db, organizationId: orgA, now: NOW });
      expect(s).toMatchObject({
        capMicroUsd: DEFAULT_KNOWLEDGE_CAP_MICRO_USD,
        reservedMicroUsd: 0,
        spentMicroUsd: 0,
        remainingMicroUsd: DEFAULT_KNOWLEDGE_CAP_MICRO_USD,
        atCap: false,
        capAlertedAt: null,
      });
    });

    it("reports exact integers after reserve and settle, isolated per org", async () => {
      await update(orgA, { engine: true, budgetMicroUsd: 1_000 });
      const r = await reserveKnowledgeBudget({
        db,
        organizationId: orgA,
        estimateMicroUsd: 600,
        now: NOW,
      });
      if (!r.ok) throw new Error("expected a reservation");
      await settleKnowledgeBudget({
        db,
        organizationId: orgA,
        windowStart: r.windowStart,
        reservedMicroUsd: 600,
        spentMicroUsd: 400,
      });
      const s = await getKnowledgeSpend({ db, organizationId: orgA, now: NOW });
      expect(s).toMatchObject({
        capMicroUsd: 1_000,
        reservedMicroUsd: 0,
        spentMicroUsd: 400,
        remainingMicroUsd: 600,
        atCap: false,
      });
      const b = await getKnowledgeSpend({ db, organizationId: orgB, now: NOW });
      expect(b.spentMicroUsd).toBe(0);
      await reserveKnowledgeBudget({
        db,
        organizationId: orgA,
        estimateMicroUsd: 5_000,
        now: NOW,
        log: { error: () => {} },
      });
      const capped = await getKnowledgeSpend({
        db,
        organizationId: orgA,
        now: NOW,
      });
      expect(capped.atCap).toBe(true);
      expect(capped.capAlertedAt).not.toBeNull();
    });
  });

  describe("canSetKnowledgeBudget", () => {
    const ceilingMicroUsd = 100_000_000;
    const rule = (
      next: number | null,
      current: number | null,
      isPlatformAdmin = false,
    ) =>
      canSetKnowledgeBudget({
        next,
        current,
        isPlatformAdmin,
        ceilingMicroUsd,
      });

    it("follows the truth table", () => {
      expect(rule(null, null)).toEqual({ ok: true });
      for (const bad of [
        -1,
        1.5,
        Number.NaN,
        KNOWLEDGE_BUDGET_ABSOLUTE_MAX_MICRO_USD + 1,
      ])
        expect(rule(bad, null, true)).toEqual({
          ok: false,
          reason: "out_of_range",
        });
      expect(rule(100_000_000, null)).toEqual({ ok: true });
      expect(rule(100_000_001, null)).toEqual({
        ok: false,
        reason: "above_ceiling",
      });
      expect(rule(100_000_001, null, true)).toEqual({ ok: true });
      expect(rule(200_000_000, 300_000_000)).toEqual({ ok: true });
      expect(rule(400_000_000, 300_000_000)).toEqual({
        ok: false,
        reason: "above_ceiling",
      });
    });
  });

  describe("admin log", () => {
    it("refuses free text and inserts nothing", async () => {
      await expect(
        recordKnowledgeAdminAction({
          db,
          organizationId: orgA,
          actorUserId: userId,
          action: "engine_toggle",
          target: { note: "free text with spaces" },
        }),
      ).rejects.toThrow(MinimizationError);
      expect(await logOf(orgA)).toHaveLength(0);
    });

    it("lists newest first and fenced by org", async () => {
      await update(orgA, { engine: true });
      await update(orgA, { budgetMicroUsd: 1_000 });
      await update(orgB, { engine: true });
      const log = await logOf(orgA);
      expect(log.map((l) => l.action)).toEqual([
        "budget_change",
        "engine_toggle",
      ]);
      expect(log.every((l) => l.organizationId === orgA)).toBe(true);
    });
  });
});

// The knowledge fence reads the locked row and compares in JS. A raw-SQL stamp
// with microseconds parses to a millisecond Date, so the page's stamp matches;
// a stamp one millisecond off still conflicts.
describe("knowledge controls fence at millisecond precision", () => {
  const MS_TRUNCATED = new Date("2026-10-23T18:28:39.410Z");

  it("accepts the ms-truncated stamp of a microsecond raw-SQL write, rejects a different millisecond", async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const { user } = await createTestUser({ db });
    const orgId = await createTestOrg({ db, name: "Precise" });
    await db.delete(schema.knowledgePlatformSettings);
    const update = (expectedUpdatedAt: Date) =>
      updateKnowledgeControls({
        db,
        organizationId: orgId,
        actorUserId: user.id,
        patch: { budgetMicroUsd: 1_000_000 },
        expectedUpdatedAt,
        now: NOW,
      });
    await updateKnowledgeControls({
      db,
      organizationId: orgId,
      actorUserId: user.id,
      patch: { engine: true },
      now: NOW,
    });
    await db
      .update(schema.organizationReviewSettings)
      .set({
        knowledgeUpdatedAt: sql`'2026-10-23 18:28:39.410605'::timestamp`,
      })
      .where(eq(schema.organizationReviewSettings.organizationId, orgId));

    expect(
      (await getKnowledgeControls({ db, organizationId: orgId })).updatedAt,
    ).toEqual(MS_TRUNCATED);
    for (const offset of [-1, 1]) {
      await expect(
        update(new Date(MS_TRUNCATED.getTime() + offset)),
      ).rejects.toThrow(KnowledgeControlsConflictError);
    }
    const saved = await update(MS_TRUNCATED);
    expect(saved.budgetMicroUsd).toBe(1_000_000);
  });
});
