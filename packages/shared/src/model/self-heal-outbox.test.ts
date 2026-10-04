import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { createDb } from "../db";
import {
  auditEffects,
  auditRuns,
  selfHealBreaker,
  selfHealBreakerEvent,
} from "../db/schema";
import { createAuditRunAtDispatch } from "./audit-findings";
import { createOrganization } from "./organizations";
import {
  recordSelfHealAdminAction,
  listSelfHealAdminActions,
} from "./self-heal-admin-log";
import {
  claimDueEffects,
  claimDueEffectsForRun,
  enqueueEffects,
  listPendingCreateFingerprints,
  markEffectApplied,
  markEffectRetry,
  OUTBOX_BACKOFF_MS,
  pruneSelfHealRows,
} from "./self-heal-outbox";
import { createTestThread, createTestUser } from "./test-helpers";

const db = createDb(env.DATABASE_URL!);
const REPO = "Acme/Widgets";
const DAY = 86_400_000;

async function makeOrg(name: string): Promise<string> {
  const org = await createOrganization({
    db,
    name,
    slug: `${name}-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

describe("self-heal outbox", () => {
  let orgA: string;
  let orgB: string;
  let userId: string;

  async function newRun(organizationId: string): Promise<string> {
    const threadId = (await createTestThread({ db, userId })).threadId;
    await createAuditRunAtDispatch({
      db,
      organizationId,
      repoFullName: REPO,
      threadId,
      audit: "security",
    });
    const [row] = await db
      .select({ id: auditRuns.id })
      .from(auditRuns)
      .where(eq(auditRuns.threadId, threadId));
    return row!.id; // inserted just above
  }

  function mine<T extends { organizationId: string }>(rows: T[], org: string) {
    return rows.filter((r) => r.organizationId === org);
  }

  beforeEach(async () => {
    orgA = await makeOrg("acme");
    orgB = await makeOrg("globex");
    userId = (await createTestUser({ db })).user.id;
  });

  it("enqueue is idempotent per (run, fingerprint, action)", async () => {
    const runId = await newRun(orgA);
    const base = { db, organizationId: orgA, repoFullName: REPO, runId };
    const a = { fingerprint: "f1", action: "create_issue" as const };
    expect(await enqueueEffects({ ...base, effects: [a] })).toBe(1);
    expect(await enqueueEffects({ ...base, effects: [a] })).toBe(0);
    expect(
      await enqueueEffects({
        ...base,
        effects: [{ fingerprint: "f1", action: "set_labels" }],
      }),
    ).toBe(1);
    const rows = await db
      .select()
      .from(auditEffects)
      .where(eq(auditEffects.runId, runId));
    expect(rows).toHaveLength(2);
  });

  it("two concurrent drainers claim disjoint sets; leases and future attempts are skipped", async () => {
    const runId = await newRun(orgA);
    const now = new Date();
    await enqueueEffects({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      runId,
      now,
      effects: ["a", "b", "c"].map((fp) => ({
        fingerprint: fp,
        action: "create_issue" as const,
      })),
    });
    const future = await newRun(orgA);
    await enqueueEffects({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      runId: future,
      now: new Date(now.getTime() + 3_600_000),
      effects: [{ fingerprint: "z", action: "create_issue" }],
    });
    const [x, y] = await Promise.all([
      claimDueEffects({ db, now, limit: 1000 }),
      claimDueEffects({ db, now, limit: 1000 }),
    ]);
    const xi = mine(x, orgA).map((r) => r.id);
    const yi = mine(y, orgA).map((r) => r.id);
    expect(new Set([...xi, ...yi]).size).toBe(3);
    expect(xi.filter((i) => yi.includes(i))).toEqual([]);
    // lease still live: nothing returned
    expect(mine(await claimDueEffects({ db, now, limit: 1000 }), orgA)).toEqual(
      [],
    );
    // lease passed: back again
    const later = new Date(now.getTime() + 61_000);
    expect(
      mine(await claimDueEffects({ db, now: later, limit: 1000 }), orgA),
    ).toHaveLength(3);
  });

  it("a future rate_limited_until on github_write makes only that org's rows not due", async () => {
    const now = new Date();
    for (const org of [orgA, orgB]) {
      await enqueueEffects({
        db,
        organizationId: org,
        repoFullName: REPO,
        runId: await newRun(org),
        now,
        effects: [{ fingerprint: "f", action: "create_issue" }],
      });
    }
    await db.insert(selfHealBreaker).values({
      organizationId: orgA,
      scopeKind: "github_write",
      scopeKey: "inst-1",
      rateLimitedUntil: new Date(now.getTime() + 120_000),
    });
    const got = await claimDueEffects({ db, now, limit: 1000 });
    expect(mine(got, orgA)).toHaveLength(0);
    expect(mine(got, orgB)).toHaveLength(1);
    // horizon passed -> due again
    const after = new Date(now.getTime() + 121_000);
    expect(
      mine(await claimDueEffects({ db, now: after, limit: 1000 }), orgA),
    ).toHaveLength(1);
  });

  it("claimDueEffectsForRun is fenced by org and run", async () => {
    const runId = await newRun(orgA);
    await enqueueEffects({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      runId,
      effects: [{ fingerprint: "f", action: "create_issue" }],
    });
    expect(
      await claimDueEffectsForRun({ db, organizationId: orgB, runId }),
    ).toHaveLength(0);
    expect(
      await claimDueEffectsForRun({ db, organizationId: orgA, runId }),
    ).toHaveLength(1);
  });

  it("markEffectRetry walks the backoff table with jitter; the 5th failure is terminal", async () => {
    const runId = await newRun(orgA);
    await enqueueEffects({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      runId,
      effects: [{ fingerprint: "f", action: "create_issue" }],
    });
    const [row] = await db
      .select()
      .from(auditEffects)
      .where(eq(auditEffects.runId, runId));
    const id = row!.id; // enqueued just above
    const now = new Date();
    for (let i = 0; i < OUTBOX_BACKOFF_MS.length; i++) {
      const status = await markEffectRetry({
        db,
        organizationId: orgA,
        id,
        error: "boom",
        now,
        rand: () => 0.5,
      });
      expect(status).toBe("pending");
      const [r] = await db
        .select()
        .from(auditEffects)
        .where(eq(auditEffects.id, id));
      const base = OUTBOX_BACKOFF_MS[i]!; // loop bound
      expect(r!.attempts).toBe(i + 1);
      expect(r!.nextAttemptAt!.getTime() - now.getTime()).toBe(
        Math.round(base * 1.15),
      );
    }
    expect(
      await markEffectRetry({ db, organizationId: orgA, id, error: "boom" }),
    ).toBe("failed");
    const [last] = await db
      .select()
      .from(auditEffects)
      .where(eq(auditEffects.id, id));
    expect(last!.status).toBe("failed");
    expect(last!.attempts).toBe(5);
  });

  it("listPendingCreateFingerprints returns only pending create_issue rows for that org/repo", async () => {
    const runId = await newRun(orgA);
    await enqueueEffects({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      runId,
      effects: [
        { fingerprint: "c1", action: "create_issue" },
        { fingerprint: "c2", action: "create_issue" },
        { fingerprint: "u1", action: "update_issue" },
      ],
    });
    const [c2] = await db
      .select()
      .from(auditEffects)
      .where(eq(auditEffects.fingerprint, "c2"));
    await markEffectApplied({ db, organizationId: orgA, id: c2!.id });
    // leased still counts as pending
    await claimDueEffectsForRun({ db, organizationId: orgA, runId });
    expect(
      await listPendingCreateFingerprints({
        db,
        organizationId: orgA,
        repoFullName: REPO,
      }),
    ).toEqual(new Set(["c1"]));
    expect(
      (
        await listPendingCreateFingerprints({
          db,
          organizationId: orgB,
          repoFullName: REPO,
        })
      ).size,
    ).toBe(0);
  });

  it("prunes only rows past retention, in batches, never pending", async () => {
    const runId = await newRun(orgA);
    const now = new Date();
    const old = new Date(now.getTime() - 31 * DAY);
    await enqueueEffects({
      db,
      organizationId: orgA,
      repoFullName: REPO,
      runId,
      effects: ["p", "a", "f", "fresh"].map((fp) => ({
        fingerprint: fp,
        action: "create_issue" as const,
      })),
    });
    const set = async (
      fp: string,
      patch: Partial<typeof auditEffects.$inferInsert>,
    ) =>
      db
        .update(auditEffects)
        .set(patch)
        .where(eq(auditEffects.fingerprint, fp));
    await set("p", { updatedAt: old }); // pending + old: kept
    await set("a", { status: "applied", updatedAt: old });
    await set("f", { status: "failed", updatedAt: old });
    await set("fresh", { status: "applied" });
    await db.insert(selfHealBreakerEvent).values([
      {
        organizationId: orgA,
        scopeKind: "github_write",
        scopeKey: "i",
        outcome: "success",
        createdAt: old,
      },
      {
        organizationId: orgA,
        scopeKind: "github_write",
        scopeKey: "i",
        outcome: "success",
      },
    ]);
    const oldRun = await newRun(orgA);
    await db
      .update(auditRuns)
      .set({ status: "done", finishedAt: new Date(now.getTime() - 91 * DAY) })
      .where(eq(auditRuns.id, oldRun));
    const youngRun = await newRun(orgA);
    await db
      .update(auditRuns)
      .set({ status: "done", finishedAt: new Date(now.getTime() - 40 * DAY) })
      .where(eq(auditRuns.id, youngRun));

    // batch=1 deletes at most one per table per call
    const first = await pruneSelfHealRows({ db, now, batch: 1 });
    expect(first.effects).toBe(1);
    expect(first.events).toBeLessThanOrEqual(1);
    await pruneSelfHealRows({ db, now, batch: 1000 });
    const left = await db
      .select({ fp: auditEffects.fingerprint })
      .from(auditEffects)
      .where(eq(auditEffects.runId, runId));
    expect(left.map((r) => r.fp).sort()).toEqual(["fresh", "p"]);
    const runs = await db
      .select({ id: auditRuns.id })
      .from(auditRuns)
      .where(eq(auditRuns.organizationId, orgA));
    expect(runs.map((r) => r.id)).not.toContain(oldRun);
    expect(runs.map((r) => r.id)).toContain(youngRun);
  });
});

describe("self-heal admin log", () => {
  it("is org-fenced and newest first", async () => {
    const orgA = await makeOrg("acme");
    const orgB = await makeOrg("globex");
    await recordSelfHealAdminAction({
      db,
      organizationId: orgA,
      actorUserId: "u1",
      action: "drain",
    });
    await recordSelfHealAdminAction({
      db,
      organizationId: orgA,
      actorUserId: "u2",
      action: "kill_switch",
      target: { on: true },
    });
    await recordSelfHealAdminAction({
      db,
      organizationId: orgB,
      actorUserId: "u3",
      action: "drain",
    });
    const a = await listSelfHealAdminActions({
      db,
      organizationId: orgA,
      limit: 10,
    });
    expect(a.map((r) => r.actorUserId)).toEqual(["u2", "u1"]);
    expect(
      await listSelfHealAdminActions({ db, organizationId: orgB }),
    ).toHaveLength(1);
  });
});
