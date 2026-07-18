import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { thread as threadTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { User } from "@terragon/shared";
import { maybeStartQueuedThreadChat } from "./process-queued-thread";

// Fresh queued threads get promoted via startAgentMessage; stub it to a no-op so
// the test observes the DB transitions (dequeue vs retire) without booting a
// sandbox. (Assertions are on DB state, not the spy, to avoid the cross-module
// mock-identity quirk.)
vi.mock("@/agent/msg/startAgentMessage", () => ({
  startAgentMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/subscription-tiers", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, getMaxConcurrentTaskCountForUser: vi.fn().mockResolvedValue(3) };
});
// No PR/issue on the test threads → the GitHub closed-check is skipped.

async function statusOf(threadId: string) {
  const [row] = await db
    .select({ status: threadTable.status, archived: threadTable.archived })
    .from(threadTable)
    .where(eq(threadTable.id, threadId));
  return row;
}

describe("maybeStartQueuedThreadChat — drain + stale retirement (S12)", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
  });

  async function queuedThread(createdAt: Date) {
    const { threadId } = await createTestThread({ db, userId: user.id });
    // Set the concurrency-queue status + age directly (status is not a createTestThread
    // override; the thread is the legacy chat so status lives on the thread row).
    await db
      .update(threadTable)
      .set({ status: "queued-tasks-concurrency", createdAt })
      .where(eq(threadTable.id, threadId));
    return threadId;
  }

  it("PROMOTES a fresh queued thread (recent) — dequeued out of the concurrency queue, not archived/retired", async () => {
    const threadId = await queuedThread(new Date());
    await maybeStartQueuedThreadChat({ userId: user.id });

    const row = await statusOf(threadId);
    // Promoted → no longer waiting in the concurrency queue, and NOT retired.
    expect(row?.status).not.toBe("queued-tasks-concurrency");
    expect(row?.archived).toBe(false);
    expect(row?.status).not.toBe("complete");
  });

  it("RETIRES a stale queued thread (queued > 1h) — archived + complete", async () => {
    const threadId = await queuedThread(
      new Date(Date.now() - 2 * 60 * 60 * 1000),
    );
    await maybeStartQueuedThreadChat({ userId: user.id });

    const row = await statusOf(threadId);
    expect(row?.archived).toBe(true);
    expect(row?.status).toBe("complete");
  });

  it("drains a mixed queue in one pass: retires the stale one, promotes the fresh one", async () => {
    const stale = await queuedThread(new Date(Date.now() - 2 * 60 * 60 * 1000));
    const fresh = await queuedThread(new Date());
    await maybeStartQueuedThreadChat({ userId: user.id });

    const staleRow = await statusOf(stale);
    const freshRow = await statusOf(fresh);
    expect(staleRow?.archived).toBe(true); // retired
    expect(staleRow?.status).toBe("complete");
    expect(freshRow?.archived).toBe(false); // promoted, not retired
    expect(freshRow?.status).not.toBe("queued-tasks-concurrency");
  });

  it("no-op when there are no queued threads (resolves, does not throw)", async () => {
    await expect(
      maybeStartQueuedThreadChat({ userId: user.id }),
    ).resolves.toBeUndefined();
  });
});
