import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { createDb } from "../db";
import {
  thread as threadTable,
  threadChat as threadChatTable,
} from "../db/schema";
import {
  markThreadsTerminal,
  reapableThreadStatuses,
  stopStalledThreads,
} from "./threads";
import { ThreadStatus } from "../db/types";
import { createOrganization } from "./organizations";
import {
  createTestUser,
  createTestThread,
  createTestRemoteRun,
  createTestAutomation,
} from "./test-helpers";
import {
  markThreadsSuperseded,
  markThreadTerminal,
  findOrphanRemoteThreads,
  setThreadActiveRun,
  decideThreadGeneration,
  checkThreadGeneration,
  THREAD_SUPERSEDED_ERROR,
} from "./threads";
import {
  recordHatchetRun,
  findSupersedableReviewRuns,
  markHatchetRunsSuperseded,
  retireHatchetRun,
  claimSweepLease,
  findSweepCandidates,
  hasNewerRun,
  SWEEP_LEASE_MS,
  pruneHatchetRuns,
  HATCHET_RUN_PRUNE_AFTER_MS,
  SUPERSEDE_FRESHNESS_MS,
} from "./hatchet-run";
import { hatchetRun as hatchetRunTable } from "../db/schema";

const db = createDb(env.DATABASE_URL!);

