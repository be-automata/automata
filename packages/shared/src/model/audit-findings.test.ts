import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { createDb } from "../db";
import { auditFixAttempts, auditRuns } from "../db/schema";
import {
  claimAuditRun,
  countOpenFindingIssues,
  createAuditRunAtDispatch,
  finishAuditRun,
  getAuditRunByThread,
  getFindingByIssue,
  insertFinding,
  listAuditRunsForRepo,
  listEffectsForRepo,
  listFindingsForRepo,
  listFixAttemptsForRepo,
  listReclaimableAuditRuns,
  recordAuditCheckResults,
  releaseAuditRunClaim,
  summarizeOutbox,
  type AuditFindingInsert,
} from "./audit-findings";
import { enqueueEffects, markEffectFailed } from "./self-heal-outbox";
import { createOrganization } from "./organizations";
import { createTestThread, createTestUser } from "./test-helpers";

const db = createDb(env.DATABASE_URL!);
const REPO = "Acme/Widgets";

async function makeOrg(name: string): Promise<string> {
  const org = await createOrganization({
    db,
    name,
    slug: `${name.toLowerCase()}-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

function finding(
  fingerprint: string,
  extra: Partial<AuditFindingInsert> = {},
): Omit<AuditFindingInsert, "organizationId" | "id"> & {
  repoFullName: string;
} {
  return {
    repoFullName: REPO,
    fingerprint,
    audit: "security",
    ruleId: "R1",
    severity: "high",
    checkKind: "script",
    title: `finding ${fingerprint}`,
    ...extra,
  };
}

describe("audit runs (leased claim)", () => {
  let orgA: string;
  let orgB: string;
  let userId: string;

  async function newThread(): Promise<string> {
    return (await createTestThread({ db, userId })).threadId;
  }

  beforeEach(async () => {
    orgA = await makeOrg("acme");
    orgB = await makeOrg("globex");
    userId = (await createTestUser({ db })).user.id;
  });

  it("creates one 'dispatched' row per thread", async () => {
    const threadId = await newThread();
    for (let i = 0; i < 2; i++) {
      await createAuditRunAtDispatch({
        db,
        organizationId: orgA,
        repoFullName: REPO,
        threadId,
        audit: "security",
        checkTokenHash: "h",
      });
    }
    const rows = await db
      .select()
      .from(auditRuns)
      .where(eq(auditRuns.threadId, threadId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("dispatched");
    expect(rows[0]?.repoFullName).toBe("acme/widgets");
  });

  it("claims once with a 10 minute lease; concurrent claims have one winner", async () => {
    const threadId = await newThread();
    await createAuditRunAtDispatch({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      threadId,
      audit: "security",
    });
    const before = Date.now();
    const results = await Promise.all([
      claimAuditRun({
        db,
        organizationId: orgA,
        repoFullName: REPO,
        threadId,
        audit: "security",
      }),
      claimAuditRun({
        db,
        organizationId: orgA,
        repoFullName: REPO,
        threadId,
        audit: "security",
      }),
    ]);
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    const won = winners[0];
    expect(won?.status).toBe("claimed");
    expect(won?.claimCount).toBe(1);
    const expires = won?.claimExpiresAt?.getTime() ?? 0;
    expect(expires - before).toBeGreaterThan(9.9 * 60_000);
    expect(expires - before).toBeLessThan(10.1 * 60_000);
    expect(
      await claimAuditRun({
        db,
        organizationId: orgA,
        repoFullName: REPO,
        threadId,
        audit: "security",
      }),
    ).toBeNull();
  });

  it("claims a thread with no dispatch row (insert path)", async () => {
    const threadId = await newThread();
    const row = await claimAuditRun({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      threadId,
      audit: "security",
    });
    expect(row?.status).toBe("claimed");
    expect(row?.claimCount).toBe(1);
  });

  it("RES-08: an expired claim is listed and reclaimed by exactly one racer", async () => {
    const threadId = await newThread();
    const first = await claimAuditRun({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      threadId,
      audit: "security",
    });
    expect(first).not.toBeNull();
    await db
      .update(auditRuns)
      .set({ claimExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(auditRuns.threadId, threadId));
    const reclaimable = await listReclaimableAuditRuns({ db });
    expect(reclaimable.map((r) => r.id)).toContain(first?.id);

    const racers = await Promise.all([
      claimAuditRun({
        db,
        organizationId: orgA,
        repoFullName: REPO,
        threadId,
        audit: "security",
      }),
      claimAuditRun({
        db,
        organizationId: orgA,
        repoFullName: REPO,
        threadId,
        audit: "security",
      }),
    ]);
    const winners = racers.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.claimCount).toBe(2);
  });

  it("releases a claim so it is claimable again", async () => {
    const threadId = await newThread();
    const claimed = await claimAuditRun({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      threadId,
      audit: "security",
    });
    await releaseAuditRunClaim({
      db,
      organizationId: orgA,
      id: claimed?.id ?? "",
    });
    const run = await getAuditRunByThread({
      db,
      organizationId: orgA,
      threadId,
    });
    expect(run?.status).toBe("dispatched");
    expect(
      await claimAuditRun({
        db,
        organizationId: orgA,
        repoFullName: REPO,
        threadId,
        audit: "security",
      }),
    ).not.toBeNull();
  });

  it("finishing clears the lease and a finished run is never reclaimable", async () => {
    const threadId = await newThread();
    const claimed = await claimAuditRun({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      threadId,
      audit: "security",
    });
    const finished = await finishAuditRun({
      db,
      organizationId: orgA,
      id: claimed?.id ?? "",
      status: "done",
      outcome: "ok",
      complete: true,
      counts: { parsed: 3, created: 1 },
    });
    expect(finished?.claimExpiresAt).toBeNull();
    expect(finished?.parsedCount).toBe(3);
    const reclaimable = await listReclaimableAuditRuns({
      db,
      now: new Date(Date.now() + 3_600_000),
    });
    expect(reclaimable.map((r) => r.id)).not.toContain(claimed?.id);
    expect(
      await claimAuditRun({
        db,
        organizationId: orgA,
        repoFullName: REPO,
        threadId,
        audit: "security",
      }),
    ).toBeNull();
    // another org cannot finish it
    expect(
      await finishAuditRun({
        db,
        organizationId: orgB,
        id: claimed?.id ?? "",
        status: "failed",
      }),
    ).toBeNull();
  });

  it("records check results once, fenced by org", async () => {
    const threadId = await newThread();
    await createAuditRunAtDispatch({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      threadId,
      audit: "security",
    });
    const results = [
      { fingerprint: "aaaaaaaaaaaaaaaa", outcome: "pass" as const },
    ];
    expect(
      await recordAuditCheckResults({
        db,
        organizationId: orgB,
        threadId,
        results,
      }),
    ).toBe(false);
    expect(
      await recordAuditCheckResults({
        db,
        organizationId: orgA,
        threadId,
        results,
      }),
    ).toBe(true);
    expect(
      await recordAuditCheckResults({
        db,
        organizationId: orgA,
        threadId,
        results,
      }),
    ).toBe(false);
  });
});

describe("audit findings (org-fenced)", () => {
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    orgA = await makeOrg("acme");
    orgB = await makeOrg("globex");
  });

  it("dedupes on (org, repo, fingerprint) and keeps orgs apart", async () => {
    const a1 = await insertFinding({
      db,
      organizationId: orgA,
      finding: finding("f000000000000001"),
    });
    const a2 = await insertFinding({
      db,
      organizationId: orgA,
      finding: finding("f000000000000001"),
    });
    const b1 = await insertFinding({
      db,
      organizationId: orgB,
      finding: finding("f000000000000001"),
    });
    expect(a2.id).toBe(a1.id);
    expect(b1.id).not.toBe(a1.id);
  });

  it("blocks two findings on one issue number but allows many null ones", async () => {
    await insertFinding({
      db,
      organizationId: orgA,
      finding: finding("f000000000000002", { issueNumber: 7 }),
    });
    await expect(
      insertFinding({
        db,
        organizationId: orgA,
        finding: finding("f000000000000003", { issueNumber: 7 }),
      }),
    ).rejects.toThrow();
    await insertFinding({
      db,
      organizationId: orgA,
      finding: finding("f000000000000004"),
    });
    await insertFinding({
      db,
      organizationId: orgA,
      finding: finding("f000000000000005"),
    });
  });

  it("never returns another org's rows", async () => {
    await insertFinding({
      db,
      organizationId: orgA,
      finding: finding("f000000000000006", { issueNumber: 11, status: "open" }),
    });
    expect(
      await listFindingsForRepo({
        db,
        organizationId: orgB,
        repoFullName: REPO,
      }),
    ).toEqual([]);
    expect(
      await getFindingByIssue({
        db,
        organizationId: orgB,
        repoFullName: REPO,
        issueNumber: 11,
      }),
    ).toBeNull();
    expect(
      await countOpenFindingIssues({
        db,
        organizationId: orgB,
        repoFullName: REPO,
      }),
    ).toBe(0);
    expect(
      await countOpenFindingIssues({
        db,
        organizationId: orgA,
        repoFullName: REPO,
      }),
    ).toBe(1);
    expect(
      (
        await getFindingByIssue({
          db,
          organizationId: orgA,
          repoFullName: "ACME/widgets",
          issueNumber: 11,
        })
      )?.fingerprint,
    ).toBe("f000000000000006");
  });
});

describe("self-heal activity reads (org-fenced, no token hashes)", () => {
  let orgA: string;
  let orgB: string;
  let userId: string;

  beforeEach(async () => {
    orgA = await makeOrg("acme");
    orgB = await makeOrg("globex");
    userId = (await createTestUser({ db })).user.id;
  });

  async function seedRun(
    organizationId: string,
    createdAt: Date,
  ): Promise<string> {
    const { threadId } = await createTestThread({ db, userId });
    await createAuditRunAtDispatch({
      db,
      organizationId,
      repoFullName: REPO,
      threadId,
      audit: "security",
      checkTokenHash: "secret-hash",
    });
    const [row] = await db
      .update(auditRuns)
      .set({ createdAt })
      .where(eq(auditRuns.threadId, threadId))
      .returning({ id: auditRuns.id });
    return row!.id;
  }

  it("lists runs newest first, limited, fenced, without check_token_hash", async () => {
    const old = await seedRun(orgA, new Date("2026-01-01T00:00:00Z"));
    const mid = await seedRun(orgA, new Date("2026-02-01T00:00:00Z"));
    const recent = await seedRun(orgA, new Date("2026-03-01T00:00:00Z"));
    await seedRun(orgB, new Date("2026-04-01T00:00:00Z"));

    const all = await listAuditRunsForRepo({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      limit: 20,
    });
    expect(all.map((r) => r.id)).toEqual([recent, mid, old]);
    expect(all.every((r) => !("checkTokenHash" in r))).toBe(true);
    expect(JSON.stringify(all)).not.toContain("secret-hash");

    const limited = await listAuditRunsForRepo({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      limit: 2,
    });
    expect(limited.map((r) => r.id)).toEqual([recent, mid]);
  });

  it("lists fix attempts without gate_token_hash and fenced by org", async () => {
    const f = await insertFinding({
      db,
      organizationId: orgA,
      finding: finding("a000000000000001"),
    });
    await db.insert(auditFixAttempts).values({
      organizationId: orgA,
      repoFullName: "acme/widgets",
      findingId: f.id,
      attemptNo: 1,
      gateTokenHash: "gate-secret",
    });
    const rows = await listFixAttemptsForRepo({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      limit: 50,
    });
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => !("gateTokenHash" in r))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("gate-secret");
    expect(
      await listFixAttemptsForRepo({
        db,
        organizationId: orgB,
        repoFullName: REPO,
        limit: 50,
      }),
    ).toEqual([]);
  });

  it("summarizes the outbox per status with the oldest pending age", async () => {
    const runId = await seedRun(orgA, new Date());
    const otherRun = await seedRun(orgB, new Date());
    const t0 = new Date("2026-03-01T00:00:00Z");
    await enqueueEffects({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      runId,
      now: t0,
      effects: [
        { fingerprint: "f000000000000001", action: "create_issue" },
        { fingerprint: "f000000000000002", action: "create_issue" },
        { fingerprint: "f000000000000003", action: "create_issue" },
      ],
    });
    await enqueueEffects({
      db,
      organizationId: orgB,
      repoFullName: REPO,
      runId: otherRun,
      effects: [{ fingerprint: "f000000000000009", action: "create_issue" }],
    });
    const [victim] = await listEffectsForRepo({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      limit: 1,
    });
    await markEffectFailed({
      db,
      organizationId: orgA,
      id: victim!.id,
      error: "boom",
    });
    const summary = await summarizeOutbox({
      db,
      organizationId: orgA,
      repoFullName: REPO,
    });
    expect(summary.pending).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.oldestPendingAt?.getTime()).toBe(t0.getTime());
    expect(
      (
        await listEffectsForRepo({
          db,
          organizationId: orgB,
          repoFullName: REPO,
          limit: 10,
        })
      ).length,
    ).toBe(1);
  });
});
