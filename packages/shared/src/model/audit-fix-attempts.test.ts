import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import { createDb } from "../db";
import { auditFindings } from "../db/schema";
import { insertFinding, type AuditFindingInsert } from "./audit-findings";
import {
  bindFixAttemptThread,
  claimFixAttempt,
  closeFixAttempt,
  getFixAttemptById,
  getFixAttemptByThread,
  getFixAttemptForGateReport,
  listExpiredFixClaims,
  listFixReadyFindings,
  refundFixAttempt,
  updateFixAttempt,
} from "./audit-fix-attempts";
import { createOrganization } from "./organizations";
import { withSelfHealTx } from "./self-heal-tx";
import { createTestThread, createTestUser } from "./test-helpers";

vi.mock("./self-heal-tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./self-heal-tx")>();
  return { ...actual, withSelfHealTx: vi.fn(actual.withSelfHealTx) };
});

const db = createDb(env.DATABASE_URL!);
const REPO = "Acme/Widgets";
const MIN = 60_000;
const T0 = new Date("2026-10-04T10:00:00.000Z");

async function makeOrg(name: string): Promise<string> {
  const org = await createOrganization({
    db,
    name,
    slug: `${name.toLowerCase()}-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

async function makeFinding(
  organizationId: string,
  extra: Partial<AuditFindingInsert> = {},
): Promise<string> {
  const row = await insertFinding({
    db,
    organizationId,
    finding: {
      repoFullName: REPO,
      fingerprint: nanoid(16),
      audit: "security",
      ruleId: "R1",
      severity: "high",
      checkKind: "script",
      title: "finding",
      status: "open",
      issueNumber: Math.floor(Math.random() * 1_000_000) + 1,
      fixReadyAt: new Date(T0.getTime() - 60 * MIN),
      autoFixLabeled: true,
      ...extra,
    },
  });
  return row.id;
}

async function readFinding(id: string) {
  const [row] = await db
    .select()
    .from(auditFindings)
    .where(eq(auditFindings.id, id));
  if (!row) throw new Error("finding vanished");
  return row;
}

const branchFor = (n: number) => `automata/fix-1-abc-${n}`;

describe("audit fix attempts", () => {
  let orgA: string;
  let orgB: string;
  let userId: string;

  function claim(
    findingId: string,
    over: Partial<Parameters<typeof claimFixAttempt>[0]> = {},
  ) {
    return claimFixAttempt({
      db,
      organizationId: orgA,
      findingId,
      maxAttempts: 3,
      cooldownMin: 30,
      branchFor,
      now: T0,
      ...over,
    });
  }

  async function newThread(): Promise<string> {
    return (await createTestThread({ db, userId })).threadId;
  }

  beforeEach(async () => {
    orgA = await makeOrg("acme");
    orgB = await makeOrg("globex");
    userId = (await createTestUser({ db })).user.id;
    vi.mocked(withSelfHealTx).mockClear();
  });

  describe("claimFixAttempt", () => {
    it("two concurrent claims produce exactly one winner", async () => {
      const id = await makeFinding(orgA);
      const results = await Promise.all([claim(id), claim(id)]);
      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      const won = winners[0]!;
      expect(won.attempt.attemptNo).toBe(1);
      expect(won.attempt.branch).toBe("automata/fix-1-abc-1");
      expect(won.attempt.phase).toBe("claimed");
      expect(won.attempt.gateKind).toBe("ci-draft");
      expect(won.attempt.threadId).toBeNull();
      expect(won.attempt.claimExpiresAt?.getTime()).toBe(
        T0.getTime() + 10 * MIN,
      );
      const f = await readFinding(id);
      expect(f.attempts).toBe(1);
      expect(f.activeAttemptId).toBe(won.attempt.id);
      expect(f.lastAttemptAt?.getTime()).toBe(T0.getTime());
    });

    it("runs inside the timeout-bounded self-heal transaction (RES-07)", async () => {
      const id = await makeFinding(orgA);
      await claim(id);
      expect(vi.mocked(withSelfHealTx)).toHaveBeenCalledTimes(1);
      const timeout = await withSelfHealTx(db, async (tx) => {
        const res = (await tx.execute(
          sql`show statement_timeout`,
        )) as unknown as {
          rows: Array<{ statement_timeout: string }>;
        };
        return res.rows[0]?.statement_timeout;
      });
      expect(timeout).toBe("3s");
    });

    it("uses the caller's transaction when one is passed", async () => {
      const id = await makeFinding(orgA);
      const got = await withSelfHealTx(db, (tx) => claim(id, { tx }));
      expect(got).not.toBeNull();
      expect(vi.mocked(withSelfHealTx)).toHaveBeenCalledTimes(1);
    });

    it("refuses while an attempt is active", async () => {
      const id = await makeFinding(orgA);
      expect(await claim(id)).not.toBeNull();
      expect(
        await claim(id, { now: new Date(T0.getTime() + 24 * 60 * MIN) }),
      ).toBeNull();
    });

    it("refuses inside the cooldown", async () => {
      const id = await makeFinding(orgA, {
        lastAttemptAt: new Date(T0.getTime() - 10 * MIN),
      });
      expect(await claim(id)).toBeNull();
      expect(
        await claim(id, { now: new Date(T0.getTime() + 21 * MIN) }),
      ).not.toBeNull();
    });

    it("refuses at the attempts cap", async () => {
      const id = await makeFinding(orgA, { attempts: 3 });
      expect(await claim(id)).toBeNull();
    });

    it.each([
      ["rubric", { checkKind: "rubric" as const }],
      ["needs_human", { status: "needs_human" as const }],
      ["not fix-ready", { fixReadyAt: null }],
    ])("refuses a %s finding", async (_label, extra) => {
      const id = await makeFinding(orgA, extra);
      expect(await claim(id)).toBeNull();
    });

    it("refuses another org's finding", async () => {
      const id = await makeFinding(orgB);
      expect(await claim(id)).toBeNull();
      expect((await readFinding(id)).attempts).toBe(0);
    });
  });

  describe("LEASE-01: expired claim without a thread", () => {
    it("is listed, refunded once, and claimable again after the cooldown", async () => {
      const id = await makeFinding(orgA);
      const won = await claim(id);
      const attemptId = won!.attempt.id;

      const before = await listExpiredFixClaims({
        db,
        now: new Date(T0.getTime() + 9 * MIN),
        limit: 1000,
      });
      expect(before.map((a) => a.id)).not.toContain(attemptId);
      const expired = await listExpiredFixClaims({
        db,
        now: new Date(T0.getTime() + 11 * MIN),
        limit: 1000,
      });
      expect(expired.map((a) => a.id)).toContain(attemptId);

      const later = new Date(T0.getTime() + 11 * MIN);
      expect(
        await refundFixAttempt({
          db,
          organizationId: orgA,
          attemptId,
          cause: "lease_expired",
          now: later,
        }),
      ).toBe(true);
      const f = await readFinding(id);
      expect(f.attempts).toBe(0);
      expect(f.activeAttemptId).toBeNull();
      expect(f.lastAttemptAt?.getTime()).toBe(T0.getTime());
      const a = await getFixAttemptById({
        db,
        organizationId: orgA,
        id: attemptId,
      });
      expect(a?.infraRefunded).toBe(true);
      expect(a?.phase).toBe("closed");
      expect(a?.terminalCause).toBe("lease_expired");

      expect(
        await refundFixAttempt({
          db,
          organizationId: orgA,
          attemptId,
          cause: "lease_expired",
          now: later,
        }),
      ).toBe(false);
      expect((await readFinding(id)).attempts).toBe(0);

      const after = await listExpiredFixClaims({
        db,
        now: new Date(T0.getTime() + 60 * MIN),
        limit: 1000,
      });
      expect(after.map((r) => r.id)).not.toContain(attemptId);

      // Still inside the 30 min cooldown measured from the original claim.
      expect(
        await claim(id, { now: new Date(T0.getTime() + 20 * MIN) }),
      ).toBeNull();
      const again = await claim(id, {
        now: new Date(T0.getTime() + 31 * MIN),
      });
      expect(again?.attempt.attemptNo).toBe(2);
      expect(again?.attempt.branch).toBe("automata/fix-1-abc-2");
      expect((await readFinding(id)).attempts).toBe(1);
    });

    it("refund from another org is a no-op", async () => {
      const id = await makeFinding(orgA);
      const won = await claim(id);
      expect(
        await refundFixAttempt({
          db,
          organizationId: orgB,
          attemptId: won!.attempt.id,
          cause: "x",
        }),
      ).toBe(false);
      expect((await readFinding(id)).attempts).toBe(1);
    });
  });

  describe("bindFixAttemptThread (RACE-01)", () => {
    it("binds once, is a no-op for the same thread and refuses another", async () => {
      const id = await makeFinding(orgA);
      const won = await claim(id);
      const attemptId = won!.attempt.id;
      const t1 = await newThread();
      const t2 = await newThread();
      const bind = (threadId: string) =>
        bindFixAttemptThread({
          db,
          organizationId: orgA,
          attemptId,
          threadId,
          now: T0,
        });

      expect(await bind(t1)).toBe(true);
      const a = await getFixAttemptByThread({
        db,
        organizationId: orgA,
        threadId: t1,
      });
      expect(a?.id).toBe(attemptId);
      expect(a?.phase).toBe("dispatched");
      expect(a?.dispatchLeaseUntil?.getTime()).toBe(T0.getTime() + 10 * MIN);
      expect((await readFinding(id)).activeThreadId).toBe(t1);

      expect(await bind(t1)).toBe(true);
      expect(await bind(t2)).toBe(false);
      expect(
        (await getFixAttemptById({ db, organizationId: orgA, id: attemptId }))
          ?.threadId,
      ).toBe(t1);

      // A bound attempt is not an expired claim.
      const expired = await listExpiredFixClaims({
        db,
        now: new Date(T0.getTime() + 60 * MIN),
        limit: 1000,
      });
      expect(expired.map((r) => r.id)).not.toContain(attemptId);
    });

    it("concurrent binds from both sides: one thread wins", async () => {
      const id = await makeFinding(orgA);
      const won = await claim(id);
      const t1 = await newThread();
      const results = await Promise.all(
        [t1, t1].map((threadId) =>
          bindFixAttemptThread({
            db,
            organizationId: orgA,
            attemptId: won!.attempt.id,
            threadId,
          }),
        ),
      );
      expect(results).toEqual([true, true]);
    });

    it("refuses a refunded attempt and another org", async () => {
      const id = await makeFinding(orgA);
      const won = await claim(id);
      const t1 = await newThread();
      expect(
        await bindFixAttemptThread({
          db,
          organizationId: orgB,
          attemptId: won!.attempt.id,
          threadId: t1,
        }),
      ).toBe(false);
      await refundFixAttempt({
        db,
        organizationId: orgA,
        attemptId: won!.attempt.id,
        cause: "lease_expired",
      });
      expect(
        await bindFixAttemptThread({
          db,
          organizationId: orgA,
          attemptId: won!.attempt.id,
          threadId: t1,
        }),
      ).toBe(false);
    });
  });

  describe("closeFixAttempt", () => {
    it("counted keeps the attempt and releases the finding", async () => {
      const id = await makeFinding(orgA);
      const won = await claim(id);
      const t1 = await newThread();
      await bindFixAttemptThread({
        db,
        organizationId: orgA,
        attemptId: won!.attempt.id,
        threadId: t1,
      });
      expect(
        await closeFixAttempt({
          db,
          organizationId: orgA,
          attemptId: won!.attempt.id,
          outcome: "gate_failed",
          counted: true,
          terminalCause: "ci_failed",
        }),
      ).toBe(true);
      const f = await readFinding(id);
      expect(f.attempts).toBe(1);
      expect(f.activeAttemptId).toBeNull();
      expect(f.activeThreadId).toBeNull();
      const a = await getFixAttemptById({
        db,
        organizationId: orgA,
        id: won!.attempt.id,
      });
      expect(a?.phase).toBe("closed");
      expect(a?.outcome).toBe("gate_failed");
      expect(a?.terminalCause).toBe("ci_failed");
      expect(a?.infraRefunded).toBe(false);
      // Closed is terminal: neither a second close nor a refund applies.
      expect(
        await closeFixAttempt({
          db,
          organizationId: orgA,
          attemptId: won!.attempt.id,
          outcome: "gate_failed",
          counted: true,
        }),
      ).toBe(false);
      expect(
        await refundFixAttempt({
          db,
          organizationId: orgA,
          attemptId: won!.attempt.id,
          cause: "late",
        }),
      ).toBe(false);
      expect((await readFinding(id)).attempts).toBe(1);
    });

    it("uncounted behaves like a refund", async () => {
      const id = await makeFinding(orgA);
      const won = await claim(id);
      expect(
        await closeFixAttempt({
          db,
          organizationId: orgA,
          attemptId: won!.attempt.id,
          outcome: "infra",
          counted: false,
        }),
      ).toBe(true);
      const f = await readFinding(id);
      expect(f.attempts).toBe(0);
      expect(f.activeAttemptId).toBeNull();
      expect(
        (
          await getFixAttemptById({
            db,
            organizationId: orgA,
            id: won!.attempt.id,
          })
        )?.infraRefunded,
      ).toBe(true);
    });

    it("refund never takes attempts below zero", async () => {
      const id = await makeFinding(orgA);
      const won = await claim(id);
      await db
        .update(auditFindings)
        .set({ attempts: 0 })
        .where(eq(auditFindings.id, id));
      await refundFixAttempt({
        db,
        organizationId: orgA,
        attemptId: won!.attempt.id,
        cause: "x",
      });
      expect((await readFinding(id)).attempts).toBe(0);
    });
  });

  describe("listFixReadyFindings", () => {
    it("returns ready, labelled, open script findings without an active attempt, high first, across orgs", async () => {
      const old = (minutes: number) =>
        new Date(Date.UTC(1990, 0, 1) + minutes * MIN);
      const highLate = await makeFinding(orgA, { fixReadyAt: old(5) });
      const highEarly = await makeFinding(orgB, { fixReadyAt: old(1) });
      const medium = await makeFinding(orgA, {
        severity: "medium",
        fixReadyAt: old(0),
      });
      const low = await makeFinding(orgB, {
        severity: "low",
        fixReadyAt: old(0),
      });
      const excluded = await Promise.all([
        makeFinding(orgA, { autoFixLabeled: false, fixReadyAt: old(0) }),
        makeFinding(orgA, { fixReadyAt: null }),
        makeFinding(orgA, { status: "needs_human", fixReadyAt: old(0) }),
        makeFinding(orgA, { checkKind: "rubric", fixReadyAt: old(0) }),
        makeFinding(orgA, { activeAttemptId: "busy", fixReadyAt: old(0) }),
      ]);

      const rows = await listFixReadyFindings({ db, limit: 10_000 });
      const mine = rows
        .map((r) => r.id)
        .filter((rid) =>
          [highLate, highEarly, medium, low, ...excluded].includes(rid),
        );
      expect(mine).toEqual([highEarly, highLate, medium, low]);

      const limited = await listFixReadyFindings({ db, limit: 2 });
      expect(limited.length).toBeLessThanOrEqual(2);
      expect(limited.every((r) => r.severity === "high")).toBe(true);
    });
  });

  describe("gate report and updates", () => {
    it("getFixAttemptForGateReport reads by id without an org; updateFixAttempt is fenced", async () => {
      const id = await makeFinding(orgA);
      const won = await claim(id);
      const attemptId = won!.attempt.id;
      expect(
        (await getFixAttemptForGateReport({ db, attemptId }))?.organizationId,
      ).toBe(orgA);
      expect(
        await updateFixAttempt({
          db,
          organizationId: orgB,
          id: attemptId,
          patch: { phase: "checking" },
        }),
      ).toBeNull();
      expect(
        (
          await updateFixAttempt({
            db,
            organizationId: orgA,
            id: attemptId,
            patch: { phase: "checking" },
          })
        )?.phase,
      ).toBe("checking");
      expect(
        await getFixAttemptById({ db, organizationId: orgB, id: attemptId }),
      ).toBeNull();
    });
  });
});
