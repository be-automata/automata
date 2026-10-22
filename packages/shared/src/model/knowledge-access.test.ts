import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createDb, type DB } from "../db";
import * as schema from "../db/schema";
import { forKnowledge } from "./knowledge-access";
import { MinimizationError } from "./knowledge-minimize";
import { KnowledgeClaimNotFoundError } from "./knowledge-store";
import { createTestOrg, createTestUser } from "./test-helpers";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const REPO = "acme/docs";

describe("forKnowledge", () => {
  let db: DB;
  let orgA: string;
  let orgB: string;
  let actor: string;
  let k: (id: string) => string;

  beforeEach(async () => {
    const run = Math.random().toString(36).slice(2, 10);
    k = (id) => `${id}-${run}`;
    db = createDb(process.env.DATABASE_URL!);
    orgA = await createTestOrg({ db, name: "Acme" });
    orgB = await createTestOrg({ db, name: "Globex" });
    actor = (await createTestUser({ db })).user.id;
  });

  const acc = (organizationId: string) => forKnowledge({ db, organizationId });
  const turn = (organizationId: string, engine: boolean) =>
    acc(organizationId).admin.updateControls({
      actorUserId: actor,
      patch: { engine },
    });

  const claimInput = (id: string, overrides = {}) => ({
    id,
    repoFullName: REPO,
    page: "billing-faq",
    statement: "Trials last 14 days.",
    ...overrides,
  });

  const opInput = (id: string, claimId: string) => ({
    id,
    claimId,
    kind: "update" as const,
    baseVersion: 1,
    mergeRev: "abc1234",
    proposal: {
      id,
      claimId,
      op: "update",
      auto: false,
      before: "Trials last 14 days.",
      after: "Trials last 30 days.",
      why: "The source changed.",
      evidence: ["repo://acme/docs/pricing.md"],
      evidenceFingerprint: "0123456789abcdef",
    },
  });

  async function seed(organizationId: string, claimId: string, opId: string) {
    const s = acc(organizationId).store;
    await s.insertClaim({ claim: claimInput(claimId) });
    await s.insertPins({
      claimId,
      pins: [
        {
          uri: "repo://acme/docs/pricing.md",
          hash: "0123456789abcdef",
          observedRev: SHA,
        },
      ],
    });
    await s.insertOp({ op: opInput(opId, claimId) });
  }

  const counts = async () => ({
    claims: (await db.select().from(schema.knowledgeClaim)).length,
    ops: (await db.select().from(schema.knowledgeOp)).length,
    intents: (await db.select().from(schema.knowledgeIntent)).length,
  });

  async function snapshot(organizationId: string) {
    const where = <T extends { organizationId: unknown }>(t: T) =>
      eq(t.organizationId as never, organizationId);
    return {
      claims: await db
        .select()
        .from(schema.knowledgeClaim)
        .where(where(schema.knowledgeClaim)),
      pins: await db
        .select()
        .from(schema.knowledgePin)
        .where(where(schema.knowledgePin)),
      ops: await db
        .select()
        .from(schema.knowledgeOp)
        .where(where(schema.knowledgeOp)),
      cursors: await db
        .select()
        .from(schema.knowledgeCursor)
        .where(where(schema.knowledgeCursor)),
    };
  }

  describe("gate", () => {
    it("engine NULL: every store method and reserve refuse, nothing written", async () => {
      const before = await counts();
      const a = acc(orgA);
      const id = k("c1");
      expect(await a.store.insertClaim({ claim: claimInput(id) })).toEqual({
        ok: false,
        reason: "engine_off",
      });
      expect(await a.store.insertOp({ op: opInput(k("o1"), id) })).toEqual({
        ok: false,
        reason: "engine_off",
      });
      expect(
        await a.store.insertIntent({
          repoFullName: REPO,
          defaultBranch: "main",
          targetSha: SHA,
        }),
      ).toEqual({ ok: false, reason: "engine_off" });
      expect(await a.store.listClaims({ repoFullName: REPO })).toEqual({
        ok: false,
        reason: "engine_off",
      });
      expect(await a.budget.reserve({ estimateMicroUsd: 1 })).toEqual({
        ok: false,
        reason: "engine_off",
      });
      expect(await counts()).toEqual(before);
    });

    it("engine on returns the delegate value", async () => {
      await turn(orgA, true);
      const id = k("c2");
      expect(
        await acc(orgA).store.insertClaim({ claim: claimInput(id) }),
      ).toEqual({ ok: true, value: { inserted: true } });
      const got = await acc(orgA).store.getClaim({ claimId: id });
      expect(got.ok && got.value?.statement).toBe("Trials last 14 days.");
    });

    it("engine on + offboarded: offboarded", async () => {
      await turn(orgA, true);
      await acc(orgA).admin.offboard({ actorUserId: actor });
      expect(await acc(orgA).store.listClaims({ repoFullName: REPO })).toEqual({
        ok: false,
        reason: "offboarded",
      });
      expect(await acc(orgA).budget.reserve({ estimateMicroUsd: 1 })).toEqual({
        ok: false,
        reason: "offboarded",
      });
    });

    it("is read live: flipping Off changes the next call", async () => {
      await turn(orgA, true);
      expect(
        (await acc(orgA).store.listClaims({ repoFullName: REPO })).ok,
      ).toBe(true);
      await turn(orgA, false);
      expect(await acc(orgA).store.listClaims({ repoFullName: REPO })).toEqual({
        ok: false,
        reason: "engine_off",
      });
    });

    it("settle and admin methods work while Off", async () => {
      await turn(orgA, true);
      const r = await acc(orgA).budget.reserve({ estimateMicroUsd: 500 });
      if (!r.ok) throw new Error("reserve should succeed");
      await turn(orgA, false);
      await acc(orgA).budget.settle({
        windowStart: r.windowStart,
        reservedMicroUsd: 500,
        spentMicroUsd: 0,
      });
      const spend = await acc(orgA).admin.getSpend();
      expect(spend.reservedMicroUsd).toBe(0);
      expect((await acc(orgA).admin.getControls()).enabled).toBe(false);
      expect((await acc(orgA).admin.listActions()).length).toBeGreaterThan(0);
    });
  });

  it("Off then On leaves all data and the cursor unchanged", async () => {
    await turn(orgA, true);
    const claimId = k("c3");
    await seed(orgA, claimId, k("o3"));
    const s = acc(orgA).store;
    expect(
      await s.advanceCursor({
        repoFullName: REPO,
        defaultBranch: "main",
        fromSha: null,
        toSha: SHA,
      }),
    ).toEqual({ ok: true, value: true });
    await s.observeHead({
      repoFullName: REPO,
      defaultBranch: "main",
      headSha: SHA2,
    });
    const before = await snapshot(orgA);

    await turn(orgA, false);
    await turn(orgA, true);

    expect(await snapshot(orgA)).toEqual(before);
    const cursor = await acc(orgA).store.getCursor({ repoFullName: REPO });
    expect(cursor.ok && cursor.value?.lastSha).toBe(SHA);
    expect(cursor.ok && cursor.value?.observedHeadSha).toBe(SHA2);
  });

  describe("OPS-04 chokepoint", () => {
    async function openOp() {
      await turn(orgA, true);
      const claimId = k("c4");
      const opId = k("o4");
      await seed(orgA, claimId, opId);
      return { claimId, opId };
    }

    it.each([
      ["1001 chars", "x".repeat(1001)],
      ["5 lines", "a\nb\nc\nd\ne"],
    ])(
      "decideOp refuses a claimPatch.statement of %s",
      async (_n, statement) => {
        const { claimId, opId } = await openOp();
        await expect(
          acc(orgA).store.decideOp({
            opId,
            actorUserId: actor,
            slackUserId: null,
            route: "org",
            choice: "edit",
            claimPatch: { statement },
          }),
        ).rejects.toBeInstanceOf(MinimizationError);
        const [op] = await db
          .select()
          .from(schema.knowledgeOp)
          .where(eq(schema.knowledgeOp.id, opId));
        expect(op?.state).toBe("proposed");
        expect(
          (await db.select().from(schema.knowledgeDecision)).filter(
            (d) => d.opId === opId,
          ),
        ).toHaveLength(0);
        const [claim] = await db
          .select()
          .from(schema.knowledgeClaim)
          .where(eq(schema.knowledgeClaim.id, claimId));
        expect(claim?.statement).toBe("Trials last 14 days.");
        expect(claim?.version).toBe(1);
      },
    );

    it.each(["HEAD", "A".repeat(40), "abc123"])(
      "advanceCursor / observeHead refuse sha %s",
      async (bad) => {
        await turn(orgA, true);
        const s = acc(orgA).store;
        await s.advanceCursor({
          repoFullName: REPO,
          defaultBranch: "main",
          fromSha: null,
          toSha: SHA,
        });
        await s.observeHead({
          repoFullName: REPO,
          defaultBranch: "main",
          headSha: SHA,
        });
        await expect(
          s.advanceCursor({
            repoFullName: REPO,
            defaultBranch: "main",
            fromSha: SHA,
            toSha: bad,
          }),
        ).rejects.toBeInstanceOf(MinimizationError);
        await expect(
          s.advanceCursor({
            repoFullName: REPO,
            defaultBranch: "main",
            fromSha: bad,
            toSha: SHA2,
          }),
        ).rejects.toBeInstanceOf(MinimizationError);
        await expect(
          s.observeHead({
            repoFullName: REPO,
            defaultBranch: "main",
            headSha: bad,
          }),
        ).rejects.toBeInstanceOf(MinimizationError);
        const c = await s.getCursor({ repoFullName: REPO });
        expect(c.ok && c.value?.lastSha).toBe(SHA);
        expect(c.ok && c.value?.observedHeadSha).toBe(SHA);
      },
    );
  });

  describe("cross-org (org B against org A's rows)", () => {
    const methods = [
      "insertClaim",
      "insertPins",
      "insertOp",
      "getClaim",
      "listClaims",
      "listOpenOps",
      "loadLatestRejections",
      "insertIntent",
      "listPendingIntents",
      "decideOp",
      "advanceCursor",
      "observeHead",
      "getCursor",
    ] as const;
    type Method = (typeof methods)[number];

    it("a stray organizationId in a non-literal arg never overrides the bound org", async () => {
      await turn(orgA, true);
      await turn(orgB, true);
      const claimId = k("cs");
      await seed(orgA, claimId, k("os"));
      // A parsed payload can carry extra keys that `Bound<>` cannot reject.
      const payload = { repoFullName: REPO, organizationId: orgA };
      expect(await acc(orgB).store.listClaims(payload)).toEqual({
        ok: true,
        value: [],
      });
    });

    it("lists every store method exactly once", () => {
      expect(Object.keys(acc("x").store).sort()).toEqual([...methods].sort());
    });

    it.each(methods)(
      "%s cannot see or change org A",
      async (method: Method) => {
        await turn(orgA, true);
        await turn(orgB, true);
        const claimId = k("cx");
        const opId = k("ox");
        await seed(orgA, claimId, opId);
        await acc(orgA).store.advanceCursor({
          repoFullName: REPO,
          defaultBranch: "main",
          fromSha: null,
          toSha: SHA,
        });
        const before = await snapshot(orgA);
        const b = acc(orgB).store;
        const val = async <T>(p: Promise<{ ok: boolean; value?: T }>) => {
          const r = await p;
          if (!r.ok) throw new Error("gate unexpectedly closed");
          return r.value;
        };

        switch (method) {
          case "insertClaim":
            // Same id from org B must not overwrite org A's row.
            await b
              .insertClaim({
                claim: claimInput(claimId, { statement: "Hijacked." }),
              })
              .catch(() => undefined);
            break;
          case "insertPins":
            await expect(
              b.insertPins({
                claimId,
                pins: [
                  {
                    uri: "repo://x/y.md",
                    hash: "0123456789abcdef",
                    observedRev: SHA,
                  },
                ],
              }),
            ).rejects.toBeInstanceOf(KnowledgeClaimNotFoundError);
            break;
          case "insertOp":
            await expect(
              b.insertOp({ op: opInput(k("oz"), claimId) }),
            ).rejects.toBeInstanceOf(KnowledgeClaimNotFoundError);
            break;
          case "getClaim":
            expect(await val(b.getClaim({ claimId }))).toBeUndefined();
            break;
          case "listClaims":
            expect(await val(b.listClaims({ repoFullName: REPO }))).toEqual([]);
            break;
          case "listOpenOps":
            expect(await val(b.listOpenOps({ repoFullName: REPO }))).toEqual(
              [],
            );
            break;
          case "loadLatestRejections":
            expect(
              await val(b.loadLatestRejections({ claimIds: [claimId] })),
            ).toEqual([]);
            break;
          case "insertIntent":
            await val(
              b.insertIntent({
                repoFullName: REPO,
                defaultBranch: "main",
                targetSha: SHA,
              }),
            );
            break;
          case "listPendingIntents":
            expect(await val(b.listPendingIntents())).toEqual([]);
            break;
          case "decideOp":
            expect(
              await val(
                b.decideOp({
                  opId,
                  actorUserId: actor,
                  slackUserId: null,
                  route: "org",
                  choice: "edit",
                  claimPatch: { statement: "Hijacked." },
                }),
              ),
            ).toEqual({ result: "not_found" });
            break;
          case "advanceCursor":
            expect(
              await val(
                b.advanceCursor({
                  repoFullName: REPO,
                  defaultBranch: "main",
                  fromSha: SHA,
                  toSha: SHA2,
                }),
              ),
            ).toBe(false);
            break;
          case "observeHead":
            await val(
              b.observeHead({
                repoFullName: REPO,
                defaultBranch: "main",
                headSha: SHA2,
              }),
            );
            break;
          case "getCursor":
            expect(await val(b.getCursor({ repoFullName: REPO }))).toBeNull();
            break;
        }

        // Org A's rows are untouched by anything org B did.
        expect(await snapshot(orgA)).toEqual(before);
      },
    );
  });
});
