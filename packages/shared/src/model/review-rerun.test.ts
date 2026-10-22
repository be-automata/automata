import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createDb } from "../db";
import { reviewRerun } from "../db/schema";
import { createTestThread, createTestUser } from "./test-helpers";
import {
  claimDueReviewReruns,
  expireStaleReviewRerunClaims,
  markReviewRerunDispatched,
  REVIEW_RERUN_CLAIM_LEASE_MS,
  planReviewRerun,
  REVIEW_RERUN_BACKOFF_MS,
  REVIEW_RERUN_MAX_ATTEMPTS,
  settleReviewRerun,
} from "./review-rerun";

const db = createDb(env.DATABASE_URL!);

describe("#107 review re-run ledger", () => {
  let prKey: string;
  let userId: string;
  const now = new Date("2026-10-22T12:00:00Z");

  async function failedThread(): Promise<string> {
    return (await createTestThread({ db, userId })).threadId;
  }

  const ledger = () =>
    db.select().from(reviewRerun).where(eq(reviewRerun.prKey, prKey));

  beforeEach(async () => {
    prKey = `org-${nanoid(6)}/acme/widgets/7`;
    userId = (await createTestUser({ db })).user.id;
  });

  it("schedules attempt 1 with the first backoff, and a second call for the same thread inserts nothing", async () => {
    const t1 = await failedThread();
    const first = await planReviewRerun({
      db,
      prKey,
      headSha: "sha-a",
      failedThreadId: t1,
      now,
    });
    expect(first).toEqual({
      kind: "scheduled",
      defer: true,
      attempt: 1,
      dueAt: new Date(now.getTime() + REVIEW_RERUN_BACKOFF_MS[0]!),
    });
    // The hourly sweep re-reads the same failed thread.
    const again = await planReviewRerun({
      db,
      prKey,
      headSha: "sha-a",
      failedThreadId: t1,
      now,
    });
    expect(again).toMatchObject({
      kind: "already_handed_off",
      defer: true,
      attempt: 1,
    });
    expect(await ledger()).toHaveLength(1);
  });

  it("the finish hook and the sweep racing on one thread produce one row", async () => {
    const t1 = await failedThread();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        planReviewRerun({
          db,
          prKey,
          headSha: "sha-a",
          failedThreadId: t1,
          now,
        }),
      ),
    );
    expect(results.every((r) => r.defer)).toBe(true);
    expect(results.filter((r) => r.kind === "scheduled")).toHaveLength(1);
    expect(await ledger()).toHaveLength(1);
  });

  it("bounded: a head gets at most MAX re-runs, then the next failure is exhausted", async () => {
    expect(REVIEW_RERUN_MAX_ATTEMPTS).toBe(2);
    const original = await failedThread();
    const s1 = await planReviewRerun({
      db,
      prKey,
      headSha: "sha-a",
      failedThreadId: original,
      now,
    });
    expect(s1).toMatchObject({ kind: "scheduled", attempt: 1 });
    // A pending re-run absorbs another failure at the same head.
    const sibling = await failedThread();
    expect(
      await planReviewRerun({
        db,
        prKey,
        headSha: "sha-a",
        failedThreadId: sibling,
        now,
      }),
    ).toMatchObject({ kind: "pending_for_head", defer: true, attempt: 1 });

    // The ledger is shared across tests: keep only this head's rows.
    const [claimed1] = (
      await claimDueReviewReruns({
        db,
        now: new Date(now.getTime() + 61_000),
      })
    ).filter((row) => row.prKey === prKey);
    expect(claimed1).toMatchObject({ attempt: 1, state: "claimed" });
    expect(await markReviewRerunDispatched({ db, id: claimed1!.id })).toBe(
      true,
    );

    const rerun1 = await failedThread();
    const s2 = await planReviewRerun({
      db,
      prKey,
      headSha: "sha-a",
      failedThreadId: rerun1,
      now,
    });
    expect(s2).toMatchObject({
      kind: "scheduled",
      attempt: 2,
      dueAt: new Date(now.getTime() + REVIEW_RERUN_BACKOFF_MS[1]!),
    });
    for (const row of await claimDueReviewReruns({
      db,
      now: new Date(now.getTime() + 181_000),
    })) {
      if (row.prKey === prKey)
        await markReviewRerunDispatched({ db, id: row.id });
    }

    const rerun2 = await failedThread();
    expect(
      await planReviewRerun({
        db,
        prKey,
        headSha: "sha-a",
        failedThreadId: rerun2,
        now,
      }),
    ).toEqual({ kind: "exhausted", defer: false, attempts: 2 });
    expect(await ledger()).toHaveLength(2);

    // A new head is a fresh budget.
    expect(
      await planReviewRerun({
        db,
        prKey,
        headSha: "sha-b",
        failedThreadId: rerun2,
        now,
      }),
    ).toMatchObject({ kind: "scheduled", attempt: 1 });
  });

  it("claims only due rows, exactly once across overlapping ticks", async () => {
    const t1 = await failedThread();
    await planReviewRerun({
      db,
      prKey,
      headSha: "sha-a",
      failedThreadId: t1,
      now,
    });
    const early = await claimDueReviewReruns({
      db,
      now: new Date(now.getTime() + 30_000),
    });
    expect(early.filter((r) => r.prKey === prKey)).toHaveLength(0);
    const later = new Date(now.getTime() + 60_000);
    const [a, b] = await Promise.all([
      claimDueReviewReruns({ db, now: later }),
      claimDueReviewReruns({ db, now: later }),
    ]);
    const mine = [...a!, ...b!].filter((r) => r.prKey === prKey);
    expect(mine).toHaveLength(1);
  });

  it("a failed dispatch tells the failed run to post its notice; settle only moves a claimed row", async () => {
    const t1 = await failedThread();
    await planReviewRerun({
      db,
      prKey,
      headSha: "sha-a",
      failedThreadId: t1,
      now,
    });
    const [row] = (
      await claimDueReviewReruns({ db, now: new Date(now.getTime() + 60_000) })
    ).filter((r) => r.prKey === prKey);
    expect(
      await settleReviewRerun({
        db,
        id: row!.id,
        state: "failed",
        reason: "dispatch_refused",
      }),
    ).toBe(true);
    expect(
      await settleReviewRerun({
        db,
        id: row!.id,
        state: "skipped",
        reason: "late",
      }),
    ).toBe(false);
    expect(
      await planReviewRerun({
        db,
        prKey,
        headSha: "sha-a",
        failedThreadId: t1,
        now,
      }),
    ).toEqual({ kind: "dispatch_failed", defer: false, attempts: 0 });
  });

  describe("crash between claim and dispatch (lease)", () => {
    async function claimedRow(failedThreadId: string) {
      await planReviewRerun({
        db,
        prKey,
        headSha: "sha-a",
        failedThreadId,
        now,
      });
      const claimAt = new Date(now.getTime() + 60_000);
      const [row] = (await claimDueReviewReruns({ db, now: claimAt })).filter(
        (r) => r.prKey === prKey,
      );
      expect(row).toMatchObject({ state: "claimed" });
      return { row: row!, claimAt };
    }

    it("within the lease the claim still defers; once it lapses the failed run posts its notice", async () => {
      const t1 = await failedThread();
      const { claimAt } = await claimedRow(t1);
      // The claimant died: no dispatch, no settle.
      expect(
        await planReviewRerun({
          db,
          prKey,
          headSha: "sha-a",
          failedThreadId: t1,
          now: new Date(claimAt.getTime() + 60_000),
        }),
      ).toMatchObject({ kind: "already_handed_off", defer: true });
      // Even before any cron expires it, a lapsed claim stops deferring.
      expect(
        await planReviewRerun({
          db,
          prKey,
          headSha: "sha-a",
          failedThreadId: t1,
          now: new Date(claimAt.getTime() + REVIEW_RERUN_CLAIM_LEASE_MS),
        }),
      ).toEqual({ kind: "dispatch_failed", defer: false, attempts: 0 });
    });

    it("the expiry turns a lapsed claim into failed and it is never re-claimed (no double dispatch)", async () => {
      const t1 = await failedThread();
      const { row, claimAt } = await claimedRow(t1);
      // Inside the lease: nothing expires.
      expect(
        (
          await expireStaleReviewRerunClaims({
            db,
            now: new Date(claimAt.getTime() + 60_000),
          })
        ).filter((r) => r.id === row.id),
      ).toHaveLength(0);
      const later = new Date(claimAt.getTime() + REVIEW_RERUN_CLAIM_LEASE_MS);
      const expired = (
        await expireStaleReviewRerunClaims({ db, now: later })
      ).filter((r) => r.id === row.id);
      expect(expired).toHaveLength(1);
      const [stored] = await ledger();
      expect(stored).toMatchObject({
        state: "failed",
        outcomeReason: "claim_expired",
      });
      expect(
        (await claimDueReviewReruns({ db, now: later })).filter(
          (r) => r.id === row.id,
        ),
      ).toHaveLength(0);
      // A late dispatch acknowledgement from the dead claimant changes nothing.
      expect(await markReviewRerunDispatched({ db, id: row.id })).toBe(false);
      expect(
        await planReviewRerun({
          db,
          prKey,
          headSha: "sha-a",
          failedThreadId: t1,
          now: later,
        }),
      ).toMatchObject({ kind: "dispatch_failed", defer: false });
    });

    it("a lapsed claim of ANOTHER failed run does not absorb a new failure at the head", async () => {
      const t1 = await failedThread();
      const { claimAt } = await claimedRow(t1);
      const t2 = await failedThread();
      const later = new Date(claimAt.getTime() + REVIEW_RERUN_CLAIM_LEASE_MS);
      expect(
        await planReviewRerun({
          db,
          prKey,
          headSha: "sha-a",
          failedThreadId: t2,
          now: later,
        }),
      ).toMatchObject({ kind: "scheduled", defer: true, attempt: 2 });
    });

    it("a pending row the dispatcher never picked up stops deferring after the lease", async () => {
      const t1 = await failedThread();
      await planReviewRerun({
        db,
        prKey,
        headSha: "sha-a",
        failedThreadId: t1,
        now,
      });
      const due = new Date(now.getTime() + REVIEW_RERUN_BACKOFF_MS[0]!);
      expect(
        await planReviewRerun({
          db,
          prKey,
          headSha: "sha-a",
          failedThreadId: t1,
          now: new Date(due.getTime() + REVIEW_RERUN_CLAIM_LEASE_MS),
        }),
      ).toMatchObject({ kind: "dispatch_failed", defer: false });
    });
  });
});
