import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { createDb, rowsOf, type DB } from "../db";
import * as schema from "../db/schema";
import {
  claimDueKnowledgeIntents,
  failKnowledgeIntent,
  knowledgeIntentBackoffMs,
  listKnowledgeHeadCheckCandidates,
  recoverKnowledgeHeadIntent,
  KNOWLEDGE_HEAD_CHECK_SLOTS,
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
    const offOrg = await createTestOrg({ db, name: "Globex" });
    await setEngine(offOrg, false);
    const nullOrg = await createTestOrg({ db, name: "Initech" });
    const offboarded = await createTestOrg({ db, name: "Example" });
    await setEngine(offboarded, true, new Date(NOW.getTime() - HOUR));
    const ids = [
      await seed("acme/a", 1, { organizationId: offOrg }),
      await seed("acme/a", 2, { organizationId: nullOrg }),
      await seed("acme/a", 3, { organizationId: offboarded }),
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

describe("knowledge head check (D-03 / PD-19)", () => {
  let db: DB;
  let org: string;
  const REPO = "acme/repo-a";

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

  const cursor = (
    repo: string,
    over: Partial<typeof schema.knowledgeCursor.$inferInsert> = {},
    organizationId = org,
  ) =>
    db.insert(schema.knowledgeCursor).values({
      organizationId,
      repoFullName: repo,
      defaultBranch: "main",
      ...over,
    });

  const slotOf = async (organizationId: string, repo: string) => {
    const rows = rowsOf<{ s: number }>(
      await db.execute(
        sql`SELECT (abs(hashtext(${organizationId} || ':' || ${repo})::bigint) % ${KNOWLEDGE_HEAD_CHECK_SLOTS})::int AS s`,
      ),
    );
    return rows[0]!.s;
  };

  const intentRows = () =>
    db
      .select()
      .from(schema.knowledgeIntent)
      .where(eq(schema.knowledgeIntent.organizationId, org));

  const cursorRow = async (repo = REPO) =>
    (
      await db
        .select()
        .from(schema.knowledgeCursor)
        .where(
          and(
            eq(schema.knowledgeCursor.organizationId, org),
            eq(schema.knowledgeCursor.repoFullName, repo),
          ),
        )
    )[0];

  const recover = (
    headSha: string,
    over: { now?: Date; organizationId?: string; client?: DB } = {},
  ) =>
    recoverKnowledgeHeadIntent({
      db: over.client ?? db,
      organizationId: over.organizationId ?? org,
      repoFullName: REPO,
      defaultBranch: "main",
      headSha,
      now: over.now ?? NOW,
    });

  beforeEach(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await db.delete(schema.knowledgeIntent);
    await db.delete(schema.knowledgeCursor);
    org = await createTestOrg({ db, name: "Acme" });
    await setEngine(org, true);
  });

  describe("listKnowledgeHeadCheckCandidates", () => {
    const list = (
      slot: number,
      now = NOW,
      limit = 5,
    ): Promise<Awaited<ReturnType<typeof listKnowledgeHeadCheckCandidates>>> =>
      listKnowledgeHeadCheckCandidates({ db, now, slot, limit });

    it("returns only the repos hashed into the slot, with their cursor fields", async () => {
      const repos = Array.from({ length: 40 }, (_, i) => `acme/r-${i}`);
      for (const r of repos) await cursor(r, { lastSha: sha(1) });
      const slot = await slotOf(org, repos[0]!);
      const expected = [];
      for (const r of repos) {
        if ((await slotOf(org, r)) === slot) expected.push(r);
      }
      const out = await list(slot, NOW, 100);
      expect(out.map((c) => c.repoFullName).sort()).toEqual(expected.sort());
      expect(out[0]).toMatchObject({
        organizationId: org,
        defaultBranch: "main",
        lastSha: sha(1),
        observedHeadSha: null,
      });
    });

    it("rejects an out-of-range slot", async () => {
      await expect(list(15)).rejects.toThrow("slot");
      await expect(list(-1)).rejects.toThrow("slot");
    });

    it("includes review-settings repos, never the * sentinel", async () => {
      await db.insert(schema.repoReviewSettings).values([
        { organizationId: org, repoFullName: "Acme/Settings-Repo" },
        { organizationId: org, repoFullName: "*" },
      ]);
      const slot = await slotOf(org, "acme/settings-repo");
      const out = await list(slot);
      expect(out.map((c) => c.repoFullName)).toContain("acme/settings-repo");
      expect(out.map((c) => c.repoFullName)).not.toContain("*");
      expect(
        out.find((c) => c.repoFullName.endsWith("settings-repo")),
      ).toMatchObject({
        defaultBranch: null,
        lastSha: null,
      });
    });

    it("skips Off and offboarded orgs", async () => {
      const off = await createTestOrg({ db, name: "Globex" });
      await setEngine(off, false);
      const gone = await createTestOrg({ db, name: "Example" });
      await setEngine(gone, true, new Date(NOW.getTime() - HOUR));
      await cursor(REPO, {}, off);
      await cursor(REPO, {}, gone);
      await cursor(REPO);
      for (const o of [off, gone, org]) {
        const out = await list(await slotOf(o, REPO));
        const orgs = out.map((c) => c.organizationId);
        expect(orgs.includes(o)).toBe(o === org);
      }
    });

    it("excludes a repo with an open intent and a repo with a recent push", async () => {
      await cursor(REPO);
      const slot = await slotOf(org, REPO);
      expect((await list(slot)).map((c) => c.repoFullName)).toEqual([REPO]);

      await db.insert(schema.knowledgeIntent).values({
        id: `intent:${org}:${REPO}@${sha(1)}`,
        organizationId: org,
        repoFullName: REPO,
        defaultBranch: "main",
        targetSha: sha(1),
        state: "pending",
      });
      expect(await list(slot)).toEqual([]);
      await db.delete(schema.knowledgeIntent);

      await db
        .update(schema.knowledgeCursor)
        .set({ lastPushAt: new Date(NOW.getTime() - 30_000) });
      expect(await list(slot)).toEqual([]);
      await db
        .update(schema.knowledgeCursor)
        .set({ lastPushAt: new Date(NOW.getTime() - 3 * MIN) });
      expect((await list(slot)).map((c) => c.repoFullName)).toEqual([REPO]);
    });

    it("returns a deterministic 5-repo window that covers a 12-repo slot across rotations", async () => {
      const found = rowsOf<{ r: string }>(
        await db.execute(sql`
          SELECT 'acme/r-' || i AS r
          FROM generate_series(1, 600) AS i
          WHERE abs(hashtext(${org} || ':' || 'acme/r-' || i)::bigint)
                % ${KNOWLEDGE_HEAD_CHECK_SLOTS}
              = abs(hashtext(${org} || ':' || 'acme/r-1')::bigint)
                % ${KNOWLEDGE_HEAD_CHECK_SLOTS}
          ORDER BY i
          LIMIT 12
        `),
      ).map((x) => x.r);
      expect(found).toHaveLength(12);
      for (const r of found) await cursor(r);
      const slot = await slotOf(org, found[0]!);

      // Ranked order as the SQL defines it: hash, org, repo.
      const hashes = rowsOf<{ r: string; h: string }>(
        await db.execute(sql`
          SELECT r, abs(hashtext(${org} || ':' || r)::bigint)::text AS h
          FROM unnest(${sql.raw(
            `ARRAY[${found.map((f) => `'${f}'`).join(",")}]::text[]`,
          )}) AS r
        `),
      );
      const ranked = hashes
        .sort(
          (a, b) => Number(BigInt(a.h) - BigInt(b.h)) || (a.r < b.r ? -1 : 1),
        )
        .map((x) => x.r);

      const seen = new Set<string>();
      for (let k = 0; k < 3; k++) {
        const at = new Date(NOW.getTime() + k * 15 * MIN);
        const first = (await list(slot, at)).map((c) => c.repoFullName);
        const again = (await list(slot, at)).map((c) => c.repoFullName);
        expect(first).toHaveLength(5);
        expect(again).toEqual(first);
        const offset = (Math.floor(at.getTime() / 1000 / 900) * 5) % 12;
        const expected = Array.from(
          { length: 5 },
          (_, i) => ranked[(offset + i) % 12]!,
        );
        expect([...first].sort()).toEqual([...expected].sort());
        first.forEach((r) => seen.add(r));
      }
      expect(seen.size).toBe(12);
    });
  });

  describe("recoverKnowledgeHeadIntent", () => {
    it("is in_sync when the head equals the cursor's last_sha", async () => {
      await cursor(REPO, { lastSha: sha(1), observedHeadSha: sha(1) });
      expect((await recover(sha(1))).outcome).toBe("in_sync");
      expect(await intentRows()).toEqual([]);
    });

    it("inserts an intent and a cursor row when there is no cursor", async () => {
      const r = await recover(sha(2));
      expect(r).toEqual({
        outcome: "inserted",
        intentId: `intent:${org}:${REPO}@${sha(2)}`,
      });
      const rows = await intentRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: "pending",
        targetSha: sha(2),
        defaultBranch: "main",
      });
      expect(await cursorRow()).toMatchObject({
        observedHeadSha: sha(2),
        lastSha: null,
        lastPushAt: null,
      });
    });

    it("moves observed_head_sha but never last_sha or last_push_at", async () => {
      const pushedAt = new Date(NOW.getTime() - HOUR);
      await cursor(REPO, {
        lastSha: sha(1),
        observedHeadSha: sha(1),
        lastPushAt: pushedAt,
      });
      expect((await recover(sha(2))).outcome).toBe("inserted");
      const c = await cursorRow();
      expect(c?.observedHeadSha).toBe(sha(2));
      expect(c?.lastSha).toBe(sha(1));
      expect(c?.lastPushAt?.getTime()).toBe(pushedAt.getTime());
    });

    it("keeps a newer observation that is ahead of last_sha", async () => {
      await cursor(REPO, {
        lastSha: sha(1),
        observedHeadSha: sha(3),
        lastPushAt: new Date(NOW.getTime() - HOUR),
      });
      expect((await recover(sha(2))).outcome).toBe("inserted");
      expect((await cursorRow())?.observedHeadSha).toBe(sha(3));
    });

    it("reports open_intent and writes nothing when an intent is open", async () => {
      await db.insert(schema.knowledgeIntent).values({
        id: `intent:${org}:${REPO}@${sha(5)}`,
        organizationId: org,
        repoFullName: REPO,
        defaultBranch: "main",
        targetSha: sha(5),
        state: "processing",
      });
      expect((await recover(sha(2))).outcome).toBe("open_intent");
      expect(await intentRows()).toHaveLength(1);
    });

    it.each(["superseded", "processed"] as const)(
      "reopens a %s intent for the head while the cursor is elsewhere",
      async (state) => {
        await cursor(REPO, { lastSha: sha(1) });
        await db.insert(schema.knowledgeIntent).values({
          id: `intent:${org}:${REPO}@${sha(2)}`,
          organizationId: org,
          repoFullName: REPO,
          defaultBranch: "main",
          targetSha: sha(2),
          state,
          attempts: 3,
          lastErrorCode: "dispatch_failed",
          processedAt: new Date(NOW.getTime() - HOUR),
          nextAttemptAt: new Date(NOW.getTime() - HOUR),
        });
        expect((await recover(sha(2))).outcome).toBe("reopened");
        const [row] = await intentRows();
        expect(row).toMatchObject({
          state: "pending",
          attempts: 0,
          processedAt: null,
          lastErrorCode: null,
        });
        expect(row?.nextAttemptAt.getTime()).toBe(NOW.getTime());
      },
    );

    it("leaves a failed intent for the admin Retry", async () => {
      await db.insert(schema.knowledgeIntent).values({
        id: `intent:${org}:${REPO}@${sha(2)}`,
        organizationId: org,
        repoFullName: REPO,
        defaultBranch: "main",
        targetSha: sha(2),
        state: "failed",
        attempts: 8,
      });
      expect((await recover(sha(2))).outcome).toBe("failed_exists");
      expect((await intentRows())[0]).toMatchObject({
        state: "failed",
        attempts: 8,
      });
    });

    it("writes nothing for an offboarded org and writes for an Off org", async () => {
      await setEngine(org, true, new Date(NOW.getTime() - HOUR));
      expect((await recover(sha(2))).outcome).toBe("offboarded");
      expect(await intentRows()).toEqual([]);
      expect(await cursorRow()).toBeUndefined();

      await setEngine(org, false, null);
      expect((await recover(sha(2))).outcome).toBe("inserted");
      expect(await intentRows()).toHaveLength(1);
    });

    it("reports busy when another client holds the repo lock", async () => {
      const other = createDb(process.env.DATABASE_URL!);
      let release!: () => void;
      let held!: () => void;
      const heldP = new Promise<void>((r) => (held = r));
      const releaseP = new Promise<void>((r) => (release = r));
      const holder = other.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${org} || ':' || ${REPO}))`,
        );
        held();
        await releaseP;
      });
      await heldP;
      try {
        expect((await recover(sha(2))).outcome).toBe("busy");
        expect(await intentRows()).toEqual([]);
      } finally {
        release();
        await holder;
      }
    });

    it("re-checks a recent push under the lock", async () => {
      await cursor(REPO, {
        lastSha: sha(1),
        lastPushAt: new Date(NOW.getTime() - 30_000),
      });
      expect((await recover(sha(2))).outcome).toBe("recent_push");
      expect(await intentRows()).toEqual([]);
    });

    it("produces an intent the claim picks up like a pushed one", async () => {
      await recover(sha(2));
      // next_attempt_at comes from the column default (the database clock),
      // so the claim reads the real clock, not the pinned NOW.
      const claimed = await claimDueKnowledgeIntents({
        db,
        now: new Date(Date.now() + MIN),
      });
      expect(claimed).toEqual([
        {
          id: `intent:${org}:${REPO}@${sha(2)}`,
          organizationId: org,
          repoFullName: REPO,
          targetSha: sha(2),
        },
      ]);
    });
  });
});
