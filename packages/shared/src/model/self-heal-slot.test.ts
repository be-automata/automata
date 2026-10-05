import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { createDb } from "../db";
import { selfHealSlot, thread, threadChat } from "../db/schema";
import { createOrganization } from "./organizations";
import {
  acquireSelfHealSlot,
  countAdmissionDeferrals,
  getSelfHealSlot,
  recordAdmissionDeferral,
  releaseSelfHealSlot,
  SELF_HEAL_SLOT_KEY,
  setSlotHolderThread,
} from "./self-heal-slot";
import { withSelfHealTx } from "./self-heal-tx";
import { createTestThread, createTestUser } from "./test-helpers";

vi.mock("./self-heal-tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./self-heal-tx")>();
  return { ...actual, withSelfHealTx: vi.fn(actual.withSelfHealTx) };
});

const db = createDb(env.DATABASE_URL!);
const MIN = 60_000;
const T0 = new Date("2026-10-04T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

describe("self-heal box slot", () => {
  let orgA: string;
  let orgB: string;
  let userId: string;

  async function newThread(
    opts: { enableThreadChatCreation?: boolean } = {},
  ): Promise<string> {
    const { threadId } = await createTestThread({ db, userId, ...opts });
    await db
      .update(thread)
      .set({ status: "working" })
      .where(eq(thread.id, threadId));
    return threadId;
  }

  beforeEach(async () => {
    await db.delete(selfHealSlot);
    const slug = nanoid(8).toLowerCase();
    orgA = (await createOrganization({ db, name: "a", slug: `a-${slug}` })).id;
    orgB = (await createOrganization({ db, name: "b", slug: `b-${slug}` })).id;
    userId = (await createTestUser({ db })).user.id;
    vi.mocked(withSelfHealTx).mockClear();
  });

  it("is free before the first acquisition and records the acquirer", async () => {
    expect(await getSelfHealSlot({ db })).toBeNull();
    const r = await acquireSelfHealSlot({
      db,
      organizationId: orgA,
      holderKind: "audit",
      now: T0,
    });
    expect(r).toEqual({ acquired: true });
    const row = await getSelfHealSlot({ db });
    expect(row?.slotKey).toBe(SELF_HEAL_SLOT_KEY);
    expect(row?.organizationId).toBe(orgA);
    expect(row?.holderKind).toBe("audit");
    expect(row?.holderThreadId).toBeNull();
    expect(row?.leaseUntil?.getTime()).toBe(at(5).getTime());
    expect(row?.acquiredAt?.getTime()).toBe(T0.getTime());
    expect(vi.mocked(withSelfHealTx)).toHaveBeenCalledTimes(1);
  });

  it("two concurrent acquisitions produce exactly one holder (platform-wide, across orgs)", async () => {
    const results = await Promise.all([
      acquireSelfHealSlot({
        db,
        organizationId: orgA,
        holderKind: "fix",
        now: T0,
      }),
      acquireSelfHealSlot({
        db,
        organizationId: orgB,
        holderKind: "audit",
        now: T0,
      }),
    ]);
    const winners = results.filter((r) => r.acquired);
    expect(winners).toHaveLength(1);
    const loser = results.find((r) => !r.acquired);
    expect(loser).toBeDefined();
    if (loser && !loser.acquired) {
      expect(loser.heldBy?.threadId).toBeNull();
      expect(loser.heldBy?.leaseUntil?.getTime()).toBe(at(5).getTime());
      expect(["audit", "fix"]).toContain(loser.heldBy?.kind);
    }
  });

  it("a pre-holder lease expires after 5 min", async () => {
    await acquireSelfHealSlot({
      db,
      organizationId: orgA,
      holderKind: "fix",
      now: T0,
    });
    const early = await acquireSelfHealSlot({
      db,
      organizationId: orgB,
      holderKind: "audit",
      now: at(4),
    });
    expect(early.acquired).toBe(false);
    const late = await acquireSelfHealSlot({
      db,
      organizationId: orgB,
      holderKind: "audit",
      now: at(6),
    });
    expect(late).toEqual({ acquired: true });
    expect((await getSelfHealSlot({ db }))?.organizationId).toBe(orgB);
  });

  it("a recorded holder thread extends the lease to 75 min", async () => {
    const tid = await newThread();
    await acquireSelfHealSlot({
      db,
      organizationId: orgA,
      holderKind: "fix",
      now: T0,
    });
    expect(await setSlotHolderThread({ db, threadId: tid, now: at(1) })).toBe(
      true,
    );
    const row = await getSelfHealSlot({ db });
    expect(row?.holderThreadId).toBe(tid);
    expect(row?.leaseUntil?.getTime()).toBe(at(76).getTime());

    const mid = await acquireSelfHealSlot({
      db,
      organizationId: orgB,
      holderKind: "audit",
      now: at(30),
    });
    expect(mid).toEqual({
      acquired: false,
      heldBy: { threadId: tid, kind: "fix", leaseUntil: at(76) },
    });
    const after = await acquireSelfHealSlot({
      db,
      organizationId: orgB,
      holderKind: "audit",
      now: at(77),
    });
    expect(after).toEqual({ acquired: true });
  });

  it("setSlotHolderThread does not apply to an expired pre-holder lease, and is idempotent for the holder", async () => {
    const tid = await newThread();
    await acquireSelfHealSlot({
      db,
      organizationId: orgA,
      holderKind: "fix",
      now: T0,
    });
    expect(await setSlotHolderThread({ db, threadId: tid, now: at(6) })).toBe(
      false,
    );
    expect(await setSlotHolderThread({ db, threadId: tid, now: at(1) })).toBe(
      true,
    );
    expect(await setSlotHolderThread({ db, threadId: tid, now: at(2) })).toBe(
      true,
    );
    const other = await newThread();
    expect(await setSlotHolderThread({ db, threadId: other, now: at(2) })).toBe(
      false,
    );
    expect((await getSelfHealSlot({ db }))?.holderThreadId).toBe(tid);
  });

  it.each([
    ["thread status complete", "status"],
    ["typed terminal cause", "cause"],
    ["chat-mode threadChat status stopped", "chat"],
  ] as const)(
    "a terminal holder thread frees the slot immediately (%s)",
    async (_label, kind) => {
      const tid = await newThread({
        enableThreadChatCreation: kind === "chat",
      });
      await acquireSelfHealSlot({
        db,
        organizationId: orgA,
        holderKind: "fix",
        now: T0,
      });
      await setSlotHolderThread({ db, threadId: tid, now: T0 });
      const blocked = await acquireSelfHealSlot({
        db,
        organizationId: orgB,
        holderKind: "audit",
        now: at(10),
      });
      expect(blocked.acquired).toBe(false);

      if (kind === "status") {
        await db
          .update(thread)
          .set({ status: "complete" })
          .where(eq(thread.id, tid));
      } else if (kind === "cause") {
        await db
          .update(thread)
          .set({ terminalCause: "superseded" })
          .where(eq(thread.id, tid));
      } else {
        await db
          .update(threadChat)
          .set({ status: "stopped" })
          .where(eq(threadChat.threadId, tid));
      }

      const freed = await acquireSelfHealSlot({
        db,
        organizationId: orgB,
        holderKind: "audit",
        now: at(10),
      });
      expect(freed).toEqual({ acquired: true });
      const row = await getSelfHealSlot({ db });
      expect(row?.holderThreadId).toBeNull();
      expect(row?.holderKind).toBe("audit");
    },
  );

  it("release by the holder thread frees it; release by another thread is a no-op", async () => {
    const tid = await newThread();
    const other = await newThread();
    await acquireSelfHealSlot({
      db,
      organizationId: orgA,
      holderKind: "fix",
      now: T0,
    });
    await setSlotHolderThread({ db, threadId: tid, now: T0 });

    expect(await releaseSelfHealSlot({ db, threadId: other })).toBe(false);
    expect(await releaseSelfHealSlot({ db })).toBe(false);
    expect((await getSelfHealSlot({ db }))?.holderThreadId).toBe(tid);

    expect(await releaseSelfHealSlot({ db, threadId: tid })).toBe(true);
    const row = await getSelfHealSlot({ db });
    expect(row?.leaseUntil).toBeNull();
    expect(row?.holderThreadId).toBeNull();
    expect(
      await acquireSelfHealSlot({
        db,
        organizationId: orgB,
        holderKind: "audit",
        now: at(1),
      }),
    ).toEqual({ acquired: true });
  });

  it("release without a thread frees only a pre-holder acquisition", async () => {
    await acquireSelfHealSlot({
      db,
      organizationId: orgA,
      holderKind: "audit",
      now: T0,
    });
    expect(await releaseSelfHealSlot({ db })).toBe(true);
    expect(await releaseSelfHealSlot({ db })).toBe(false);
    expect(
      await acquireSelfHealSlot({
        db,
        organizationId: orgB,
        holderKind: "fix",
        now: at(1),
      }),
    ).toEqual({ acquired: true });
  });
});

describe("admission deferral events", () => {
  it("counts a repo's deferrals since a cutoff, fenced to the org and repo", async () => {
    const slug = nanoid(8).toLowerCase();
    const org = (await createOrganization({ db, name: "d", slug: `d-${slug}` }))
      .id;
    const other = (
      await createOrganization({ db, name: "e", slug: `e-${slug}` })
    ).id;
    const repo = `Acme/Deferred-${slug}`;
    const since = at(0);
    await recordAdmissionDeferral({
      db,
      organizationId: org,
      repoFullName: repo,
      reason: "review_in_flight",
      now: at(-1),
    });
    for (const reason of ["review_in_flight", "slot_held"] as const) {
      await recordAdmissionDeferral({
        db,
        organizationId: org,
        repoFullName: repo,
        reason,
        now: at(1),
      });
    }
    await recordAdmissionDeferral({
      db,
      organizationId: other,
      repoFullName: repo,
      reason: "slot_held",
      now: at(1),
    });
    await recordAdmissionDeferral({
      db,
      organizationId: org,
      repoFullName: `${repo}-x`,
      reason: "slot_held",
      now: at(1),
    });
    expect(
      await countAdmissionDeferrals({
        db,
        organizationId: org,
        repoFullName: repo.toLowerCase(),
        since,
      }),
    ).toBe(2);
  });
});