async function makeOrg(name: string): Promise<string> {
  const org = await createOrganization({
    db,
    name,
    slug: `${name.toLowerCase()}-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

/** Set a thread's status/errorMessage directly (ThreadInsert omits these columns). */
async function setThreadStatus(
  threadId: string,
  status: ThreadStatus,
  errorMessage: string | null = null,
): Promise<void> {
  await db
    .update(threadTable)
    .set({ status, errorMessage })
    .where(eq(threadTable.id, threadId));
}

describe("hatchet-run (#8 supersede tracking, org-fenced)", () => {
  let userId: string;
  let orgA: string;
  let orgB: string;

  async function makeThread(organizationId: string, prNumber: number) {
    const { threadId } = await createTestThread({
      db,
      userId,
      overrides: {
        organizationId,
        githubRepoFullName: "acme/widgets",
        githubPRNumber: prNumber,
      },
    });
    return threadId;
  }

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    orgA = await makeOrg("acme");
    orgB = await makeOrg("globex");
  });

  it("records an in_flight run and finds it as supersedable from a newer thread", async () => {
    const oldThread = await makeThread(orgA, 42);
    const newThread = await makeThread(orgA, 42);
    await recordHatchetRun({
      db,
      threadId: oldThread,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 42,
      externalId: "run-old",
    });

    const found = await findSupersedableReviewRuns({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 42,
      excludeThreadId: newThread,
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.externalId).toBe("run-old");
    expect(found[0]!.threadId).toBe(oldThread);
  });

  it("never returns the current thread's own run (a dispatch can't supersede itself)", async () => {
    const t = await makeThread(orgA, 7);
    await recordHatchetRun({
      db,
      threadId: t,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 7,
      externalId: "run-self",
    });
    const found = await findSupersedableReviewRuns({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 7,
      excludeThreadId: t,
    });
    expect(found).toHaveLength(0);
  });

  it("is org-fenced: org B never sees org A's in-flight run for the same repo/PR", async () => {
    const aThread = await makeThread(orgA, 9);
    await recordHatchetRun({
      db,
      threadId: aThread,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 9,
      externalId: "run-a",
    });
    const bThread = await makeThread(orgB, 9);
    const found = await findSupersedableReviewRuns({
      db,
      organizationId: orgB,
      repoFullName: "acme/widgets",
      prNumber: 9,
      excludeThreadId: bThread,
    });
    expect(found).toHaveLength(0);
  });

  it("matches repo slug case-insensitively", async () => {
    const oldThread = await makeThread(orgA, 5);
    const newThread = await makeThread(orgA, 5);
    await recordHatchetRun({
      db,
      threadId: oldThread,
      organizationId: orgA,
      repoFullName: "ACME/Widgets", // stored lowercased
      prNumber: 5,
      externalId: "run-case",
    });
    const found = await findSupersedableReviewRuns({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 5,
      excludeThreadId: newThread,
    });
    expect(found).toHaveLength(1);
  });

  it("ignores runs older than the freshness window (long-finished, never a cancel target)", async () => {
    const oldThread = await makeThread(orgA, 3);
    const newThread = await makeThread(orgA, 3);
    await recordHatchetRun({
      db,
      threadId: oldThread,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 3,
      externalId: "run-stale",
    });
    // A `now` far past the freshness window makes the just-inserted row too old.
    const found = await findSupersedableReviewRuns({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 3,
      excludeThreadId: newThread,
      now: new Date(Date.now() + SUPERSEDE_FRESHNESS_MS + 60_000),
    });
    expect(found).toHaveLength(0);
  });

  it("pruneHatchetRuns deletes rows past the prune age and keeps fresh ones", async () => {
    const t = await makeThread(orgA, 21);
    const aged = await recordHatchetRun({
      db,
      threadId: t,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 21,
      externalId: "run-aged",
    });
    const fresh = await recordHatchetRun({
      db,
      threadId: t,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 21,
      externalId: "run-fresh",
    });
    // Backdate ONE row past the prune age (prune with default `now` — backdating,
    // not a future clock, so concurrent tests' fresh rows are never collateral).
    await db
      .update(hatchetRunTable)
      .set({
        createdAt: new Date(Date.now() - HATCHET_RUN_PRUNE_AFTER_MS - 60_000),
      })
      .where(eq(hatchetRunTable.id, aged.id));

    const pruned = await pruneHatchetRuns({ db });
    expect(pruned).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .select()
      .from(hatchetRunTable)
      .where(eq(hatchetRunTable.threadId, t));
    expect(remaining.map((r) => r.id)).toEqual([fresh.id]);
  });

  it("markHatchetRunsSuperseded drops rows out of the supersedable set", async () => {
    const oldThread = await makeThread(orgA, 11);
    const newThread = await makeThread(orgA, 11);
    const row = await recordHatchetRun({
      db,
      threadId: oldThread,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 11,
      externalId: "run-x",
    });
    await markHatchetRunsSuperseded({ db, ids: [row.id] });
    const found = await findSupersedableReviewRuns({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 11,
      excludeThreadId: newThread,
    });
    expect(found).toHaveLength(0);
  });
});

describe("markThreadsSuperseded", () => {
  let userId: string;
  let orgA: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    orgA = await makeOrg("acme");
  });

  it("flips an ACTIVE thread to terminal 'complete' with a 'superseded' reason", async () => {
    const { threadId } = await createTestThread({
      db,
      userId,
      overrides: { organizationId: orgA },
    });
    await setThreadStatus(threadId, "working");
    const moved = await markThreadsSuperseded({ db, threadIds: [threadId] });
    expect(moved).toBe(1);
    const [row] = await db.query.thread.findMany({
      where: (thread, { eq }) => eq(thread.id, threadId),
    });
    expect(row!.status).toBe("complete");
    expect(row!.errorMessage).toBe("superseded");
  });

  it("does NOT clobber a thread that already reached a terminal state", async () => {
    const { threadId } = await createTestThread({
      db,
      userId,
      overrides: { organizationId: orgA },
    });
    await setThreadStatus(threadId, "complete", null);
    const moved = await markThreadsSuperseded({ db, threadIds: [threadId] });
    expect(moved).toBe(0);
    const [row] = await db.query.thread.findMany({
      where: (thread, { eq }) => eq(thread.id, threadId),
    });
    expect(row!.errorMessage).toBeNull();
  });
});

describe("#125 C1 generation fence (decideThreadGeneration / checkThreadGeneration)", () => {
  let userId: string;
  let orgA: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    orgA = await makeOrg("acme");
  });

  it("pure decision: superseded wins, then stale generation, else ok (NULL stamp / no id fail OPEN)", () => {
    const live = { activeRunExternalId: "run-new", status: "working" as const };
    expect(
      decideThreadGeneration({
        thread: { ...live, errorMessage: null },
        runExternalId: "run-new",
      }),
    ).toEqual({ ok: true });
    expect(
      decideThreadGeneration({
        thread: { ...live, errorMessage: null },
        runExternalId: "run-old",
      }),
    ).toEqual({
      ok: false,
      reason: "stale-generation",
      activeRunExternalId: "run-new",
    });
    expect(
      decideThreadGeneration({
        thread: { ...live, errorMessage: null },
        runExternalId: null,
      }),
    ).toEqual({ ok: true });
    expect(
      decideThreadGeneration({
        thread: {
          activeRunExternalId: null,
          status: "working",
          errorMessage: null,
        },
        runExternalId: "anything",
      }),
    ).toEqual({ ok: true });
    expect(
      decideThreadGeneration({
        thread: {
          activeRunExternalId: "run-new",
          status: "complete",
          errorMessage: THREAD_SUPERSEDED_ERROR,
        },
        runExternalId: "run-new",
      }),
    ).toEqual({
      ok: false,
      reason: "superseded",
      activeRunExternalId: "run-new",
    });
  });

  it("reads the row: not-found, then the same decision; the writer constant is what it reads back", async () => {
    expect(
      await checkThreadGeneration({
        db,
        threadId: "00000000-0000-0000-0000-000000000000",
        runExternalId: "r",
      }),
    ).toEqual({ ok: false, reason: "not-found", activeRunExternalId: null });
    const { threadId } = await createTestThread({
      db,
      userId,
      overrides: { organizationId: orgA },
    });
    await setThreadStatus(threadId, "working");
    await setThreadActiveRun({ db, threadId, externalId: "run-new" });
    expect(
      await checkThreadGeneration({ db, threadId, runExternalId: "run-old" }),
    ).toMatchObject({ ok: false, reason: "stale-generation" });
    await markThreadsSuperseded({ db, threadIds: [threadId] });
    expect(
      await checkThreadGeneration({ db, threadId, runExternalId: "run-new" }),
    ).toMatchObject({ ok: false, reason: "superseded" });
  });

  it("retireHatchetRun flips exactly the matching row (by externalId); unknown id is a no-op", async () => {
    const { threadId } = await createTestThread({
      db,
      userId,
      overrides: { organizationId: orgA },
    });
    await recordHatchetRun({
      db,
      threadId,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 1,
      externalId: "ext-1",
    });
    await retireHatchetRun({
      db,
      key: { externalId: "nope" },
      as: "superseded",
    });
    let [row] = await db
      .select()
      .from(hatchetRunTable)
      .where(eq(hatchetRunTable.externalId, "ext-1"));
    expect(row!.status).toBe("in_flight");
    await retireHatchetRun({
      db,
      key: { externalId: "ext-1" },
      as: "superseded",
    });
    [row] = await db
      .select()
      .from(hatchetRunTable)
      .where(eq(hatchetRunTable.externalId, "ext-1"));
    expect(row!.status).toBe("superseded");
  });
});

describe("#125 C4 sweep model: lease, candidates, orphans, terminal writer", () => {
  let userId: string;
  let orgA: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    orgA = await makeOrg("acme");
  });

  const remoteRun = (prNumber: number, ageMs: number, externalId: string) =>
    createTestRemoteRun({
      db,
      userId,
      organizationId: orgA,
      prNumber,
      externalId,
      ageMs,
    });

  it("claimSweepLease is a compare-and-set: one winner, then free again after expiry", async () => {
    const { runId } = await remoteRun(1, 0, "ext-lease");
    const now = new Date();
    const [a, b] = await Promise.all([
      claimSweepLease({ db, id: runId, now }),
      claimSweepLease({ db, id: runId, now }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    // Still leased.
    expect(await claimSweepLease({ db, id: runId, now })).toBe(false);
    // Past expiry.
    expect(
      await claimSweepLease({
        db,
        id: runId,
        now: new Date(now.getTime() + SWEEP_LEASE_MS + 1),
      }),
    ).toBe(true);
  });

  it("findSweepCandidates: only in_flight rows older than T with a non-terminal thread and no live lease", async () => {
    await remoteRun(2, 11 * 60 * 1000, "ext-old");
    await remoteRun(3, 2 * 60 * 1000, "ext-young");
    const terminal = await remoteRun(4, 11 * 60 * 1000, "ext-terminal");
    await markThreadTerminal({
      db,
      threadId: terminal.threadId,
      cause: "superseded",
    });
    const leased = await remoteRun(5, 11 * 60 * 1000, "ext-leased");
    await claimSweepLease({ db, id: leased.runId });

    const ids = (
      await findSweepCandidates({ db, olderThanMs: 10 * 60 * 1000 })
    ).map((c) => c.externalId);
    expect(ids).toContain("ext-old");
    expect(ids).not.toContain("ext-young");
    expect(ids).not.toContain("ext-terminal");
    expect(ids).not.toContain("ext-leased");
  });

  it("hasNewerRun sees only later siblings of the same (org, repo, PR)", async () => {
    const first = await remoteRun(6, 5 * 60 * 1000, "ext-first");
    const [firstRow] = await db
      .select()
      .from(hatchetRunTable)
      .where(eq(hatchetRunTable.id, first.runId));
    expect(
      await hasNewerRun({
        db,
        organizationId: orgA,
        repoFullName: "ACME/Widgets",
        prNumber: 6,
        after: firstRow!.createdAt,
        excludeExternalId: "ext-first",
      }),
    ).toBe(false);
    await remoteRun(6, 0, "ext-second");
    expect(
      await hasNewerRun({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
        prNumber: 6,
        after: firstRow!.createdAt,
        excludeExternalId: "ext-first",
      }),
    ).toBe(true);
    // Another PR / another org never counts.
    const orgB = await makeOrg("globex");
    expect(
      await hasNewerRun({
        db,
        organizationId: orgB,
        repoFullName: "acme/widgets",
        prNumber: 6,
        after: firstRow!.createdAt,
      }),
    ).toBe(false);
  });

  it("markThreadTerminal writes the typed cause exactly once", async () => {
    const { threadId } = await remoteRun(7, 0, "ext-term");
    expect(
      await markThreadTerminal({ db, threadId, cause: "user-cancelled" }),
    ).toBe(true);
    expect(
      await markThreadTerminal({ db, threadId, cause: "superseded" }),
    ).toBe(false);
    const [row] = await db.query.thread.findMany({
      where: (t, { eq: e }) => e(t.id, threadId),
    });
    expect(row!.status).toBe("complete");
    expect(row!.terminalCause).toBe("user-cancelled");
    // The legacy errorMessage sentinel is written ONLY for `superseded`.
    expect(row!.errorMessage).toBeNull();
  });

  it("findSweepCandidates sees a CHAT-MODE thread (status on threadChat, thread row at its creation value) — and drops it once its chat row is terminal", async () => {
    const chatMode = await createTestRemoteRun({
      db,
      userId,
      organizationId: orgA,
      prNumber: 77,
      externalId: "ext-chat-mode",
      ageMs: 20 * 60 * 1000,
      enableThreadChatCreation: true,
    });
    const [row] = await db
      .select({ status: threadTable.status })
      .from(threadTable)
      .where(eq(threadTable.id, chatMode.threadId));
    expect(reapableThreadStatuses).not.toContain(row!.status); // thread row is NOT live
    let ids = (
      await findSweepCandidates({ db, olderThanMs: 10 * 60 * 1000 })
    ).map((c) => c.threadId);
    expect(ids).toContain(chatMode.threadId);
    // Its chat row reaches a terminal → no longer a candidate.
    await db
      .update(threadChatTable)
      .set({ status: "complete" })
      .where(eq(threadChatTable.id, chatMode.threadChatId));
    ids = (await findSweepCandidates({ db, olderThanMs: 10 * 60 * 1000 })).map(
      (c) => c.threadId,
    );
    expect(ids).not.toContain(chatMode.threadId);
  });

  it("markThreadsTerminal stamps terminalCause on the THREAD row of a chat-mode thread whose live status is on threadChat (exactly once)", async () => {
    const chatMode = await createTestRemoteRun({
      db,
      userId,
      organizationId: orgA,
      prNumber: 78,
      externalId: "ext-chat-cause",
      enableThreadChatCreation: true,
    });
    expect(
      await markThreadsTerminal({
        db,
        threadIds: [chatMode.threadId],
        cause: "superseded",
      }),
    ).toEqual([chatMode.threadId]);
    const row = async () =>
      (
        await db
          .select({
            status: threadTable.status,
            terminalCause: threadTable.terminalCause,
          })
          .from(threadTable)
          .where(eq(threadTable.id, chatMode.threadId))
      )[0]!;
    const chat = async () =>
      (
        await db
          .select({
            status: threadChatTable.status,
            errorMessage: threadChatTable.errorMessage,
          })
          .from(threadChatTable)
          .where(eq(threadChatTable.id, chatMode.threadChatId))
      )[0]!;
    expect(await chat()).toEqual({
      status: "complete",
      errorMessage: "superseded",
    });
    const first = await row();
    expect(first.terminalCause).toBe("superseded");
    expect(reapableThreadStatuses).not.toContain(first.status); // thread row untouched otherwise
    // A retry moves nothing and rewrites nothing.
    expect(
      await markThreadsTerminal({
        db,
        threadIds: [chatMode.threadId],
        cause: "timeout",
      }),
    ).toEqual([]);
    expect((await row()).terminalCause).toBe("superseded");
  });

  it("findOrphanRemoteThreads with remoteProviderOnly=false (HATCHET_ENABLED deployments) matches a review thread whose provider column is the local default", async () => {
    const reviewAutomation = await createTestAutomation({
      db,
      userId,
      values: {
        organizationId: orgA,
        triggerType: "pull_request",
        repoFullName: "acme/widgets",
        triggerConfig: { on: { open: true, update: true }, filter: {} },
      },
    });
    const t = await createTestThread({
      db,
      userId,
      overrides: {
        organizationId: orgA,
        sandboxProvider: "docker", // what production stamps under HATCHET_ENABLED
        githubRepoFullName: "acme/widgets",
        githubPRNumber: 13,
        automationId: reviewAutomation.id,
      },
    });
    await db
      .update(threadTable)
      .set({
        status: "booting",
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
      })
      .where(eq(threadTable.id, t.threadId));
    const strict = (
      await findOrphanRemoteThreads({ db, olderThanMs: 15 * 60 * 1000 })
    ).map((x) => x.id);
    expect(strict).not.toContain(t.threadId);
    const all = (
      await findOrphanRemoteThreads({
        db,
        olderThanMs: 15 * 60 * 1000,
        remoteProviderOnly: false,
      })
    ).map((x) => x.id);
    expect(all).toContain(t.threadId);
  });

  it("findOrphanRemoteThreads sees a CHAT-MODE review thread whose chat row is stuck in booting", async () => {
    const reviewAutomation = await createTestAutomation({
      db,
      userId,
      values: {
        organizationId: orgA,
        triggerType: "pull_request",
        repoFullName: "acme/widgets",
        triggerConfig: { on: { open: true, update: true }, filter: {} },
      },
    });
    const t = await createTestThread({
      db,
      userId,
      overrides: {
        organizationId: orgA,
        sandboxProvider: "hatchet-remote",
        githubRepoFullName: "acme/widgets",
        githubPRNumber: 12,
        automationId: reviewAutomation.id,
      },
      chatOverrides: { status: "booting" },
      enableThreadChatCreation: true,
    });
    await db
      .update(threadTable)
      .set({ createdAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(threadTable.id, t.threadId));
    const ids = (
      await findOrphanRemoteThreads({ db, olderThanMs: 15 * 60 * 1000 })
    ).map((x) => x.id);
    expect(ids).toContain(t.threadId);
  });

  it("findOrphanRemoteThreads: ONLY a review thread (org + PR + pull_request automation) still in `booting`, run-less, older than N", async () => {
    const reviewAutomation = await createTestAutomation({
      db,
      userId,
      values: {
        organizationId: orgA,
        triggerType: "pull_request",
        repoFullName: "acme/widgets",
        triggerConfig: { on: { open: true, update: true }, filter: {} },
      },
    });
    const mentionAutomation = await createTestAutomation({
      db,
      userId,
      values: {
        organizationId: orgA,
        triggerType: "github_mention",
        repoFullName: "acme/widgets",
        triggerConfig: {},
      },
    });
    const old = new Date(Date.now() - 20 * 60 * 1000);
    const mk = async (over: Record<string, unknown>, status: ThreadStatus) => {
      const t = await createTestThread({
        db,
        userId,
        overrides: {
          organizationId: orgA,
          sandboxProvider: "hatchet-remote",
          githubRepoFullName: "acme/widgets",
          ...over,
        },
      });
      await db
        .update(threadTable)
        .set({ status, createdAt: old })
        .where(eq(threadTable.id, t.threadId));
      return t.threadId;
    };
    const orphan = await mk(
      { githubPRNumber: 9, automationId: reviewAutomation.id },
      "booting",
    );
    const mention = await mk({ automationId: mentionAutomation.id }, "booting");
    const progressed = await mk(
      { githubPRNumber: 10, automationId: reviewAutomation.id },
      "working",
    );
    const tracked = await remoteRun(8, 20 * 60 * 1000, "ext-tracked");
    const noAutomation = await mk({ githubPRNumber: 11 }, "booting");

    const ids = (
      await findOrphanRemoteThreads({ db, olderThanMs: 15 * 60 * 1000 })
    ).map((t) => t.id);
    expect(ids).toContain(orphan);
    expect(ids).not.toContain(mention);
    expect(ids).not.toContain(progressed);
    expect(ids).not.toContain(tracked.threadId);
    expect(ids).not.toContain(noAutomation);
  });
});

describe("markThreadsTerminal — supersededByThreadId on the chat-only path (#153)", () => {
  // The ONLY genuinely uncovered case here. The chat-mode terminal itself is
  // already pinned by "stamps terminalCause on the THREAD row of a chat-mode
  // thread ... (exactly once)" above, and the legacy path by
  // "markThreadTerminal writes the typed cause exactly once" — both of which
  // assert MORE than a duplicate would. supersededByThreadId has no coverage on
  // main (verified 2026-08-26), and it rides the follow-up write that only
  // fires when a thread moved via its chat row.
  let userId: string;
  let orgA: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    orgA = await makeOrg("acme-153");
  });

  it("stamps the superseding thread id on the thread row of a chat-mode thread", async () => {
    const mk = (prNumber: number) =>
      createTestRemoteRun({
        db,
        userId,
        organizationId: orgA,
        prNumber,
        externalId: nanoid(),
        enableThreadChatCreation: true,
      });
    const { threadId } = await mk(2);
    const { threadId: newerId } = await mk(2);

    await markThreadsTerminal({
      db,
      threadIds: [threadId],
      cause: "superseded",
      supersededByThreadId: newerId,
    });

    const [row] = await db.query.thread.findMany({
      where: (t, { eq }) => eq(t.id, threadId),
    });
    expect(row!.terminalCause).toBe("superseded");
    expect(row!.supersededByThreadId).toBe(newerId);
  });
});

describe("stopStalledThreads — the stall watchdog writes a TYPED terminal", () => {
  // Before this, the watchdog wrote `status = complete` with NO terminalCause.
  // decideThreadGeneration treats a PRESENT-but-null cause as "not terminal"
  // without consulting status, so every thread the watchdog reaped stayed
  // PERMANENTLY unfenced — a late daemon event was admitted forever, not for a
  // window. It also wrote only the thread row and had no reapable guard.
  let userId: string;
  let orgA: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    orgA = await makeOrg("acme-stall");
  });

  const stalled = (prNumber: number, chat = false) =>
    createTestRemoteRun({
      db,
      userId,
      organizationId: orgA,
      prNumber,
      externalId: nanoid(),
      enableThreadChatCreation: chat,
      status: "working",
    });

  it("stamps terminalCause so the generation fence actually refuses late writes", async () => {
    const { threadId } = await stalled(11);
    await stopStalledThreads({ db, threadIds: [threadId] });

    const [row] = await db.query.thread.findMany({
      where: (t, { eq }) => eq(t.id, threadId),
    });
    expect(row!.status).toBe("complete");
    expect(row!.terminalCause).toBe("timeout");

    // The property that matters: the fence now refuses.
    expect(
      decideThreadGeneration({
        thread: {
          activeRunExternalId: row!.activeRunExternalId,
          status: row!.status,
          errorMessage: row!.errorMessage,
          terminalCause: row!.terminalCause,
        },
        runExternalId: null,
      }).ok,
    ).toBe(false);
  });

  it("preserves the user-visible request-timeout error", async () => {
    const { threadId } = await stalled(12);
    await stopStalledThreads({ db, threadIds: [threadId] });
    const [row] = await db.query.thread.findMany({
      where: (t, { eq }) => eq(t.id, threadId),
    });
    // chat-error.tsx renders a dedicated case for this value.
    expect(row!.errorMessage).toBe("request-timeout");
  });

  it("terminates a chat-mode thread's LIVE status row, not just the thread row", async () => {
    const { threadId } = await stalled(13, true);
    await stopStalledThreads({ db, threadIds: [threadId] });
    const [chat] = await db.query.threadChat.findMany({
      where: (c, { eq }) => eq(c.threadId, threadId),
    });
    expect(chat!.status).toBe("complete");
  });

  it("is idempotent — a second tick does not overwrite a terminal already reached", async () => {
    const { threadId } = await stalled(14);
    await markThreadsTerminal({
      db,
      threadIds: [threadId],
      cause: "user-cancelled",
    });
    await stopStalledThreads({ db, threadIds: [threadId] });
    const [row] = await db.query.thread.findMany({
      where: (t, { eq }) => eq(t.id, threadId),
    });
    expect(row!.terminalCause).toBe("user-cancelled");
    // The old bare UPDATE had no reapable guard, so it clobbered the
    // errorMessage of a thread that had already legitimately terminated.
    expect(row!.errorMessage).not.toBe("request-timeout");
  });
});
