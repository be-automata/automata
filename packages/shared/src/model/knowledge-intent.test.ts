import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { createDb, rowsOf, type DB } from "../db";
import * as schema from "../db/schema";
import {
  claimDueKnowledgeIntents,
  failKnowledgeIntent,
  knowledgeIntentBackoffMs,
  releaseKnowledgeIntent,
  requeueExpiredKnowledgeIntents,
  KNOWLEDGE_INTENT_LEASE_MS,
} from "./knowledge-intent";
import { createTestOrg } from "./test-helpers";

const NOW = new Date("2026-11-02T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const sha = (n: number) => n.toString(16).padStart(40, "0");

describe("knowledgeIntentBackoffMs", () => {
  it("doubles from 1m, caps at 30m, jitters +/-25% by the injected rng", () => {
    expect(knowledgeIntentBackoffMs(1, () => 0.5)).toBe(60_000);
    expect(knowledgeIntentBackoffMs(2, () => 0.5)).toBe(120_000);
    expect(knowledgeIntentBackoffMs(3, () => 0.5)).toBe(240_000);
    expect(knowledgeIntentBackoffMs(6, () => 0.5)).toBe(1_800_000);
    expect(knowledgeIntentBackoffMs(8, () => 0.5)).toBe(1_800_000);
    expect(knowledgeIntentBackoffMs(1, () => 0)).toBe(45_000);
    expect(knowledgeIntentBackoffMs(1, () => 1)).toBe(75_000);
  });
});

describe("claimDueKnowledgeIntents", () => {
  let db: DB;
  let org: string;

  beforeEach(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await db.delete(schema.knowledgeIntent);
    org = await createTestOrg({ db, name: "Acme" });
    await setEngine(org, true);
  });

  const setEngine = (
    organizationId: string,
    knowledgeEngine: boolean | null,
    knowledgeOffboardedAt: Date | null = null,
  ) =>
    db
      .insert(schema.organizationReviewSettings)
      .values({ organizationId, knowledgeEngine, knowledgeOffboardedAt })
      .onConflictDoUpdate({
        target: [schema.organizationReviewSettings.organizationId],
        set: { knowledgeEngine, knowledgeOffboardedAt },
      });

  const seed = async (
    repo: string,
    n: number,
    opts: {
      organizationId?: string;
      createdAt?: Date;
      nextAttemptAt?: Date;
      state?: schema.KnowledgeIntentState;
      attempts?: number;
    } = {},
  ) => {
    const organizationId = opts.organizationId ?? org;
    const id = `intent:${organizationId}:${repo}@${sha(n)}`;
    await db.insert(schema.knowledgeIntent).values({
      id,
      organizationId,
      repoFullName: repo,
      defaultBranch: "main",
      targetSha: sha(n),
      state: opts.state ?? "pending",
      attempts: opts.attempts ?? 0,
      createdAt: opts.createdAt ?? new Date(NOW.getTime() - HOUR + n * 1000),
      nextAttemptAt: opts.nextAttemptAt ?? new Date(NOW.getTime() - MIN),
    });
    return id;
  };

  const row = async (id: string) =>
    (
      await db
        .select()
        .from(schema.knowledgeIntent)
        .where(eq(schema.knowledgeIntent.id, id))
    )[0]!;

  it("claims the newest per repo, supersedes the older, leaves attempts alone", async () => {
    const a = await seed("acme/docs", 1);
    const b = await seed("acme/docs", 2);
    const claimed = await claimDueKnowledgeIntents({ db, now: NOW });
    expect(claimed).toEqual([
      {
        id: b,
        organizationId: org,
        repoFullName: "acme/docs",
        targetSha: sha(2),
      },
    ]);
    const rb = await row(b);
    expect(rb.state).toBe("processing");
    expect(rb.nextAttemptAt.getTime()).toBe(
      NOW.getTime() + KNOWLEDGE_INTENT_LEASE_MS,
    );
    expect(rb.attempts).toBe(0);
    const ra = await row(a);
    expect(ra.state).toBe("superseded");
    expect(ra.processedAt?.getTime()).toBe(NOW.getTime());
    expect(ra.attempts).toBe(0);
  });

  it("does not claim a repo whose newest pending is not due, but still supersedes the older", async () => {
    const a = await seed("acme/docs", 1);
    const b = await seed("acme/docs", 2, {
      nextAttemptAt: new Date(NOW.getTime() + 5 * MIN),
    });
    expect(await claimDueKnowledgeIntents({ db, now: NOW })).toEqual([]);
    expect((await row(a)).state).toBe("superseded");
    expect((await row(b)).state).toBe("pending");
  });

  it("skips a repo with a live lease", async () => {
    await seed("acme/docs", 1, {
      state: "processing",
      nextAttemptAt: new Date(NOW.getTime() + 10 * MIN),
    });
    const p = await seed("acme/docs", 2);
    expect(await claimDueKnowledgeIntents({ db, now: NOW })).toEqual([]);
    expect((await row(p)).state).toBe("pending");
  });

  it("skips a repo with an expired lease that was not requeued", async () => {
    await seed("acme/docs", 1, {
      state: "processing",
      nextAttemptAt: new Date(NOW.getTime() - 10 * MIN),
    });
    const p = await seed("acme/docs", 2);
    expect(await claimDueKnowledgeIntents({ db, now: NOW })).toEqual([]);
    expect((await row(p)).state).toBe("pending");
  });

  it("claims the true newest of a 500-row backlog next to nine other repos", async () => {
    const big = Array.from(
      { length: 500 },
      (_, i) => `intent:${org}:acme/big@${sha(i + 1)}`,
    );
    await db.insert(schema.knowledgeIntent).values(
      big.map((id, i) => ({
        id,
        organizationId: org,
        repoFullName: "acme/big",
        defaultBranch: "main",
        targetSha: sha(i + 1),
        createdAt: new Date(NOW.getTime() - HOUR + (i + 1) * 1000),
        nextAttemptAt: new Date(NOW.getTime() - MIN),
      })),
    );
    for (let r = 0; r < 9; r++) await seed(`acme/r${r}`, 1000 + r);
    const claimed = await claimDueKnowledgeIntents({ db, now: NOW, limit: 10 });
    expect(claimed).toHaveLength(10);
    const bigClaimed = claimed.filter((c) => c.repoFullName === "acme/big");
    expect(bigClaimed.map((c) => c.id)).toEqual([big[499]]);
    const rows = await db
      .select({ state: schema.knowledgeIntent.state })
      .from(schema.knowledgeIntent)
      .where(eq(schema.knowledgeIntent.repoFullName, "acme/big"));
    expect(rows.filter((r) => r.state === "superseded")).toHaveLength(499);
    expect(rows.filter((r) => r.state === "processing")).toHaveLength(1);
  });

  it("applies the limit to repos, oldest-waiting repo first", async () => {
    for (let r = 0; r < 15; r++) await seed(`acme/r${r}`, r + 1);
    const claimed = await claimDueKnowledgeIntents({ db, now: NOW, limit: 10 });
    expect(claimed).toHaveLength(10);
    expect(new Set(claimed.map((c) => c.repoFullName)).size).toBe(10);
    expect(claimed.map((c) => c.repoFullName)).toEqual(
      Array.from({ length: 10 }, (_, r) => `acme/r${r}`),
    );
  });

  it("a held per-repo advisory lock skips the repo, and a processing row committed meanwhile keeps it skipped", async () => {
    const p = await seed("acme/docs", 2);
    const other = createDb(process.env.DATABASE_URL!);
    await other.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${org} || ':' || ${"acme/docs"}))`,
      );
      expect(await claimDueKnowledgeIntents({ db, now: NOW })).toEqual([]);
      await tx.insert(schema.knowledgeIntent).values({
        id: `intent:${org}:acme/docs@${sha(1)}`,
        organizationId: org,
        repoFullName: "acme/docs",
        defaultBranch: "main",
        targetSha: sha(1),
        state: "processing",
        createdAt: new Date(NOW.getTime() - 2 * HOUR),
        nextAttemptAt: new Date(NOW.getTime() + 10 * MIN),
      });
    });
    expect(await claimDueKnowledgeIntents({ db, now: NOW })).toEqual([]);
    expect((await row(p)).state).toBe("pending");
  });

  it("never claims Off, unset or offboarded orgs and spends no attempts", async () => {
    const offOrg = await createTestOrg({ db, name: "Off" });
    await setEngine(offOrg, false);
    const nullOrg = await createTestOrg({ db, name: "Unset" });
    const offboarded = await createTestOrg({ db, name: "Gone" });
    await setEngine(offboarded, true, new Date(NOW.getTime() - HOUR));
    const ids = [
      await seed("o/a", 1, { organizationId: offOrg }),
      await seed("o/a", 2, { organizationId: nullOrg }),
      await seed("o/a", 3, { organizationId: offboarded }),
    ];
    expect(await claimDueKnowledgeIntents({ db, now: NOW })).toEqual([]);
    for (const id of ids) {
      const r = await row(id);
      expect(r.state).toBe("pending");
      expect(r.attempts).toBe(0);
    }
  });

  it("claims an intent that has waited three hours (outage recovery)", async () => {
    const id = await seed("acme/docs", 1, {
      createdAt: new Date(NOW.getTime() - 3 * HOUR),
      nextAttemptAt: new Date(NOW.getTime() - 3 * HOUR),
    });
    const claimed = await claimDueKnowledgeIntents({ db, now: NOW });
    expect(claimed.map((c) => c.id)).toEqual([id]);
  });

  it("an intent recorded while Off is claimed once the engine turns On", async () => {
    await setEngine(org, false);
    const id = await seed("acme/docs", 1);
    expect(await claimDueKnowledgeIntents({ db, now: NOW })).toEqual([]);
    await setEngine(org, true);
    const claimed = await claimDueKnowledgeIntents({ db, now: NOW });
    expect(claimed.map((c) => c.id)).toEqual([id]);
  });

  it("two concurrent claims never return the same row and leave one processing row per repo", async () => {
    for (let r = 0; r < 20; r++) {
      await seed(`acme/r${r}`, r * 2 + 1);
      await seed(`acme/r${r}`, r * 2 + 2);
    }
    const other = createDb(process.env.DATABASE_URL!);
    const [x, y] = await Promise.all([
      claimDueKnowledgeIntents({ db, now: NOW, limit: 10 }),
      claimDueKnowledgeIntents({ db: other, now: NOW, limit: 10 }),
    ]);
    const ids = [...x, ...y].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const rows = rowsOf<{ repo_full_name: string; n: string }>(
      await db.execute(
        sql`select repo_full_name, count(*) as n from knowledge_intent where state = 'processing' group by repo_full_name`,
      ),
    );
    for (const r of rows) expect(Number(r.n)).toBe(1);
    expect(
      (
        await db
          .select({ id: schema.knowledgeIntent.id })
          .from(schema.knowledgeIntent)
          .where(and(eq(schema.knowledgeIntent.state, "processing")))
      ).length,
    ).toBe(ids.length);
  });
});

describe("knowledge intent lease, release and failure", () => {
  let db: DB;
  let org: string;
  const HALF = () => 0.5;

  beforeEach(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await db.delete(schema.knowledgeIntent);
    org = await createTestOrg({ db, name: "Acme" });
  });

  const seed = async (
    n: number,
    state: schema.KnowledgeIntentState,
    attempts: number,
    nextAttemptAt: Date,
  ) => {
    const id = `intent:${org}:acme/docs@${sha(n)}`;
    await db.insert(schema.knowledgeIntent).values({
      id,
      organizationId: org,
      repoFullName: "acme/docs",
      defaultBranch: "main",
      targetSha: sha(n),
      state,
      attempts,
      nextAttemptAt,
    });
    return id;
  };

  const row = async (id: string) =>
    (
      await db
        .select()
        .from(schema.knowledgeIntent)
        .where(eq(schema.knowledgeIntent.id, id))
    )[0]!;

  const past = new Date(NOW.getTime() - MIN);

  describe("requeueExpiredKnowledgeIntents", () => {
    it("returns an expired lease to pending with attempts + 1 and a backoff", async () => {
      const id = await seed(1, "processing", 2, past);
      const res = await requeueExpiredKnowledgeIntents({
        db,
        now: NOW,
        rng: HALF,
      });
      expect(res).toEqual([
        {
          id,
          organizationId: org,
          repoFullName: "acme/docs",
          attempts: 3,
          code: "lease_expired",
          state: "pending",
          becameFailed: false,
        },
      ]);
      const r = await row(id);
      expect(r.state).toBe("pending");
      expect(r.attempts).toBe(3);
      expect(r.lastErrorCode).toBe("lease_expired");
      expect(r.nextAttemptAt.getTime()).toBe(
        NOW.getTime() + knowledgeIntentBackoffMs(3, HALF),
      );
    });

    it("fails an exhausted intent with max_attempts exactly once", async () => {
      const id = await seed(1, "processing", 7, past);
      const res = await requeueExpiredKnowledgeIntents({
        db,
        now: NOW,
        rng: HALF,
      });
      expect(res).toHaveLength(1);
      expect(res[0]).toMatchObject({
        id,
        attempts: 8,
        code: "max_attempts",
        state: "failed",
        becameFailed: true,
      });
      expect((await row(id)).state).toBe("failed");
      expect(
        await requeueExpiredKnowledgeIntents({ db, now: NOW, rng: HALF }),
      ).toEqual([]);
    });

    it("leaves a live lease alone", async () => {
      const id = await seed(
        1,
        "processing",
        0,
        new Date(NOW.getTime() + 5 * MIN),
      );
      expect(await requeueExpiredKnowledgeIntents({ db, now: NOW })).toEqual(
        [],
      );
      expect((await row(id)).state).toBe("processing");
    });
  });

  describe("releaseKnowledgeIntent", () => {
    it("returns a processing intent to pending now, attempts unchanged", async () => {
      const id = await seed(
        1,
        "processing",
        2,
        new Date(NOW.getTime() + 10 * MIN),
      );
      expect(
        await releaseKnowledgeIntent({ db, intentId: id, now: NOW }),
      ).toEqual({ result: "released" });
      const r = await row(id);
      expect(r.state).toBe("pending");
      expect(r.attempts).toBe(2);
      expect(r.nextAttemptAt.getTime()).toBe(NOW.getTime());
    });

    it("reports not_processing for any other state", async () => {
      const id = await seed(1, "pending", 0, past);
      expect(
        await releaseKnowledgeIntent({ db, intentId: id, now: NOW }),
      ).toEqual({ result: "not_processing" });
    });
  });

  describe("failKnowledgeIntent", () => {
    it("records a failure with the code and a 1m backoff", async () => {
      const id = await seed(
        1,
        "processing",
        0,
        new Date(NOW.getTime() + 10 * MIN),
      );
      const res = await failKnowledgeIntent({
        db,
        intentId: id,
        code: "fetch_failed",
        now: NOW,
        rng: HALF,
      });
      expect(res).toEqual({
        result: "recorded",
        state: "pending",
        attempts: 1,
        code: "fetch_failed",
        becameFailed: false,
        organizationId: org,
        repoFullName: "acme/docs",
      });
      const r = await row(id);
      expect(r.nextAttemptAt.getTime()).toBe(NOW.getTime() + 60_000);
      expect(r.lastErrorCode).toBe("fetch_failed");
    });

    it("fails at the eighth attempt with the final code, reporting becameFailed once", async () => {
      const id = await seed(
        1,
        "processing",
        7,
        new Date(NOW.getTime() + 10 * MIN),
      );
      const res = await failKnowledgeIntent({
        db,
        intentId: id,
        code: "fetch_failed",
        now: NOW,
        rng: HALF,
      });
      expect(res).toMatchObject({
        result: "recorded",
        state: "failed",
        attempts: 8,
        code: "fetch_failed",
        becameFailed: true,
      });
      expect(
        await failKnowledgeIntent({
          db,
          intentId: id,
          code: "fetch_failed",
          now: NOW,
          rng: HALF,
        }),
      ).toEqual({ result: "not_processing" });
    });

    it("writes nothing for a pending or processed row", async () => {
      const a = await seed(1, "pending", 0, past);
      const b = await seed(2, "processed", 1, past);
      for (const id of [a, b]) {
        expect(
          await failKnowledgeIntent({
            db,
            intentId: id,
            code: "fetch_failed",
            now: NOW,
            rng: HALF,
          }),
        ).toEqual({ result: "not_processing" });
      }
      expect((await row(a)).attempts).toBe(0);
      expect((await row(b)).attempts).toBe(1);
    });

    it("throws on a code outside the closed enum before any write", async () => {
      const id = await seed(
        1,
        "processing",
        0,
        new Date(NOW.getTime() + 10 * MIN),
      );
      await expect(
        failKnowledgeIntent({
          db,
          intentId: id,
          code: "secret free text" as never,
          now: NOW,
        }),
      ).rejects.toThrow(/code/);
      const r = await row(id);
      expect(r.state).toBe("processing");
      expect(r.attempts).toBe(0);
    });
  });
});
