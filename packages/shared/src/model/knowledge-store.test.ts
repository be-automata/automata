import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { rejectionOf, type DraftOp } from "@terragon/knowledge";

import { createDb, type DB } from "../db";
import * as schema from "../db/schema";
import {
  getKnowledgeClaim,
  insertKnowledgeClaim,
  insertKnowledgeIntent,
  insertKnowledgeOp,
  insertKnowledgePins,
  KnowledgeClaimNotFoundError,
  listKnowledgeClaims,
  listOpenKnowledgeOps,
  listPendingKnowledgeIntents,
  loadLatestKnowledgeRejections,
} from "./knowledge-store";
import { MinimizationError } from "./knowledge-minimize";
import { createTestOrg } from "./test-helpers";

const SHA = "a".repeat(40);

describe("knowledge store", () => {
  let db: DB;
  let orgA: string;
  let orgB: string;
  let k: (id: string) => string;

  beforeEach(async () => {
    const run = Math.random().toString(36).slice(2, 10);
    k = (id) => `${id}-${run}`;
    db = createDb(process.env.DATABASE_URL!);
    orgA = await createTestOrg({ db, name: "Acme" });
    orgB = await createTestOrg({ db, name: "Globex" });
  });

  const claimInput = (id: string, overrides = {}) => ({
    id,
    repoFullName: "acme/docs",
    page: "billing-faq",
    statement: "Trials last 14 days.",
    ...overrides,
  });

  function draftOp(id: string, claimId: string, overrides = {}) {
    return {
      id,
      claimId,
      op: "update",
      auto: false,
      before: "Trials last 14 days.",
      after: "Trials last 30 days.",
      why: "The source changed.",
      evidence: ["repo://acme/docs/pricing.md"],
      evidenceFingerprint: "0123456789abcdef",
      ...overrides,
    };
  }

  const opRow = async (id: string) =>
    (
      await db
        .select()
        .from(schema.knowledgeOp)
        .where(eq(schema.knowledgeOp.id, id))
    )[0];

  async function seedOp(
    organizationId: string,
    claimId: string,
    id: string,
    overrides: Record<string, unknown> = {},
  ) {
    await insertKnowledgeOp({
      db,
      organizationId,
      op: {
        id,
        claimId,
        kind: "update",
        baseVersion: 1,
        mergeRev: "abc1234",
        proposal: draftOp(id, claimId, overrides),
      },
    });
  }

  describe("claims", () => {
    it("stores a claim and is idempotent on id", async () => {
      const id = k("c1");
      expect(
        await insertKnowledgeClaim({
          db,
          organizationId: orgA,
          claim: claimInput(id),
        }),
      ).toEqual({ inserted: true });
      expect(
        await insertKnowledgeClaim({
          db,
          organizationId: orgA,
          claim: claimInput(id),
        }),
      ).toEqual({ inserted: false });
    });

    it("rejects an over-long statement and writes nothing", async () => {
      const id = k("c2");
      await expect(
        insertKnowledgeClaim({
          db,
          organizationId: orgA,
          claim: claimInput(id, { statement: "x".repeat(1001) }),
        }),
      ).rejects.toBeInstanceOf(MinimizationError);
      expect(
        await getKnowledgeClaim({ db, organizationId: orgA, claimId: id }),
      ).toBeUndefined();
    });

    it("rejects a bad repo and a multi-line page", async () => {
      for (const bad of [{ repoFullName: "not a repo" }, { page: "a\nb" }]) {
        const id = k("c3");
        await expect(
          insertKnowledgeClaim({
            db,
            organizationId: orgA,
            claim: claimInput(id, bad),
          }),
        ).rejects.toBeInstanceOf(MinimizationError);
        expect(
          await getKnowledgeClaim({ db, organizationId: orgA, claimId: id }),
        ).toBeUndefined();
      }
    });

    it("is org-fenced on get and list", async () => {
      const id = k("c4");
      await insertKnowledgeClaim({
        db,
        organizationId: orgA,
        claim: claimInput(id),
      });
      expect(
        await getKnowledgeClaim({ db, organizationId: orgB, claimId: id }),
      ).toBeUndefined();
      expect(
        await listKnowledgeClaims({
          db,
          organizationId: orgB,
          repoFullName: "acme/docs",
        }),
      ).toEqual([]);
      const got = await getKnowledgeClaim({
        db,
        organizationId: orgA,
        claimId: id,
      });
      expect(got?.id).toBe(id);
      expect(got?.pins).toEqual([]);
    });
  });

  describe("pins", () => {
    it("upserts on (claim, uri) and copies the repo", async () => {
      const id = k("p1");
      await insertKnowledgeClaim({
        db,
        organizationId: orgA,
        claim: claimInput(id),
      });
      const pin = {
        uri: "repo://acme/docs/pricing.md",
        hash: "0123456789abcdef",
        observedRev: SHA,
      };
      await insertKnowledgePins({
        db,
        organizationId: orgA,
        claimId: id,
        pins: [pin],
      });
      await insertKnowledgePins({
        db,
        organizationId: orgA,
        claimId: id,
        pins: [{ ...pin, hash: "fedcba9876543210" }],
      });
      const got = await getKnowledgeClaim({
        db,
        organizationId: orgA,
        claimId: id,
      });
      expect(got?.pins).toHaveLength(1);
      expect(got?.pins[0]).toMatchObject({
        hash: "fedcba9876543210",
        repoFullName: "acme/docs",
      });
    });

    it("rejects a bad hash and a foreign claim", async () => {
      const id = k("p2");
      await insertKnowledgeClaim({
        db,
        organizationId: orgA,
        claim: claimInput(id),
      });
      const pin = {
        uri: "repo://acme/docs/pricing.md",
        hash: "0123456789abcdef",
        observedRev: SHA,
      };
      await expect(
        insertKnowledgePins({
          db,
          organizationId: orgA,
          claimId: id,
          pins: [{ ...pin, hash: "nope" }],
        }),
      ).rejects.toBeInstanceOf(MinimizationError);
      await expect(
        insertKnowledgePins({
          db,
          organizationId: orgB,
          claimId: id,
          pins: [pin],
        }),
      ).rejects.toBeInstanceOf(KnowledgeClaimNotFoundError);
      const rows = await db
        .select()
        .from(schema.knowledgePin)
        .where(eq(schema.knowledgePin.claimId, id));
      expect(rows).toEqual([]);
    });
  });

  describe("ops", () => {
    it("writes an op with the fingerprint column and is idempotent", async () => {
      const claimId = k("o1");
      const opId = k("op:billing/o1@abc");
      await insertKnowledgeClaim({
        db,
        organizationId: orgA,
        claim: claimInput(claimId),
      });
      const input = {
        id: opId,
        claimId,
        kind: "update",
        baseVersion: 1,
        mergeRev: "abc1234",
        proposal: draftOp(opId, claimId),
      };
      expect(
        await insertKnowledgeOp({ db, organizationId: orgA, op: input }),
      ).toEqual({ inserted: true });
      expect(
        await insertKnowledgeOp({ db, organizationId: orgA, op: input }),
      ).toEqual({ inserted: false });
      const row = await opRow(opId);
      expect(row).toMatchObject({
        kind: "update",
        baseVersion: 1,
        mergeRev: "abc1234",
        evidenceFingerprint: "0123456789abcdef",
        repoFullName: "acme/docs",
        organizationId: orgA,
      });
    });

    it("rejects extra keys and mismatched ids, writing nothing", async () => {
      const claimId = k("o2");
      const opId = k("op:o2");
      await insertKnowledgeClaim({
        db,
        organizationId: orgA,
        claim: claimInput(claimId),
      });
      const base = {
        id: opId,
        claimId,
        kind: "update",
        baseVersion: 1,
        mergeRev: "abc1234",
      };
      await expect(
        insertKnowledgeOp({
          db,
          organizationId: orgA,
          op: {
            ...base,
            proposal: { ...draftOp(opId, claimId), rawText: "secret" },
          },
        }),
      ).rejects.toBeInstanceOf(MinimizationError);
      await expect(
        insertKnowledgeOp({
          db,
          organizationId: orgA,
          op: { ...base, proposal: draftOp("other-id", claimId) },
        }),
      ).rejects.toThrow(/proposal.id/);
      await expect(
        insertKnowledgeOp({
          db,
          organizationId: orgA,
          op: { ...base, proposal: draftOp(opId, "other-claim") },
        }),
      ).rejects.toThrow(/proposal.claimId/);
      expect(await opRow(opId)).toBeUndefined();
    });

    it("refuses another org's claim", async () => {
      const claimId = k("o3");
      const opId = k("op:o3");
      await insertKnowledgeClaim({
        db,
        organizationId: orgA,
        claim: claimInput(claimId),
      });
      await expect(
        insertKnowledgeOp({
          db,
          organizationId: orgB,
          op: {
            id: opId,
            claimId,
            kind: "update",
            baseVersion: 1,
            mergeRev: "abc1234",
            proposal: draftOp(opId, claimId),
          },
        }),
      ).rejects.toBeInstanceOf(KnowledgeClaimNotFoundError);
      expect(await opRow(opId)).toBeUndefined();
    });

    it("lists only the caller's proposed and reopened ops", async () => {
      const claimId = k("o4");
      await insertKnowledgeClaim({
        db,
        organizationId: orgA,
        claim: claimInput(claimId),
      });
      const open = k("op:open");
      const done = k("op:done");
      await seedOp(orgA, claimId, open);
      await seedOp(orgA, claimId, done);
      await db
        .update(schema.knowledgeOp)
        .set({ state: "applied" })
        .where(eq(schema.knowledgeOp.id, done));
      const mine = await listOpenKnowledgeOps({
        db,
        organizationId: orgA,
        repoFullName: "acme/docs",
      });
      expect(mine.map((o) => o.id)).toContain(open);
      expect(mine.map((o) => o.id)).not.toContain(done);
      expect(await listOpenKnowledgeOps({ db, organizationId: orgB })).toEqual(
        [],
      );
    });
  });

  describe("latest rejections", () => {
    async function reject(id: string, at: Date) {
      await db
        .update(schema.knowledgeOp)
        .set({ state: "rejected", updatedAt: at })
        .where(eq(schema.knowledgeOp.id, id));
    }

    it("returns the newest rejection per claim, equal to rejectionOf", async () => {
      const claimId = k("r1");
      await insertKnowledgeClaim({
        db,
        organizationId: orgA,
        claim: claimInput(claimId),
      });
      const older = k("op:r-old");
      const newer = k("op:r-new");
      const proposed = k("op:r-open");
      await seedOp(orgA, claimId, older, {
        evidenceFingerprint: "1111111111111111",
      });
      await seedOp(orgA, claimId, newer, {
        evidenceFingerprint: "2222222222222222",
        locatedEvidence: ["repo://acme/docs/pricing.md"],
      });
      await seedOp(orgA, claimId, proposed);
      await reject(older, new Date("2026-10-01T00:00:00Z"));
      await reject(newer, new Date("2026-10-02T00:00:00Z"));

      const out = await loadLatestKnowledgeRejections({
        db,
        organizationId: orgA,
        claimIds: [claimId],
      });
      expect(out).toHaveLength(1);
      const row = await opRow(newer);
      const expected = rejectionOf({
        ...(row?.proposal as DraftOp),
        id: newer,
        claimId,
        op: "update",
      } as DraftOp);
      expect(out[0]).toEqual(expected);
      expect(out[0]?.opId).toBe(newer);
    });

    it("omits locatedEvidence when absent", async () => {
      const claimId = k("r2");
      await insertKnowledgeClaim({
        db,
        organizationId: orgA,
        claim: claimInput(claimId),
      });
      const opId = k("op:r2");
      await seedOp(orgA, claimId, opId);
      await reject(opId, new Date("2026-10-01T00:00:00Z"));
      const [got] = await loadLatestKnowledgeRejections({
        db,
        organizationId: orgA,
        claimIds: [claimId],
      });
      expect(got).toBeDefined();
      expect("locatedEvidence" in (got ?? {})).toBe(false);
    });

    it("ignores rows without a fingerprint, empty input and foreign orgs", async () => {
      const claimId = k("r3");
      await insertKnowledgeClaim({
        db,
        organizationId: orgA,
        claim: claimInput(claimId),
      });
      const opId = k("op:r3");
      await seedOp(orgA, claimId, opId);
      await reject(opId, new Date("2026-10-01T00:00:00Z"));
      expect(
        await loadLatestKnowledgeRejections({
          db,
          organizationId: orgB,
          claimIds: [claimId],
        }),
      ).toEqual([]);
      expect(
        await loadLatestKnowledgeRejections({
          db,
          organizationId: orgA,
          claimIds: [],
        }),
      ).toEqual([]);
      await db
        .update(schema.knowledgeOp)
        .set({ evidenceFingerprint: null })
        .where(
          and(
            eq(schema.knowledgeOp.id, opId),
            eq(schema.knowledgeOp.organizationId, orgA),
          ),
        );
      expect(
        await loadLatestKnowledgeRejections({
          db,
          organizationId: orgA,
          claimIds: [claimId],
        }),
      ).toEqual([]);
    });
  });

  describe("intents", () => {
    it("is idempotent per org/repo/sha and per-org distinct", async () => {
      const sha = Math.random().toString(16).slice(2).padEnd(40, "0");
      const input = {
        repoFullName: "acme/docs",
        defaultBranch: "main",
        targetSha: sha.slice(0, 40),
      };
      const a = await insertKnowledgeIntent({
        db,
        organizationId: orgA,
        ...input,
      });
      expect(a).toEqual({
        id: `intent:${orgA}:acme/docs@${input.targetSha}`,
        inserted: true,
      });
      expect(
        (await insertKnowledgeIntent({ db, organizationId: orgA, ...input }))
          .inserted,
      ).toBe(false);
      const b = await insertKnowledgeIntent({
        db,
        organizationId: orgB,
        ...input,
      });
      expect(b.inserted).toBe(true);
      expect(b.id).not.toBe(a.id);
    });

    it("rejects invalid sha and branch, writing nothing", async () => {
      for (const bad of [
        { targetSha: "HEAD" },
        { targetSha: "A".repeat(40) },
        { defaultBranch: "ma in" },
      ]) {
        await expect(
          insertKnowledgeIntent({
            db,
            organizationId: orgA,
            repoFullName: "acme/docs",
            defaultBranch: "main",
            targetSha: SHA,
            ...bad,
          }),
        ).rejects.toBeInstanceOf(MinimizationError);
      }
      const rows = await db
        .select()
        .from(schema.knowledgeIntent)
        .where(eq(schema.knowledgeIntent.organizationId, orgA));
      expect(rows).toEqual([]);
    });

    it("lists only own, due, pending intents oldest first", async () => {
      const mk = (c: string) => c.repeat(40);
      for (const c of ["1", "2", "3"]) {
        await insertKnowledgeIntent({
          db,
          organizationId: orgA,
          repoFullName: "acme/docs",
          defaultBranch: "main",
          targetSha: mk(c),
        });
      }
      await insertKnowledgeIntent({
        db,
        organizationId: orgB,
        repoFullName: "acme/docs",
        defaultBranch: "main",
        targetSha: mk("4"),
      });
      const now = new Date();
      await db
        .update(schema.knowledgeIntent)
        .set({ nextAttemptAt: new Date(now.getTime() + 3_600_000) })
        .where(eq(schema.knowledgeIntent.targetSha, mk("2")));
      await db
        .update(schema.knowledgeIntent)
        .set({ state: "processed" })
        .where(eq(schema.knowledgeIntent.targetSha, mk("3")));
      const out = await listPendingKnowledgeIntents({
        db,
        organizationId: orgA,
        now,
      });
      expect(out.map((i) => i.targetSha)).toEqual([mk("1")]);
    });
  });
});
