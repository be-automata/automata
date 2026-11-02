import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { createDb, type DB } from "../db";
import * as schema from "../db/schema";
import {
  KNOWLEDGE_RECONCILE_MAX_CLAIMS,
  KnowledgeReconcileTooLargeError,
  loadKnowledgeReconcileContext,
} from "./knowledge-reconcile";
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

  it("admits only repo-pinned claims with a repo-relative page (PD-21)", async () => {
    const id = await seedIntent();
    const ok = await seedClaim("ok", "docs/a.md", [
      { uri: "repo://src/x.ts#L1-L2" },
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
    expect(res.sidecars).toHaveLength(1);
    expect(res.sidecars[0]?.claims.map((c) => c.id)).toEqual([ok]);
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
