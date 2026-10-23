import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

import { createDb, type DB } from "../db";
import * as schema from "../db/schema";
import {
  advanceKnowledgeCursor,
  decideKnowledgeOp,
  DEFAULT_KNOWLEDGE_CAP_MICRO_USD,
  effectiveKnowledgeBudgetMicroUsd,
  getKnowledgeCursor,
  isKnowledgeEnabled,
  knowledgeGateReason,
  knowledgeWindowStart,
  observeKnowledgeHead,
  reserveKnowledgeBudget,
  settleKnowledgeBudget,
} from "./knowledge";
import { createTestOrg, createTestUser } from "./test-helpers";

const NOW = new Date("2026-10-19T12:00:00Z");

describe("knowledge plane persistence", () => {
  let db: DB;
  let userId: string;
  let orgA: string;
  let orgB: string;
  /** Row ids are per test: the shared test database is not truncated between tests. */
  let k: (id: string) => string;

  beforeEach(async () => {
    const run = Math.random().toString(36).slice(2, 10);
    k = (id) => `${id}-${run}`;
    db = createDb(process.env.DATABASE_URL!);
    const { user } = await createTestUser({ db });
    userId = user.id;
    orgA = await createTestOrg({ db, name: "Acme" });
    orgB = await createTestOrg({ db, name: "Globex" });
  });

  async function seedClaim(organizationId: string, id: string) {
    await db.insert(schema.knowledgeClaim).values({
      id,
      organizationId,
      repoFullName: "acme/docs",
      page: "billing-faq",
      statement: "Trials last 14 days.",
    });
  }

  async function seedOp(
    organizationId: string,
    id: string,
    claimId: string,
    baseVersion = 1,
  ) {
    await db.insert(schema.knowledgeOp).values({
      id,
      organizationId,
      claimId,
      repoFullName: "acme/docs",
      kind: "update",
      baseVersion,
      proposal: { statement: "Trials last 30 days." },
      mergeRev: "abc1234",
    });
  }

  const claimOf = async (id: string) =>
    (
      await db
        .select()
        .from(schema.knowledgeClaim)
        .where(eq(schema.knowledgeClaim.id, id))
    )[0];

  const opState = async (id: string) =>
    (
      await db
        .select({ state: schema.knowledgeOp.state })
        .from(schema.knowledgeOp)
        .where(eq(schema.knowledgeOp.id, id))
    )[0]?.state;

  async function setControls(
    organizationId: string,
    c: {
      engine: boolean | null;
      budget?: number | null;
      offboardedAt?: Date | null;
    },
  ) {
    const values = {
      organizationId,
      knowledgeEngine: c.engine,
      knowledgeBudgetMicroUsd: c.budget ?? null,
      knowledgeOffboardedAt: c.offboardedAt ?? null,
    };
    await db
      .insert(schema.organizationReviewSettings)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.organizationReviewSettings.organizationId],
        set: values,
      });
  }

  const windowsOf = (organizationId: string) =>
    db
      .select()
      .from(schema.knowledgeUsageWindow)
      .where(eq(schema.knowledgeUsageWindow.organizationId, organizationId));

  describe("resolvers", () => {
    const row = (
      knowledgeEngine: boolean | null,
      knowledgeOffboardedAt: Date | null = null,
    ) => ({
      knowledgeEngine,
      knowledgeOffboardedAt,
      knowledgeBudgetMicroUsd: null,
    });

    it("resolves OFF for missing, null and false; ON for true; offboarded wins", () => {
      expect(knowledgeGateReason(undefined)).toBe("engine_off");
      expect(knowledgeGateReason(row(null))).toBe("engine_off");
      expect(knowledgeGateReason(row(false))).toBe("engine_off");
      expect(knowledgeGateReason(row(true))).toBeNull();
      expect(knowledgeGateReason(row(true, NOW))).toBe("offboarded");
      expect(isKnowledgeEnabled(row(true))).toBe(true);
      expect(isKnowledgeEnabled(row(true, NOW))).toBe(false);
    });

    it("resolves the effective budget", () => {
      expect(effectiveKnowledgeBudgetMicroUsd(undefined)).toBe(
        DEFAULT_KNOWLEDGE_CAP_MICRO_USD,
      );
      expect(
        effectiveKnowledgeBudgetMicroUsd({ knowledgeBudgetMicroUsd: null }),
      ).toBe(DEFAULT_KNOWLEDGE_CAP_MICRO_USD);
      expect(
        effectiveKnowledgeBudgetMicroUsd({
          knowledgeBudgetMicroUsd: 5_000_000,
        }),
      ).toBe(5_000_000);
      expect(
        effectiveKnowledgeBudgetMicroUsd({ knowledgeBudgetMicroUsd: 0 }),
      ).toBe(0);
    });
  });

  describe("budget reservation", () => {
    beforeEach(async () => {
      await setControls(orgA, { engine: true, budget: 1_000 });
      await setControls(orgB, { engine: true, budget: 1_000 });
    });

    it("refuses with engine_off before creating any window", async () => {
      const org = await createTestOrg({ db, name: "Initech" });
      const r = await reserveKnowledgeBudget({
        db,
        organizationId: org,
        estimateMicroUsd: 1,
        now: NOW,
      });
      expect(r).toEqual({ ok: false, reason: "engine_off" });
      expect(await windowsOf(org)).toHaveLength(0);
    });

    it("refuses an offboarded org even with the engine true", async () => {
      await setControls(orgA, { engine: true, offboardedAt: NOW });
      const r = await reserveKnowledgeBudget({
        db,
        organizationId: orgA,
        estimateMicroUsd: 1,
        now: NOW,
      });
      expect(r).toEqual({ ok: false, reason: "offboarded" });
      expect(await windowsOf(orgA)).toHaveLength(0);
    });

    it("takes the window cap from the org budget, or the platform default", async () => {
      await reserveKnowledgeBudget({
        db,
        organizationId: orgA,
        estimateMicroUsd: 1,
        now: NOW,
      });
      expect((await windowsOf(orgA))[0]?.capMicroUsd).toBe(1_000);
      await setControls(orgB, { engine: true, budget: null });
      await reserveKnowledgeBudget({
        db,
        organizationId: orgB,
        estimateMicroUsd: 1,
        now: NOW,
      });
      expect((await windowsOf(orgB))[0]?.capMicroUsd).toBe(
        DEFAULT_KNOWLEDGE_CAP_MICRO_USD,
      );
    });

    it("alerts exactly one of 5 concurrent denials and logs ids and integers only", async () => {
      const log = { error: vi.fn() };
      const reserve = () =>
        reserveKnowledgeBudget({
          db,
          organizationId: orgA,
          estimateMicroUsd: 5_000,
          now: NOW,
          log,
        });
      const results = await Promise.all([1, 2, 3, 4, 5].map(reserve));
      expect(
        results.filter((r) => !r.ok && "alerted" in r && r.alerted),
      ).toHaveLength(1);
      expect((await windowsOf(orgA))[0]?.capAlertedAt).not.toBeNull();
      expect(log.error).toHaveBeenCalledTimes(1);
      const [tag, payload] = log.error.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(tag).toBe("[knowledge:budget-cap]");
      for (const v of Object.values(payload))
        expect(["string", "number"]).toContain(typeof v);
      const sixth = await reserve();
      expect(sixth).toMatchObject({ ok: false, alerted: false });
      expect(log.error).toHaveBeenCalledTimes(1);
    });

    it("still settles after the engine is turned off", async () => {
      const r = await reserveKnowledgeBudget({
        db,
        organizationId: orgA,
        estimateMicroUsd: 600,
        now: NOW,
      });
      if (!r.ok) throw new Error("expected a reservation");
      await setControls(orgA, { engine: false, budget: 1_000 });
      await settleKnowledgeBudget({
        db,
        organizationId: orgA,
        windowStart: r.windowStart,
        reservedMicroUsd: r.reservedMicroUsd,
        spentMicroUsd: 100,
      });
      const w = (await windowsOf(orgA))[0];
      expect(w?.reservedMicroUsd).toBe(0);
      expect(w?.spentMicroUsd).toBe(100);
    });

    it("keys the window on the UTC calendar month", () => {
      expect(knowledgeWindowStart(new Date("2026-10-31T23:59:59Z"))).toEqual(
        new Date("2026-10-01T00:00:00Z"),
      );
    });

    it("reserves up to the cap and refuses the call that would exceed it", async () => {
      const first = await reserveKnowledgeBudget({
        db,
        organizationId: orgA,
        estimateMicroUsd: 600,
        now: NOW,
      });
      const second = await reserveKnowledgeBudget({
        db,
        organizationId: orgA,
        estimateMicroUsd: 600,
        now: NOW,
      });
      expect(first.ok).toBe(true);
      expect(second).toEqual({
        ok: false,
        reason: "cap_exceeded",
        windowStart: knowledgeWindowStart(NOW),
        alerted: true,
      });
    });

    it("lets exactly one of two concurrent reservations take the last allowance", async () => {
      const reserve = () =>
        reserveKnowledgeBudget({
          db,
          organizationId: orgA,
          estimateMicroUsd: 700,
          now: NOW,
        });
      const results = await Promise.all([reserve(), reserve(), reserve()]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const [window] = await db
        .select()
        .from(schema.knowledgeUsageWindow)
        .where(eq(schema.knowledgeUsageWindow.organizationId, orgA));
      expect(window?.reservedMicroUsd).toBe(700);
    });

    it("settles the actual cost and frees the rest of the reservation", async () => {
      const r = await reserveKnowledgeBudget({
        db,
        organizationId: orgA,
        estimateMicroUsd: 900,
        now: NOW,
      });
      if (!r.ok) throw new Error("expected a reservation");
      await settleKnowledgeBudget({
        db,
        organizationId: orgA,
        windowStart: r.windowStart,
        reservedMicroUsd: r.reservedMicroUsd,
        spentMicroUsd: 250,
      });
      const [window] = await db
        .select()
        .from(schema.knowledgeUsageWindow)
        .where(eq(schema.knowledgeUsageWindow.organizationId, orgA));
      expect(window?.reservedMicroUsd).toBe(0);
      expect(window?.spentMicroUsd).toBe(250);
      const next = await reserveKnowledgeBudget({
        db,
        organizationId: orgA,
        estimateMicroUsd: 750,
        now: NOW,
      });
      expect(next.ok).toBe(true);
    });

    it("keeps each org's window separate", async () => {
      await reserveKnowledgeBudget({
        db,
        organizationId: orgA,
        estimateMicroUsd: 1_000,
        now: NOW,
      });
      const b = await reserveKnowledgeBudget({
        db,
        organizationId: orgB,
        estimateMicroUsd: 1_000,
        now: NOW,
      });
      expect(b.ok).toBe(true);
    });

    it("rejects a negative or fractional estimate", async () => {
      await expect(
        reserveKnowledgeBudget({
          db,
          organizationId: orgA,
          estimateMicroUsd: -1,
        }),
      ).rejects.toThrow(RangeError);
      await expect(
        reserveKnowledgeBudget({
          db,
          organizationId: orgA,
          estimateMicroUsd: 1.5,
        }),
      ).rejects.toThrow(RangeError);
    });
  });

  describe("deciding an op", () => {
    const decide = (
      organizationId: string,
      opId: string,
      choice: schema.KnowledgeDecisionChoice = "approve",
      statement = "Trials last 30 days.",
    ) =>
      decideKnowledgeOp({
        db,
        organizationId,
        opId,
        actorUserId: userId,
        slackUserId: "U123",
        route: "platform",
        choice,
        claimPatch: choice === "reject_keep" ? {} : { statement },
        approvedAt: NOW,
      });

    it("applies an approval, bumps the claim version and logs the decision", async () => {
      await seedClaim(orgA, k("c1"));
      await seedOp(orgA, k("op:billing-faq/c1@abc1234"), k("c1"));
      expect(await decide(orgA, k("op:billing-faq/c1@abc1234"))).toEqual({
        result: "applied",
        claimVersion: 2,
      });
      const claim = await claimOf(k("c1"));
      expect(claim?.statement).toBe("Trials last 30 days.");
      expect(claim?.approvedByUserId).toBe(userId);
      expect(await opState(k("op:billing-faq/c1@abc1234"))).toBe("applied");
      const decisions = await db
        .select()
        .from(schema.knowledgeDecision)
        .where(
          eq(schema.knowledgeDecision.opId, k("op:billing-faq/c1@abc1234")),
        );
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.route).toBe("platform");
    });

    it("records one decision for a double click", async () => {
      await seedClaim(orgA, k("c1"));
      await seedOp(orgA, k("op1"), k("c1"));
      const [a, b] = await Promise.all([
        decide(orgA, k("op1")),
        decide(orgA, k("op1")),
      ]);
      expect([a.result, b.result].sort()).toEqual([
        "already_decided",
        "applied",
      ]);
      const decisions = await db
        .select()
        .from(schema.knowledgeDecision)
        .where(eq(schema.knowledgeDecision.opId, k("op1")));
      expect(decisions).toHaveLength(1);
      expect((await claimOf(k("c1")))?.version).toBe(2);
    });

    it("supersedes an op made against an older claim version and leaves the claim alone", async () => {
      await seedClaim(orgA, k("c1"));
      await seedOp(orgA, k("op-new"), k("c1"), 1);
      await seedOp(orgA, k("op-old"), k("c1"), 1);
      await decide(orgA, k("op-new"), "approve", "Trials last 30 days.");
      expect(
        await decide(orgA, k("op-old"), "approve", "Trials last 7 days."),
      ).toEqual({ result: "superseded" });
      expect((await claimOf(k("c1")))?.statement).toBe("Trials last 30 days.");
      expect(await opState(k("op-old"))).toBe("superseded");
    });

    it("lets exactly one of two concurrent approvals on the same claim win", async () => {
      await seedClaim(orgA, k("c1"));
      await seedOp(orgA, k("opA"), k("c1"), 1);
      await seedOp(orgA, k("opB"), k("c1"), 1);
      const results = await Promise.all([
        decide(orgA, k("opA"), "approve", "A"),
        decide(orgA, k("opB"), "approve", "B"),
      ]);
      expect(results.map((r) => r.result).sort()).toEqual([
        "applied",
        "superseded",
      ]);
      expect((await claimOf(k("c1")))?.version).toBe(2);
    });

    it("rejects with reject_keep: the statement stays and the version moves", async () => {
      await seedClaim(orgA, k("c1"));
      await seedOp(orgA, k("op1"), k("c1"));
      expect(await decide(orgA, k("op1"), "reject_keep")).toEqual({
        result: "rejected",
        claimVersion: 2,
      });
      expect((await claimOf(k("c1")))?.statement).toBe("Trials last 14 days.");
      expect(await opState(k("op1"))).toBe("rejected");
    });

    it("cannot reach another org's op", async () => {
      await seedClaim(orgA, k("c1"));
      await seedOp(orgA, k("op1"), k("c1"));
      expect(await decide(orgB, k("op1"))).toEqual({ result: "not_found" });
      expect(await opState(k("op1"))).toBe("proposed");
    });
  });

  describe("cursor", () => {
    const repo = "acme/docs";
    // the cursor PK is (org, repo); each test has fresh orgs, so the repo name can repeat

    it("starts from null, then only advances from the sha it last recorded", async () => {
      const args = {
        db,
        organizationId: orgA,
        repoFullName: repo,
        defaultBranch: "main",
      };
      expect(
        await advanceKnowledgeCursor({ ...args, fromSha: null, toSha: "a1" }),
      ).toBe(true);
      expect(
        await advanceKnowledgeCursor({ ...args, fromSha: "a1", toSha: "b2" }),
      ).toBe(true);
      // a late job that read the cursor at a1 cannot move it back
      expect(
        await advanceKnowledgeCursor({ ...args, fromSha: "a1", toSha: "a9" }),
      ).toBe(false);
      expect(
        await advanceKnowledgeCursor({ ...args, fromSha: null, toSha: "z0" }),
      ).toBe(false);
      expect(
        (
          await getKnowledgeCursor({
            db,
            organizationId: orgA,
            repoFullName: repo,
          })
        )?.lastSha,
      ).toBe("b2");
    });

    it("records the observed head without moving last_sha, and fences by org", async () => {
      await advanceKnowledgeCursor({
        db,
        organizationId: orgA,
        repoFullName: repo,
        defaultBranch: "main",
        fromSha: null,
        toSha: "a1",
      });
      await observeKnowledgeHead({
        db,
        organizationId: orgA,
        repoFullName: repo,
        defaultBranch: "main",
        headSha: "c3",
      });
      const cursor = await getKnowledgeCursor({
        db,
        organizationId: orgA,
        repoFullName: repo,
      });
      expect(cursor?.lastSha).toBe("a1");
      expect(cursor?.observedHeadSha).toBe("c3");
      expect(
        await getKnowledgeCursor({
          db,
          organizationId: orgB,
          repoFullName: repo,
        }),
      ).toBeNull();
      const rows = await db
        .select()
        .from(schema.knowledgeCursor)
        .where(
          and(
            eq(schema.knowledgeCursor.organizationId, orgB),
            eq(schema.knowledgeCursor.repoFullName, repo),
          ),
        );
      expect(rows).toHaveLength(0);
    });
  });
});
