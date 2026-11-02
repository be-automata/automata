import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { createDb, type DB } from "../db";
import * as schema from "../db/schema";
import {
  KNOWLEDGE_RECONCILE_MAX_CLAIMS,
  KnowledgeReconcileTooLargeError,
  KnowledgeReconcileInvalidError,
  loadKnowledgeReconcileContext,
  publishKnowledgeReconcile,
} from "./knowledge-reconcile";
import {
  listKnowledgeRepoStatus,
  recordKnowledgePush,
} from "./knowledge-repo-status";
import { createTestOrg } from "./test-helpers";

const NOW = new Date("2026-11-02T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
const REPO = "acme/docs";

describe("loadKnowledgeReconcileContext", () => {
  let db: DB;
  let org: string;
  let run: string;

  beforeEach(async () => {
    run = Math.random().toString(36).slice(2, 10);
    db = createDb(process.env.DATABASE_URL!);
    org = await createTestOrg({ db, name: "Acme" });
    await setEngine(org, true);
  });

  const setEngine = (organizationId: string, knowledgeEngine: boolean) =>
    db
      .insert(schema.organizationReviewSettings)
      .values({ organizationId, knowledgeEngine })
      .onConflictDoUpdate({
        target: [schema.organizationReviewSettings.organizationId],
        set: { knowledgeEngine },
      });

  const seedIntent = async (
    state: schema.KnowledgeIntentState = "processing",
    organizationId = org,
  ) => {
    const id = `intent:${organizationId}:${REPO}@${SHA2}`;
    await db.insert(schema.knowledgeIntent).values({
      id,
      organizationId,
      repoFullName: REPO,
      defaultBranch: "main",
      targetSha: SHA2,
      state,
      attempts: 2,
      nextAttemptAt: new Date(NOW.getTime() + 20 * 60_000),
    });
    return id;
  };

  const seedClaim = async (
    id: string,
    page: string,
    pins: { uri: string; hash?: string }[],
    opts: { organizationId?: string; repo?: string; statement?: string } = {},
  ) => {
    const organizationId = opts.organizationId ?? org;
    const claimId = `${id}-${run}`;
    await db.insert(schema.knowledgeClaim).values({
      id: claimId,
      organizationId,
      repoFullName: opts.repo ?? REPO,
      page,
      statement: opts.statement ?? `Statement of ${id}.`,
    });
    for (const pin of pins) {
      await db.insert(schema.knowledgePin).values({
        organizationId,
        claimId,
        repoFullName: opts.repo ?? REPO,
        uri: pin.uri,
        hash: pin.hash ?? "0123456789abcdef",
        observedRev: SHA1,
      });
    }
    return claimId;
  };

  const load = (intentId: string) =>
    loadKnowledgeReconcileContext({ db, intentId, now: NOW });

  it("not_found for an unknown id", async () => {
    expect(await load("intent:nope")).toEqual({
      status: "not_found",
      purgedOrganizationIds: [],
    });
  });

  it.each(["processed", "superseded", "failed", "pending"] as const)(
    "done for a %s row, which stays untouched",
    async (state) => {
      const id = await seedIntent(state);
      const res = await load(id);
      expect(res.status).toBe("done");
      const [row] = await db
        .select()
        .from(schema.knowledgeIntent)
        .where(eq(schema.knowledgeIntent.id, id));
      expect(row?.state).toBe(state);
      expect(row?.attempts).toBe(2);
    },
  );

  it("gated for an Off org: the row goes back to pending, attempts unchanged", async () => {
    const id = await seedIntent("processing");
    await setEngine(org, false);
    const res = await load(id);
    expect(res.status).toBe("gated");
    const [row] = await db
      .select()
      .from(schema.knowledgeIntent)
      .where(eq(schema.knowledgeIntent.id, id));
    expect(row?.state).toBe("pending");
    expect(row?.attempts).toBe(2);
    expect(row?.nextAttemptAt.getTime()).toBe(NOW.getTime());
  });

  it("ready: intent, cursor, sidecars in page order, rejections, purged orgs", async () => {
    const id = await seedIntent();
    await db.insert(schema.knowledgeCursor).values({
      organizationId: org,
      repoFullName: REPO,
      defaultBranch: "main",
      lastSha: SHA1,
      observedHeadSha: SHA2,
    });
    const c2 = await seedClaim("c2", "docs/b.md", [
      { uri: "repo://src/b.ts#L1-L2" },
    ]);
    const c1 = await seedClaim("c1", "docs/a.md", [
      { uri: "repo://src/a.ts#L1-L2", hash: "x:0123456789abcdef" },
    ]);
    const c3 = await seedClaim("c3", "docs/a.md", [
      { uri: "repo://src/c.ts#L3-L4" },
    ]);
    // Foreign org and foreign repo claims never appear.
    const other = await createTestOrg({ db, name: "Other" });
    await seedClaim("foreign-org", "docs/a.md", [], {
      organizationId: other,
    });
    await seedClaim("foreign-repo", "docs/a.md", [], { repo: "acme/other" });
    await db.insert(schema.knowledgeOp).values({
      id: `op-rej-${run}`,
      organizationId: org,
      claimId: c1,
      repoFullName: REPO,
      kind: "update",
      baseVersion: 1,
      mergeRev: SHA1,
      state: "rejected",
      evidenceFingerprint: "0123456789abcdef",
      proposal: {
        id: `op-rej-${run}`,
        claimId: c1,
        op: "update",
        auto: false,
        before: "Statement of c1.",
        why: "changed",
        evidence: ["repo://src/a.ts#L1-L2"],
      },
    });
    const recent = await createTestOrg({ db, name: "Recent" });
    const old = await createTestOrg({ db, name: "Old" });
    await db.insert(schema.organizationReviewSettings).values([
      {
        organizationId: recent,
        knowledgePurgedAt: new Date(NOW.getTime() - 2 * DAY),
      },
      {
        organizationId: old,
        knowledgePurgedAt: new Date(NOW.getTime() - 40 * DAY),
      },
    ]);

    const res = await load(id);
    if (res.status !== "ready") throw new Error("expected ready");
    expect(res.intent).toEqual({
      id,
      organizationId: org,
      repoFullName: REPO,
      defaultBranch: "main",
      targetSha: SHA2,
    });
    expect(res.cursor).toEqual({ lastSha: SHA1 });
    expect(res.excludedClaims).toBe(0);
    expect(res.sidecars.map((s) => s.page)).toEqual(["docs/a.md", "docs/b.md"]);
    expect(res.sidecars[0]?.claims.map((c) => c.id)).toEqual([c1, c3].sort());
    const claim1 = res.sidecars[0]?.claims.find((c) => c.id === c1);
    expect(claim1).toEqual({
      id: c1,
      statement: "Statement of c1.",
      version: 1,
      evidence: [{ uri: "repo://src/a.ts#L1-L2", hash: "x:0123456789abcdef" }],
    });
    expect(res.sidecars[1]?.claims.map((c) => c.id)).toEqual([c2]);
    expect(res.rejected.map((r) => r.claimId)).toEqual([c1]);
    expect(res.purgedOrganizationIds).toContain(recent);
    expect(res.purgedOrganizationIds).not.toContain(old);
  });

  it("ready with no cursor row: lastSha is null", async () => {
    const id = await seedIntent();
    const res = await load(id);
    if (res.status !== "ready") throw new Error("expected ready");
    expect(res.cursor).toEqual({ lastSha: null });
    expect(res.sidecars).toEqual([]);
  });

  it("admits repo and ticket claims, excludes doc pins and bad paths (PD-21, PD-24, PD-25)", async () => {
    const id = await seedIntent();
    const ok = await seedClaim("ok", "docs/a.md", [
      { uri: "repo://src/x.ts#L1-L2" },
    ]);
    const ticket = await seedClaim("ticket", "docs/b.md", [
      { uri: "repo://src/y.ts#L1-L2" },
      { uri: "ticket://SUP-12#/summary" },
    ]);
    await seedClaim("escape", "../escape.md", [], {
      statement: "ESCAPE-STATEMENT-MARKER",
    });
    await seedClaim("doc", "docs/d.md", [{ uri: "doc://pricing#trial" }], {
      statement: "DOC-STATEMENT-MARKER",
    });
    await seedClaim(
      "traversal",
      "docs/t.md",
      [{ uri: "repo://../etc/passwd#L1-L1" }],
      { statement: "TRAVERSAL-STATEMENT-MARKER" },
    );
    const res = await load(id);
    if (res.status !== "ready") throw new Error("expected ready");
    expect(res.sidecars.map((s) => s.page)).toEqual(["docs/a.md", "docs/b.md"]);
    expect(res.sidecars[0]?.claims.map((c) => c.id)).toEqual([ok]);
    expect(res.sidecars[1]?.claims.map((c) => c.id)).toEqual([ticket]);
    expect(res.ticketClaims).toEqual([
      {
        claimId: ticket,
        ticketPins: [{ key: "SUP-12", pointer: "/summary", field: "summary" }],
      },
    ]);
    expect(res.excludedClaims).toBe(3);
    const body = JSON.stringify(res);
    expect(body).not.toContain("STATEMENT-MARKER");
  });

  it("throws KnowledgeReconcileTooLargeError above the claim cap", async () => {
    const id = await seedIntent();
    const rows = Array.from(
      { length: KNOWLEDGE_RECONCILE_MAX_CLAIMS + 1 },
      (_, i) => ({
        id: `bulk-${run}-${i}`,
        organizationId: org,
        repoFullName: REPO,
        page: "docs/a.md",
        statement: "s",
      }),
    );
    for (let i = 0; i < rows.length; i += 1000) {
      await db.insert(schema.knowledgeClaim).values(rows.slice(i, i + 1000));
    }
    await expect(load(id)).rejects.toBeInstanceOf(
      KnowledgeReconcileTooLargeError,
    );
    const left = await db
      .select({ id: schema.knowledgeClaim.id })
      .from(schema.knowledgeClaim)
      .where(
        and(
          eq(schema.knowledgeClaim.organizationId, org),
          eq(schema.knowledgeClaim.repoFullName, REPO),
        ),
      );
    expect(left.length).toBe(KNOWLEDGE_RECONCILE_MAX_CLAIMS + 1);
  });
});

describe("publishKnowledgeReconcile", () => {
  let db: DB;
  let org: string;
  let run: string;

  beforeEach(async () => {
    run = Math.random().toString(36).slice(2, 10);
    db = createDb(process.env.DATABASE_URL!);
    org = await createTestOrg({ db, name: "Acme" });
    await setEngine(org, true);
  });

  const setEngine = (organizationId: string, knowledgeEngine: boolean) =>
    db
      .insert(schema.organizationReviewSettings)
      .values({ organizationId, knowledgeEngine })
      .onConflictDoUpdate({
        target: [schema.organizationReviewSettings.organizationId],
        set: { knowledgeEngine },
      });

  const intentId = () => `intent:${org}:${REPO}@${SHA2}`;

  const seedIntent = async (
    state: schema.KnowledgeIntentState = "processing",
  ) => {
    await db.insert(schema.knowledgeIntent).values({
      id: intentId(),
      organizationId: org,
      repoFullName: REPO,
      defaultBranch: "main",
      targetSha: SHA2,
      state,
      attempts: 2,
      nextAttemptAt: new Date(NOW.getTime() + 20 * 60_000),
    });
  };

  const seedCursor = (lastSha: string | null) =>
    db.insert(schema.knowledgeCursor).values({
      organizationId: org,
      repoFullName: REPO,
      defaultBranch: "main",
      lastSha,
      observedHeadSha: SHA2,
    });

  const seedClaim = async (
    id: string,
    opts: { organizationId?: string; repo?: string; version?: number } = {},
  ) => {
    const claimId = `${id}-${run}`;
    await db.insert(schema.knowledgeClaim).values({
      id: claimId,
      organizationId: opts.organizationId ?? org,
      repoFullName: opts.repo ?? REPO,
      page: "docs/a.md",
      statement: "Trials last 14 days.",
      version: opts.version ?? 2,
    });
    return claimId;
  };

  const opFor = (claimId: string, overrides: Record<string, unknown> = {}) => {
    const id = `op-${claimId}`;
    return {
      id,
      claimId,
      kind: "update",
      baseVersion: 2,
      proposal: {
        id,
        claimId,
        op: "update",
        auto: false,
        before: "Trials last 14 days.",
        after: "Trials last 30 days.",
        why: "The source changed.",
        evidence: ["repo://src/pricing.ts#L1-L2"],
        evidenceFingerprint: "0123456789abcdef",
      },
      ...overrides,
    };
  };

  const request = (
    ops: ReturnType<typeof opFor>[],
    overrides: Record<string, unknown> = {},
  ) => ({
    intentId: intentId(),
    fromSha: SHA1 as string | null,
    toSha: SHA2,
    mode: "range" as const,
    ops,
    ...overrides,
  });

  const publish = (
    req: ReturnType<typeof request>,
    beforeCursorCas?: () => void,
  ) =>
    publishKnowledgeReconcile({ db, request: req, now: NOW, beforeCursorCas });

  const intentRow = async () =>
    (
      await db
        .select()
        .from(schema.knowledgeIntent)
        .where(eq(schema.knowledgeIntent.id, intentId()))
    )[0]!;
  const cursorRow = async () =>
    (
      await db
        .select()
        .from(schema.knowledgeCursor)
        .where(eq(schema.knowledgeCursor.organizationId, org))
    )[0];
  const opCount = async () =>
    (
      await db
        .select({ id: schema.knowledgeOp.id })
        .from(schema.knowledgeOp)
        .where(eq(schema.knowledgeOp.organizationId, org))
    ).length;

  it("publishes ops, moves the cursor and processes the intent", async () => {
    await seedIntent();
    await seedCursor(SHA1);
    const a = await seedClaim("a");
    const b = await seedClaim("b");
    const res = await publish(request([opFor(a), opFor(b)]));
    expect(res).toEqual({ result: "published", opsInserted: 2 });
    expect((await cursorRow())?.lastSha).toBe(SHA2);
    const row = await intentRow();
    expect(row.state).toBe("processed");
    expect(row.processedAt?.getTime()).toBe(NOW.getTime());
    expect(row.lastErrorCode).toBeNull();
    const [op] = await db
      .select()
      .from(schema.knowledgeOp)
      .where(eq(schema.knowledgeOp.id, `op-${a}`));
    expect(op?.mergeRev).toBe(SHA2);
    expect(op?.repoFullName).toBe(REPO);
  });

  it.each(["no-row", "null-sha"] as const)(
    "first reconcile (%s): fromSha null publishes",
    async (kind) => {
      await seedIntent();
      if (kind === "null-sha") await seedCursor(null);
      const a = await seedClaim("a");
      const res = await publish(request([opFor(a)], { fromSha: null }));
      expect(res).toEqual({ result: "published", opsInserted: 1 });
      expect((await cursorRow())?.lastSha).toBe(SHA2);
    },
  );

  it("replay after success is already_published and writes nothing", async () => {
    await seedIntent();
    await seedCursor(SHA1);
    const a = await seedClaim("a");
    const req = request([opFor(a)]);
    await publish(req);
    const before = await intentRow();
    expect(await publish(req)).toEqual({
      result: "already_published",
      opsInserted: 0,
    });
    expect((await intentRow()).updatedAt.getTime()).toBe(
      before.updatedAt.getTime(),
    );
    expect(await opCount()).toBe(1);
  });

  it("a cursor already at toSha counts as success", async () => {
    await seedIntent();
    await seedCursor(SHA2);
    const a = await seedClaim("a");
    const res = await publish(request([opFor(a)]));
    expect(res).toEqual({ result: "published", opsInserted: 1 });
    expect((await intentRow()).state).toBe("processed");
    expect((await cursorRow())?.lastSha).toBe(SHA2);
  });

  it("a cursor moved elsewhere supersedes the intent and writes nothing", async () => {
    await seedIntent();
    await seedCursor("c".repeat(40));
    const a = await seedClaim("a");
    const res = await publish(request([opFor(a)]));
    expect(res).toEqual({ result: "cursor_moved", opsInserted: 0 });
    expect(await opCount()).toBe(0);
    expect((await cursorRow())?.lastSha).toBe("c".repeat(40));
    expect((await intentRow()).state).toBe("superseded");
  });

  it("an Off org gets gated: nothing written, intent pending, attempts kept", async () => {
    await seedIntent();
    await seedCursor(SHA1);
    const a = await seedClaim("a");
    await setEngine(org, false);
    const res = await publish(request([opFor(a)]));
    expect(res).toEqual({ result: "gated", opsInserted: 0 });
    expect(await opCount()).toBe(0);
    expect((await cursorRow())?.lastSha).toBe(SHA1);
    const row = await intentRow();
    expect(row.state).toBe("pending");
    expect(row.attempts).toBe(2);
  });

  it("not_processing for an unknown or pending intent", async () => {
    expect(await publish(request([]))).toEqual({
      result: "not_processing",
      opsInserted: 0,
    });
    await seedIntent("pending");
    expect(await publish(request([]))).toEqual({
      result: "not_processing",
      opsInserted: 0,
    });
  });

  describe("rejections write nothing", () => {
    beforeEach(async () => {
      await seedIntent();
      await seedCursor(SHA1);
    });

    const expectInvalid = async (req: ReturnType<typeof request>) => {
      await expect(publish(req)).rejects.toBeInstanceOf(
        KnowledgeReconcileInvalidError,
      );
      expect(await opCount()).toBe(0);
      expect((await cursorRow())?.lastSha).toBe(SHA1);
      expect((await intentRow()).state).toBe("processing");
    };

    it("a claim of another repo", async () => {
      const foreign = await seedClaim("f", { repo: "acme/other" });
      await expectInvalid(request([opFor(foreign)]));
    });

    it("a claim of another org", async () => {
      const other = await createTestOrg({ db, name: "Other" });
      const foreign = await seedClaim("f", { organizationId: other });
      await expectInvalid(request([opFor(foreign)]));
    });

    it("a toSha different from the intent target", async () => {
      const a = await seedClaim("a");
      await expectInvalid(request([opFor(a)], { toSha: SHA1 }));
    });

    it("a proposal that fails the stored-proposal check", async () => {
      const a = await seedClaim("a");
      const bad = opFor(a);
      bad.proposal = { ...bad.proposal, rawText: "secret" } as never;
      await expectInvalid(request([bad]));
    });

    it("an op kind that differs from the proposal op", async () => {
      const a = await seedClaim("a");
      await expectInvalid(request([opFor(a, { kind: "repin" })]));
    });
  });

  it("stale sidecar (PD-23): version moved on, nothing written, intent pending", async () => {
    await seedIntent();
    await seedCursor(SHA1);
    const stale = await seedClaim("stale", { version: 3 });
    const fresh = await seedClaim("fresh", { version: 2 });
    const res = await publish(request([opFor(fresh), opFor(stale)]));
    expect(res).toEqual({ result: "stale_claim", opsInserted: 0 });
    expect(await opCount()).toBe(0);
    expect((await cursorRow())?.lastSha).toBe(SHA1);
    const row = await intentRow();
    expect(row.state).toBe("pending");
    expect(row.attempts).toBe(2);
    expect(row.nextAttemptAt.getTime()).toBe(NOW.getTime());
  });

  it("atomicity: a failure between the op insert and the cursor CAS rolls everything back", async () => {
    await seedIntent();
    await seedCursor(SHA1);
    const a = await seedClaim("a");
    await expect(
      publish(request([opFor(a)]), () => {
        throw new Error("injected");
      }),
    ).rejects.toThrow("injected");
    expect(await opCount()).toBe(0);
    expect((await cursorRow())?.lastSha).toBe(SHA1);
    expect((await intentRow()).state).toBe("processing");
  });

  it("SC3: pending validation until publish moves lastSha to the observed head", async () => {
    await recordKnowledgePush({
      db,
      organizationId: org,
      repoFullName: REPO,
      defaultBranch: "main",
      targetSha: SHA1,
      now: NOW,
    });
    await db
      .update(schema.knowledgeCursor)
      .set({ lastSha: SHA1 })
      .where(eq(schema.knowledgeCursor.organizationId, org));
    await db
      .update(schema.knowledgeIntent)
      .set({ state: "processed" })
      .where(eq(schema.knowledgeIntent.organizationId, org));
    await recordKnowledgePush({
      db,
      organizationId: org,
      repoFullName: REPO,
      defaultBranch: "main",
      targetSha: SHA2,
      now: NOW,
    });
    const statusRow = async () =>
      (await listKnowledgeRepoStatus({ db, organizationId: org })).find(
        (r) => r.repoFullName === REPO,
      )!;
    const before = await statusRow();
    expect(before.pending).toBe(true);
    expect(before.lastSha).toBe(SHA1);

    await db
      .update(schema.knowledgeIntent)
      .set({ state: "processing" })
      .where(eq(schema.knowledgeIntent.id, intentId()));
    expect(await publish(request([]))).toEqual({
      result: "published",
      opsInserted: 0,
    });
    const after = await statusRow();
    expect(after.pending).toBe(false);
    expect(after.lastSha).toBe(SHA2);
    expect(after.observedHeadSha).toBe(SHA2);
  });
});
