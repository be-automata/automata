import { describe, it, vi, beforeEach, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  createTestAutomation,
  createTestOrganization,
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { recordHatchetRun } from "@terragon/shared/model/hatchet-run";
import {
  thread as threadTable,
  threadChat as threadChatTable,
} from "@terragon/shared/db/schema";
import { User } from "@terragon/shared";
import type { ThreadInsert } from "@terragon/shared";
import {
  atomicDequeueThreadChats,
  getEligibleQueuedThreadChats,
  markThreadTerminal,
} from "@terragon/shared/model/threads";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { getOctokitForApp } from "@/lib/github";
import { getMaxConcurrentTaskCountForUser } from "@/lib/subscription-tiers";
import { resolveBotLogin } from "./review/bot-login";
import {
  isStaleQueuedThread,
  maybeStartQueuedThreadChat,
  retireStrandedQueuedThreads,
} from "./process-queued-thread";

// test-setup.ts imports the process-thread-queue route, so this module and its
// dependencies are loaded BEFORE a vi.mock in this file could apply to them
// (the mock-identity quirk). The queue path therefore runs for real: the real
// startAgentMessage (which boots a promoted chat), the real concurrency cap,
// the real isReviewThread. The one seam is the App octokit, which
// test-setup.ts already replaces with a bare vi.fn(); each test gives it the
// GitHub behaviour it needs through `gh`.

interface FakeReview {
  id: number;
  user: { login: string };
  commit_id: string;
  state: string;
  body: string;
  submitted_at: string;
  dismissed_at: string | null;
}

const gh = {
  /** issue/PR number → GitHub's view of it. Absent = open. */
  sources: new Map<
    number,
    { state: "open" | "closed"; closed_at: string | null }
  >(),
  issuesGetError: null as Error | null,
  headSha: "",
  reviews: [] as FakeReview[],
  comments: [] as Array<{ id: number; user: { login: string }; body: string }>,
  createCommentError: null as Error | null,
  createComment: vi.fn(),
};

const BOT = resolveBotLogin();
const SHA = "0123456789abcdef0123456789abcdef01234567";
const MIN = 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

/** A stateful fake of the App octokit surface the queue path touches. */
function installFakeAppOctokit() {
  gh.sources.clear();
  gh.issuesGetError = null;
  gh.headSha = "";
  gh.reviews = [];
  gh.comments = [];
  gh.createCommentError = null;
  let nextCommentId = 1;
  gh.createComment = vi.fn(async ({ body }: { body: string }) => {
    if (gh.createCommentError) throw gh.createCommentError;
    gh.comments.push({ id: nextCommentId++, user: { login: BOT }, body });
    return { data: {} };
  });
  const octokit = {
    paginate: async (
      fn: (params: unknown) => Promise<{ data: unknown[] }>,
      params: unknown,
    ) => (await fn(params)).data,
    rest: {
      issues: {
        get: async ({ issue_number }: { issue_number: number }) => {
          if (gh.issuesGetError) throw gh.issuesGetError;
          return {
            data: gh.sources.get(issue_number) ?? {
              state: "open",
              closed_at: null,
            },
          };
        },
        listComments: async () => ({ data: [...gh.comments] }),
        createComment: gh.createComment,
        deleteComment: async ({ comment_id }: { comment_id: number }) => {
          gh.comments = gh.comments.filter((c) => c.id !== comment_id);
          return { data: {} };
        },
      },
      pulls: {
        get: async () => ({
          data: { head: { sha: gh.headSha }, draft: false, user: null },
        }),
        listReviews: async () => ({ data: [...gh.reviews] }),
      },
    },
  };
  vi.mocked(getOctokitForApp).mockImplementation(async () => octokit as never);
}

/** The legacy chat: status and queue bookkeeping live on the thread row. */
async function legacyRow(threadId: string) {
  const [row] = await db
    .select({
      status: threadTable.status,
      queuedAt: threadTable.queuedAt,
      errorMessage: threadTable.errorMessage,
      errorMessageInfo: threadTable.errorMessageInfo,
      archived: threadTable.archived,
    })
    .from(threadTable)
    .where(eq(threadTable.id, threadId));
  return row!;
}

async function chatRow(threadId: string, threadChatId: string) {
  const [chat] = await db
    .select({
      status: threadChatTable.status,
      queuedAt: threadChatTable.queuedAt,
      errorMessage: threadChatTable.errorMessage,
      errorMessageInfo: threadChatTable.errorMessageInfo,
    })
    .from(threadChatTable)
    .where(
      and(
        eq(threadChatTable.id, threadChatId),
        eq(threadChatTable.threadId, threadId),
      ),
    );
  const [thread] = await db
    .select({ archived: threadTable.archived })
    .from(threadTable)
    .where(eq(threadTable.id, threadId));
  return { ...chat!, archived: thread!.archived };
}

describe("maybeStartQueuedThreadChat — drain + stale retirement (S12)", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    installFakeAppOctokit();
    user = (await createTestUser({ db })).user;
  });

  /**
   * A legacy (thread-row) chat queued on the concurrency cap at `queuedAt`
   * BEFORE the deploy: queued_at stays NULL, so the dequeue ages it from the
   * row's pre-dequeue updated_at, i.e. the instant it was queued.
   */
  async function legacyQueuedThread(queuedAt: Date) {
    const { threadId } = await createTestThread({ db, userId: user.id });
    await db
      .update(threadTable)
      .set({
        status: "queued-tasks-concurrency",
        createdAt: queuedAt,
        updatedAt: queuedAt,
      })
      .where(eq(threadTable.id, threadId));
    return threadId;
  }

  /**
   * A chat-model thread queued on the concurrency cap through the REAL
   * transition (so queued_at is stamped by the code under test), then
   * optionally back-dated.
   */
  async function queuedChat(opts: {
    overrides?: Partial<ThreadInsert>;
    threadCreatedAt?: Date;
    queuedAt?: Date | null;
    updatedAt?: Date;
  }) {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: opts.overrides,
      enableThreadChatCreation: true,
    });
    await updateThreadChatWithTransition({
      userId: user.id,
      threadId,
      threadChatId,
      eventType: "system.concurrency-limit",
    });
    if (opts.threadCreatedAt) {
      await db
        .update(threadTable)
        .set({ createdAt: opts.threadCreatedAt })
        .where(eq(threadTable.id, threadId));
    }
    if (opts.queuedAt !== undefined || opts.updatedAt) {
      await db
        .update(threadChatTable)
        .set({
          ...(opts.queuedAt !== undefined ? { queuedAt: opts.queuedAt } : {}),
          ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
        })
        .where(eq(threadChatTable.id, threadChatId));
    }
    return { threadId, threadChatId };
  }

  /** A queued REVIEW: a pull_request automation thread dispatched at `SHA`. */
  async function queuedReview(prNumber: number, queuedAt: Date) {
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: { triggerType: "pull_request" },
    });
    return await queuedChat({
      overrides: {
        githubPRNumber: prNumber,
        reviewedSha: SHA,
        automationId: automation.id,
      },
      queuedAt,
    });
  }

  // ---- Pre-existing S12 cases (legacy thread rows) ------------------------

  it("PROMOTES a fresh queued thread (recent) — dequeued out of the concurrency queue, not archived/retired", async () => {
    const threadId = await legacyQueuedThread(new Date());
    await maybeStartQueuedThreadChat({ userId: user.id });

    const row = await legacyRow(threadId);
    // Promoted → no longer waiting in the concurrency queue, and NOT retired.
    expect(row?.status).not.toBe("queued-tasks-concurrency");
    expect(row?.archived).toBe(false);
    expect(row?.status).not.toBe("complete");
  });

  it("RETIRES a stale queued thread (queued > 1h) — archived + complete", async () => {
    const threadId = await legacyQueuedThread(ago(120 * MIN));
    await maybeStartQueuedThreadChat({ userId: user.id });

    const row = await legacyRow(threadId);
    expect(row?.archived).toBe(true);
    expect(row?.status).toBe("complete");
  });

  it("drains a mixed queue in one pass: retires the stale one, promotes the fresh one", async () => {
    const stale = await legacyQueuedThread(ago(120 * MIN));
    const fresh = await legacyQueuedThread(new Date());
    await maybeStartQueuedThreadChat({ userId: user.id });

    const staleRow = await legacyRow(stale);
    const freshRow = await legacyRow(fresh);
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

  // ---- #446 -------------------------------------------------------------

  // Card: protects=a post-merge audit queued behind a burst runs (criterion 1);
  // fails_when=the closed rule retires a run whose PR was already merged when
  // it was queued; no_claim=the audit's own finish effect.
  it("#446 c1: a merge audit whose PR closed BEFORE it was queued is promoted, not archived", async () => {
    gh.sources.set(501, {
      state: "closed",
      closed_at: ago(30 * MIN).toISOString(),
    });
    const { threadId, threadChatId } = await queuedChat({
      overrides: { githubPRNumber: 501 },
    });
    await maybeStartQueuedThreadChat({ userId: user.id });

    const row = await chatRow(threadId, threadChatId);
    expect(row.status).toBe("booting");
    expect(row.archived).toBe(false);
    expect(row.errorMessage).toBeNull();
  });

  // Card: protects=a review whose PR closed while it waited is retired
  // visibly, with one queue_retired notice at its dispatched head (criterion
  // 2); fails_when=the retirement is silent, or no / two notices land;
  // no_claim=the notice's wording (review-notice tests).
  it("#446 c2: a review whose PR closed AFTER queued_at is retired with queue-retired and one notice at its head", async () => {
    gh.headSha = SHA;
    gh.sources.set(502, {
      state: "closed",
      closed_at: ago(5 * MIN).toISOString(),
    });
    const { threadId, threadChatId } = await queuedReview(502, ago(10 * MIN));
    await maybeStartQueuedThreadChat({ userId: user.id });

    const row = await chatRow(threadId, threadChatId);
    expect(row.status).toBe("complete");
    expect(row.archived).toBe(true);
    expect(row.errorMessage).toBe("queue-retired");
    expect(row.errorMessageInfo).toContain("source #502 closed at");
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain(
      `<!-- automata:review-notice sha=${SHA} -->`,
    );
    expect(gh.comments[0]!.body).toContain(
      "the PR was closed while this review waited in the queue",
    );

    // Re-driving the same retirement adds no second notice (per-sha dedupe).
    await db
      .update(threadChatTable)
      .set({ status: "queued-tasks-concurrency" })
      .where(eq(threadChatTable.id, threadChatId));
    await maybeStartQueuedThreadChat({ userId: user.id });
    expect(gh.comments).toHaveLength(1);
  });

  // Card: protects=the notice is withheld when the head moved on or a bot
  // review already sits at that commit, and a failed post never blocks the
  // retirement; fails_when=a notice lands on a head the run was not for or
  // next to a verdict, or a GitHub failure leaves the run un-retired;
  // no_claim=the per-sha dedupe (review-notice tests).
  it("#446 c2: no notice when the head moved or a verdict exists; a failing notice post still retires", async () => {
    gh.headSha = "f".repeat(40);
    const moved = await queuedReview(503, ago(90 * MIN));
    await maybeStartQueuedThreadChat({ userId: user.id });
    expect(gh.createComment).not.toHaveBeenCalled();
    expect(
      (await chatRow(moved.threadId, moved.threadChatId)).errorMessage,
    ).toBe("queue-retired");

    gh.headSha = SHA;
    gh.reviews = [
      {
        id: 1,
        user: { login: BOT },
        commit_id: SHA,
        state: "APPROVED",
        body: "ok",
        submitted_at: new Date().toISOString(),
        dismissed_at: null,
      },
    ];
    const reviewed = await queuedReview(504, ago(90 * MIN));
    await maybeStartQueuedThreadChat({ userId: user.id });
    expect(gh.createComment).not.toHaveBeenCalled();
    expect(
      (await chatRow(reviewed.threadId, reviewed.threadChatId)).errorMessage,
    ).toBe("queue-retired");

    gh.reviews = [];
    gh.createCommentError = new Error("HTTP 502");
    const failing = await queuedReview(505, ago(90 * MIN));
    await maybeStartQueuedThreadChat({ userId: user.id });
    expect(gh.createComment).toHaveBeenCalledTimes(1);
    const row = await chatRow(failing.threadId, failing.threadChatId);
    expect(row.status).toBe("complete");
    expect(row.archived).toBe(true);
    expect(row.errorMessage).toBe("queue-retired");
  });

  // Card: protects=age is measured from queue entry, not thread creation
  // (criterion 3); fails_when=a fresh follow-up on an old thread is retired;
  // no_claim=how the follow-up reached the queue.
  it("#446 c3: a thread created 2h ago whose follow-up was queued 1 min ago is promoted", async () => {
    const { threadId, threadChatId } = await queuedChat({
      threadCreatedAt: ago(120 * MIN),
      queuedAt: ago(1 * MIN),
    });
    await maybeStartQueuedThreadChat({ userId: user.id });

    const row = await chatRow(threadId, threadChatId);
    expect(row.status).toBe("booting");
    expect(row.archived).toBe(false);
  });

  // Card: protects=a run that waited > 1h is retired VISIBLY (criterion 4);
  // fails_when=it runs, or retires with no errorMessage; no_claim=the 1h
  // threshold value itself.
  it("#446 c4: a chat queued > 1h ago (by queued_at) is retired with errorMessage queue-retired", async () => {
    const { threadId, threadChatId } = await queuedChat({
      threadCreatedAt: ago(70 * MIN),
      queuedAt: ago(65 * MIN),
    });
    await maybeStartQueuedThreadChat({ userId: user.id });

    const row = await chatRow(threadId, threadChatId);
    expect(row.status).toBe("complete");
    expect(row.archived).toBe(true);
    expect(row.errorMessage).toBe("queue-retired");
    expect(row.errorMessageInfo).toBe("queued-age 65m > 60m");
  });

  // Card: protects=the 2026-10-21 burst shape — merged-PR audits and a review
  // all run as slots free one by one (criterion 5); fails_when=any of them is
  // retired instead of started; no_claim=slot accounting beyond the cap gate.
  it("#446 c5: four merge audits plus one review, one free slot: all five are promoted as slots free, none retired", async () => {
    // Occupy every slot but one with running chats.
    const cap = await getMaxConcurrentTaskCountForUser(user.id);
    for (let i = 0; i < cap - 1; i++) {
      await createTestThread({
        db,
        userId: user.id,
        enableThreadChatCreation: true,
        chatOverrides: { status: "working" },
      });
    }
    const queued: Array<{ threadId: string; threadChatId: string }> = [];
    for (const pr of [601, 602, 603, 604]) {
      gh.sources.set(pr, {
        state: "closed",
        closed_at: ago(20 * MIN).toISOString(),
      });
      queued.push(await queuedChat({ overrides: { githubPRNumber: pr } }));
    }
    queued.push(
      await queuedChat({
        overrides: { githubPRNumber: 605, reviewedSha: SHA },
      }),
    );

    const started = new Set<string>();
    for (let round = 0; round < 5; round++) {
      await maybeStartQueuedThreadChat({ userId: user.id });
      const booting = [];
      for (const q of queued) {
        const row = await chatRow(q.threadId, q.threadChatId);
        expect(row.archived).toBe(false);
        expect(row.errorMessage).toBeNull();
        if (row.status === "booting") booting.push(q);
      }
      // The cap admits exactly one run into the one free slot.
      expect(booting).toHaveLength(1);
      started.add(booting[0]!.threadChatId);
      // That run finishes → its slot frees.
      await db
        .update(threadChatTable)
        .set({ status: "complete" })
        .where(eq(threadChatTable.id, booting[0]!.threadChatId));
    }
    expect(started.size).toBe(5);
  });

  // Card: protects=a mention on an already-closed issue runs (criterion 5b);
  // fails_when=the closed rule ignores closed_at for issues; no_claim=the
  // mention reply itself.
  it("#446 c5b: a mention on an already-closed issue is promoted, not retired", async () => {
    gh.sources.set(701, {
      state: "closed",
      closed_at: ago(3 * 24 * 60 * MIN).toISOString(),
    });
    const { threadId, threadChatId } = await queuedChat({
      overrides: { githubIssueNumber: 701 },
    });
    await maybeStartQueuedThreadChat({ userId: user.id });

    const row = await chatRow(threadId, threadChatId);
    expect(row.status).toBe("booting");
    expect(row.archived).toBe(false);
  });

  // Card: protects=rows queued before the deploy age from their PRE-dequeue
  // updated_at (criterion 5c); fails_when=the fallback reads updated_at after
  // the dequeue bumped it (never retires) or uses thread creation (retires a
  // fresh row); no_claim=legacy thread rows (covered by the S12 cases).
  it("#446 c5c: queued_at NULL ages from the chat's pre-dequeue updated_at", async () => {
    const old = await queuedChat({
      threadCreatedAt: ago(3 * 60 * MIN),
      queuedAt: null,
      updatedAt: ago(90 * MIN),
    });
    const fresh = await queuedChat({
      threadCreatedAt: ago(3 * 60 * MIN),
      queuedAt: null,
      updatedAt: ago(2 * MIN),
    });
    await maybeStartQueuedThreadChat({ userId: user.id });

    const oldRow = await chatRow(old.threadId, old.threadChatId);
    expect(oldRow.errorMessage).toBe("queue-retired");
    expect(oldRow.errorMessageInfo).toBe("queued-age 90m > 60m");
    const freshRow = await chatRow(fresh.threadId, fresh.threadChatId);
    expect(freshRow.status).toBe("booting");
    expect(freshRow.archived).toBe(false);
  });

  // Card: protects=queued_at is cleared when the agent starts and a later
  // follow-up queue starts a new period (criterion 5d); fails_when=a booted
  // chat keeps its old queued_at, so its next follow-up is retired at once;
  // no_claim=the follow-up queue processor.
  it("#446 c5d: queued_at clears at booting, and a later follow-up queue stamps a fresh one", async () => {
    const { threadId, threadChatId } = await queuedChat({
      queuedAt: ago(50 * MIN),
    });
    await maybeStartQueuedThreadChat({ userId: user.id });
    let row = await chatRow(threadId, threadChatId);
    expect(row.status).toBe("booting");
    expect(row.queuedAt).toBeNull();

    // The run ends; a follow-up arrives (complete → queued) and hits the cap.
    await db
      .update(threadChatTable)
      .set({ status: "complete" })
      .where(eq(threadChatTable.id, threadChatId));
    await updateThreadChatWithTransition({
      userId: user.id,
      threadId,
      threadChatId,
      eventType: "user.message",
    });
    expect((await chatRow(threadId, threadChatId)).queuedAt).toBeNull();
    const before = Date.now();
    await updateThreadChatWithTransition({
      userId: user.id,
      threadId,
      threadChatId,
      eventType: "system.concurrency-limit",
    });
    row = await chatRow(threadId, threadChatId);
    expect(row.status).toBe("queued-tasks-concurrency");
    expect(row.queuedAt).not.toBeNull();
    // A fresh period: stamped now (DB clock, skew allowed), not 50 min ago.
    expect(row.queuedAt!.getTime()).toBeGreaterThan(before - 5 * MIN);
  });

  // Card: protects=a re-queue after a failed start keeps its FIRST queued_at
  // (criterion 6); fails_when=bouncing off the cap extends a run's life;
  // no_claim=why the start failed.
  it("#446 c6: a re-queued chat keeps its first queued_at", async () => {
    const first = ago(40 * MIN);
    const { threadId, threadChatId } = await queuedChat({ queuedAt: first });
    // The dequeue (queued-tasks-concurrency → queued) keeps it...
    const eligible = await getEligibleQueuedThreadChats({
      db,
      userId: user.id,
      concurrencyLimitReached: false,
      sandboxCreationRateLimitReached: false,
    });
    const dequeued = await atomicDequeueThreadChats({
      db,
      userId: user.id,
      eligibleThreadChats: eligible,
    });
    expect(dequeued?.queuedAt?.getTime()).toBe(first.getTime());
    expect((await chatRow(threadId, threadChatId)).queuedAt?.getTime()).toBe(
      first.getTime(),
    );
    // ...and the start hits the cap again: re-queued, same instant.
    await updateThreadChatWithTransition({
      userId: user.id,
      threadId,
      threadChatId,
      eventType: "system.concurrency-limit",
    });
    const row = await chatRow(threadId, threadChatId);
    expect(row.status).toBe("queued-tasks-concurrency");
    expect(row.queuedAt?.getTime()).toBe(first.getTime());
  });

  // Card: protects=a queued self-heal run (no PR/issue number) is promoted as
  // before, and the Drain's terminal writer still closes it once started
  // (criterion 8); fails_when=the new rules consult GitHub for it, retire it,
  // or leave queue bookkeeping on the started run; no_claim=the Drain's
  // Hatchet cancel and fix-dispatch reconcile (their own tests).
  it("#446 c8: a queued self-heal run is promoted unchanged and the Drain still closes it", async () => {
    const { threadId, threadChatId } = await queuedChat({
      queuedAt: ago(30 * MIN),
    });
    await maybeStartQueuedThreadChat({ userId: user.id });
    let row = await chatRow(threadId, threadChatId);
    expect(row.status).toBe("booting");
    expect(row.archived).toBe(false);
    expect(row.queuedAt).toBeNull();
    expect(getOctokitForApp).not.toHaveBeenCalled();

    // KILL-01 Drain closes a live run through the shared terminal writer.
    expect(
      await markThreadTerminal({ db, threadId, cause: "user-cancelled" }),
    ).toBe(true);
    row = await chatRow(threadId, threadChatId);
    expect(row.status).toBe("complete");
    expect(row.errorMessage).toBeNull();
  });

  // Card: protects=scope — the sandbox rate-limit queue keeps today's rules
  // (any closed source is stale); fails_when=the #446 rules leak into the
  // rate-limit queues; no_claim=whether today's rate-limit rules are right.
  it("#446 scope: a run in the sandbox rate-limit queue keeps today's closed rule", async () => {
    gh.sources.set(801, {
      state: "closed",
      closed_at: ago(30 * MIN).toISOString(),
    });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubPRNumber: 801 },
      enableThreadChatCreation: true,
    });
    await updateThreadChatWithTransition({
      userId: user.id,
      threadId,
      threadChatId,
      eventType: "system.sandbox-creation-rate-limit",
    });
    await maybeStartQueuedThreadChat({ userId: user.id });

    const row = await chatRow(threadId, threadChatId);
    expect(row.archived).toBe(true);
    expect(row.errorMessageInfo).toBe("source #801 is closed");
  });

  // ---- #446 on legacy thread rows (production's shape) -------------------
  //
  // Production runs with enableThreadChatCreation off: a thread has NO
  // thread_chat row and its chat status lives on the thread row. These mirror
  // c1/c4/c5d/c6/c8 against that shape, with queued_at stamped by the real
  // concurrency-limit transition on `thread.queued_at`.

  /** A legacy thread queued on the concurrency cap through the REAL transition. */
  async function legacyQueuedViaTransition(
    opts: {
      overrides?: Partial<ThreadInsert>;
      queuedAt?: Date;
      updatedAt?: Date;
    } = {},
  ) {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: opts.overrides,
    });
    expect(threadChatId).toBe(LEGACY_THREAD_CHAT_ID);
    await updateThreadChatWithTransition({
      userId: user.id,
      threadId,
      threadChatId,
      eventType: "system.concurrency-limit",
    });
    if (opts.queuedAt || opts.updatedAt) {
      await db
        .update(threadTable)
        .set({
          ...(opts.queuedAt ? { queuedAt: opts.queuedAt } : {}),
          ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
        })
        .where(eq(threadTable.id, threadId));
    }
    return { threadId, threadChatId };
  }

  // Card: protects=the prod incident shape — a merge audit on a legacy row,
  // its PR merged before it was queued, runs when a slot frees (criterion 1);
  // fails_when=the legacy row has no queue-entry instant, so the closed rule
  // falls back to a write-reset updated_at or retires it; no_claim=the
  // audit's own finish effect.
  it("#446 legacy c1: a merge audit on a legacy row is stamped on thread.queued_at and promoted", async () => {
    gh.sources.set(901, {
      state: "closed",
      closed_at: ago(30 * MIN).toISOString(),
    });
    const before = Date.now();
    const { threadId } = await legacyQueuedViaTransition({
      overrides: { githubPRNumber: 901 },
    });
    const queued = await legacyRow(threadId);
    expect(queued.status).toBe("queued-tasks-concurrency");
    expect(queued.queuedAt).not.toBeNull();
    expect(queued.queuedAt!.getTime()).toBeGreaterThan(before - 5 * MIN);

    await maybeStartQueuedThreadChat({ userId: user.id });
    const row = await legacyRow(threadId);
    expect(row.status).toBe("booting");
    expect(row.archived).toBe(false);
    expect(row.errorMessage).toBeNull();
    expect(row.queuedAt).toBeNull();
  });

  // Card: protects=a legacy row ages from thread.queued_at, not from
  // updated_at, which any write to the thread row resets (criterion 4 on
  // the prod shape); fails_when=a row queued 65 min ago whose thread row was
  // touched a minute ago is run instead of retired, or is retired silently;
  // no_claim=the 1h threshold value itself.
  it("#446 legacy c4: a legacy row queued > 1h ago is retired even though its updated_at is fresh", async () => {
    const { threadId } = await legacyQueuedViaTransition({
      queuedAt: ago(65 * MIN),
      updatedAt: ago(1 * MIN),
    });
    await maybeStartQueuedThreadChat({ userId: user.id });

    const row = await legacyRow(threadId);
    expect(row.status).toBe("complete");
    expect(row.archived).toBe(true);
    expect(row.errorMessage).toBe("queue-retired");
    expect(row.errorMessageInfo).toBe("queued-age 65m > 60m");
  });

  // Card: protects=thread.queued_at clears when a legacy row boots and a
  // later follow-up queue stamps a fresh period (criterion 5d on the prod
  // shape); fails_when=a booted legacy row keeps its old queued_at, so its
  // next follow-up is retired at once; no_claim=the follow-up processor.
  it("#446 legacy c5d: thread.queued_at clears at booting, and a later follow-up queue stamps a fresh one", async () => {
    const { threadId, threadChatId } = await legacyQueuedViaTransition({
      queuedAt: ago(50 * MIN),
    });
    await maybeStartQueuedThreadChat({ userId: user.id });
    let row = await legacyRow(threadId);
    expect(row.status).toBe("booting");
    expect(row.queuedAt).toBeNull();

    await db
      .update(threadTable)
      .set({ status: "complete" })
      .where(eq(threadTable.id, threadId));
    await updateThreadChatWithTransition({
      userId: user.id,
      threadId,
      threadChatId,
      eventType: "user.message",
    });
    expect((await legacyRow(threadId)).queuedAt).toBeNull();
    const before = Date.now();
    await updateThreadChatWithTransition({
      userId: user.id,
      threadId,
      threadChatId,
      eventType: "system.concurrency-limit",
    });
    row = await legacyRow(threadId);
    expect(row.status).toBe("queued-tasks-concurrency");
    expect(row.queuedAt).not.toBeNull();
    expect(row.queuedAt!.getTime()).toBeGreaterThan(before - 5 * MIN);
  });

  // Card: protects=a re-queued legacy row keeps its FIRST thread.queued_at
  // (criterion 6 on the prod shape); fails_when=bouncing off the cap extends
  // a legacy run's life; no_claim=why the start failed.
  it("#446 legacy c6: a re-queued legacy row keeps its first queued_at", async () => {
    const first = ago(40 * MIN);
    const { threadId, threadChatId } = await legacyQueuedViaTransition({
      queuedAt: first,
    });
    const eligible = await getEligibleQueuedThreadChats({
      db,
      userId: user.id,
      concurrencyLimitReached: false,
      sandboxCreationRateLimitReached: false,
    });
    const dequeued = await atomicDequeueThreadChats({
      db,
      userId: user.id,
      eligibleThreadChats: eligible,
    });
    expect(dequeued?.threadChatId).toBe(LEGACY_THREAD_CHAT_ID);
    expect(dequeued?.queuedAt?.getTime()).toBe(first.getTime());
    expect((await legacyRow(threadId)).queuedAt?.getTime()).toBe(
      first.getTime(),
    );
    await updateThreadChatWithTransition({
      userId: user.id,
      threadId,
      threadChatId,
      eventType: "system.concurrency-limit",
    });
    const row = await legacyRow(threadId);
    expect(row.status).toBe("queued-tasks-concurrency");
    expect(row.queuedAt?.getTime()).toBe(first.getTime());
  });

  // Card: protects=a queued self-heal run on a legacy row is promoted
  // unchanged and the Drain's terminal writer still closes it (criterion 8 on
  // the prod shape); fails_when=the new rules consult GitHub for it, retire
  // it, or leave queue bookkeeping on the started run; no_claim=the Drain's
  // Hatchet cancel and fix-dispatch reconcile (their own tests).
  it("#446 legacy c8: a queued self-heal run on a legacy row is promoted unchanged and the Drain still closes it", async () => {
    const { threadId } = await legacyQueuedViaTransition({
      queuedAt: ago(30 * MIN),
    });
    await maybeStartQueuedThreadChat({ userId: user.id });
    let row = await legacyRow(threadId);
    expect(row.status).toBe("booting");
    expect(row.archived).toBe(false);
    expect(row.queuedAt).toBeNull();
    expect(getOctokitForApp).not.toHaveBeenCalled();

    expect(
      await markThreadTerminal({ db, threadId, cause: "user-cancelled" }),
    ).toBe(true);
    row = await legacyRow(threadId);
    expect(row.status).toBe("complete");
    expect(row.errorMessage).toBeNull();
  });
});

describe("isStaleQueuedThread — closed_at vs queued_at (#446)", () => {
  const queuedAt = new Date("2026-10-21T12:00:00.000Z");
  const now = queuedAt.getTime() + 5 * MIN;
  const base = {
    createdAt: new Date("2026-10-21T08:00:00.000Z"),
    queuedAt,
    githubRepoFullName: "o/r",
    githubPRNumber: 9,
    githubIssueNumber: null,
  };

  beforeEach(() => {
    installFakeAppOctokit();
  });

  // Card: protects=the boundary is strict; fails_when=a source closed at the
  // queue instant counts as closed-while-waiting; no_claim=clock skew.
  it("closed_at EQUAL to queued_at is not stale", async () => {
    gh.sources.set(9, { state: "closed", closed_at: queuedAt.toISOString() });
    expect(await isStaleQueuedThread(base, now)).toEqual({
      stale: false,
      kind: null,
      reason: "",
    });
  });

  // Card: protects=already-closed sources run; fails_when=closed_at before
  // queued_at retires; no_claim=the age rule.
  it("closed_at BEFORE queued_at is not stale", async () => {
    gh.sources.set(9, {
      state: "closed",
      closed_at: new Date(queuedAt.getTime() - 1000).toISOString(),
    });
    expect((await isStaleQueuedThread(base, now)).stale).toBe(false);
  });

  // Card: protects=closed-while-waiting retires; fails_when=it runs;
  // no_claim=what the retirement writes.
  it("closed_at AFTER queued_at is stale (kind closed)", async () => {
    gh.sources.set(9, {
      state: "closed",
      closed_at: new Date(queuedAt.getTime() + 1000).toISOString(),
    });
    const verdict = await isStaleQueuedThread(base, now);
    expect(verdict.stale).toBe(true);
    expect(verdict.kind).toBe("closed");
  });

  // Card: protects=fail-open on missing data; fails_when=a closed source with
  // no closed_at retires; no_claim=GitHub ever omitting it.
  it("closed with closed_at missing fails open (not stale)", async () => {
    gh.sources.set(9, { state: "closed", closed_at: null });
    expect((await isStaleQueuedThread(base, now)).stale).toBe(false);
  });

  // Card: protects=fail-open on a GitHub error; fails_when=a lookup failure
  // retires the run; no_claim=retry behaviour.
  it("a GitHub error fails open (not stale)", async () => {
    gh.issuesGetError = new Error("HTTP 502");
    expect((await isStaleQueuedThread(base, now)).stale).toBe(false);
  });
});

describe("#471 stranded plain `queued` chats", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    installFakeAppOctokit();
    user = (await createTestUser({ db })).user;
  });

  /** A legacy thread left in plain `queued`, back-dated as given. */
  async function strandedLegacy(opts: {
    createdAt: Date;
    queuedAt: Date | null;
    updatedAt: Date;
    overrides?: Partial<ThreadInsert>;
  }) {
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: opts.overrides,
    });
    await db
      .update(threadTable)
      .set({
        status: "queued",
        createdAt: opts.createdAt,
        queuedAt: opts.queuedAt,
        updatedAt: opts.updatedAt,
      })
      .where(eq(threadTable.id, threadId));
    return threadId;
  }

  /** A chat-mode chat left in plain `queued`, back-dated as given. */
  async function strandedChat(opts: {
    createdAt: Date;
    queuedAt: Date | null;
    updatedAt: Date;
    overrides?: Partial<ThreadInsert>;
  }) {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: opts.overrides,
      enableThreadChatCreation: true,
    });
    await db
      .update(threadChatTable)
      .set({
        status: "queued",
        createdAt: opts.createdAt,
        queuedAt: opts.queuedAt,
        updatedAt: opts.updatedAt,
      })
      .where(eq(threadChatTable.id, threadChatId));
    return { threadId, threadChatId };
  }

  // Card: protects=a dispatch that dies before its first transition ends the
  // chat (root fix, the prod shape: dequeued to plain `queued`, then the
  // credential read failed); fails_when=the chat is left in `queued`;
  // no_claim=the sweep.
  it("a dequeued chat whose dispatch throws before boot is ended, not left in queued", async () => {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      enableThreadChatCreation: true,
    });
    await updateThreadChatWithTransition({
      userId: user.id,
      threadId,
      threadChatId,
      eventType: "system.concurrency-limit",
    });
    const spy = vi
      .spyOn(db.query.agentProviderCredentials, "findMany")
      .mockRejectedValue(new Error("auth store unavailable"));
    try {
      await expect(
        maybeStartQueuedThreadChat({ userId: user.id }),
      ).rejects.toThrow("auth store unavailable");
    } finally {
      spy.mockRestore();
    }

    const row = await chatRow(threadId, threadChatId);
    expect(row.status).toBe("complete");
    expect(row.errorMessage).toBe("unknown-error");
    expect(row.errorMessageInfo).toBe("auth store unavailable");
  });

  // Card: protects=a legacy row stranded in `queued` (queued_at set, no run)
  // is retired visibly by the sweep; fails_when=it stays queued or is
  // retired silently; no_claim=the notice (review cases below).
  it("retires a legacy row stranded in queued > 30m (by queued_at)", async () => {
    const threadId = await strandedLegacy({
      createdAt: ago(50 * MIN),
      queuedAt: ago(45 * MIN),
      updatedAt: ago(45 * MIN),
    });
    const result = await retireStrandedQueuedThreads();
    expect(result.retired).toBeGreaterThanOrEqual(1);

    const row = await legacyRow(threadId);
    expect(row.status).toBe("complete");
    expect(row.errorMessage).toBe("queue-retired");
    expect(row.errorMessageInfo).toContain("stranded in queued");
    expect(row.archived).toBe(true);
  });

  // Card: protects=a chat-mode row is read from thread_chat, not from its
  // thread row's creation-value status; fails_when=the chat stays queued.
  it("retires a chat-mode chat stranded in queued > 30m (by created_at)", async () => {
    const { threadId, threadChatId } = await strandedChat({
      createdAt: ago(40 * MIN),
      queuedAt: null,
      updatedAt: ago(40 * MIN),
    });
    await retireStrandedQueuedThreads();

    const row = await chatRow(threadId, threadChatId);
    expect(row.status).toBe("complete");
    expect(row.errorMessage).toBe("queue-retired");
    expect(row.archived).toBe(true);
  });

  // Card: protects=a dispatch in progress is never retired; fails_when=a
  // fresh row, or a follow-up just queued on an old thread, is retired.
  it("leaves a fresh row and a just-queued follow-up on an old thread alone", async () => {
    const fresh = await strandedLegacy({
      createdAt: ago(1 * MIN),
      queuedAt: null,
      updatedAt: ago(1 * MIN),
    });
    const followUp = await strandedLegacy({
      createdAt: ago(3 * 24 * 60 * MIN),
      queuedAt: null,
      updatedAt: ago(10 * 1000),
    });
    const recentQueue = await strandedChat({
      createdAt: ago(2 * 60 * MIN),
      queuedAt: ago(5 * MIN),
      updatedAt: ago(5 * MIN),
    });
    await retireStrandedQueuedThreads();

    expect((await legacyRow(fresh)).status).toBe("queued");
    expect((await legacyRow(followUp)).status).toBe("queued");
    const chat = await chatRow(recentQueue.threadId, recentQueue.threadChatId);
    expect(chat.status).toBe("queued");
    expect(chat.archived).toBe(false);
  });

  // Card: protects=the sweep never touches a thread an engine run may own;
  // fails_when=a thread with an in_flight run row is retired.
  it("leaves a thread with an in_flight engine run alone", async () => {
    const { organization } = await createTestOrganization({
      db,
      userId: user.id,
    });
    const threadId = await strandedLegacy({
      createdAt: ago(50 * MIN),
      queuedAt: ago(45 * MIN),
      updatedAt: ago(45 * MIN),
      overrides: { organizationId: organization.id },
    });
    await recordHatchetRun({
      db,
      threadId,
      organizationId: organization.id,
      repoFullName: "terragon/test-repo",
      prNumber: 7,
      externalId: `run-${threadId}`,
    });
    await retireStrandedQueuedThreads();

    expect((await legacyRow(threadId)).status).toBe("queued");
  });

  /** A review thread at `SHA` on PR `prNumber`, stranded 45m ago. */
  async function strandedReview(prNumber: number) {
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: { triggerType: "pull_request" },
    });
    return await strandedChat({
      createdAt: ago(45 * MIN),
      queuedAt: ago(45 * MIN),
      updatedAt: ago(45 * MIN),
      overrides: {
        githubPRNumber: prNumber,
        reviewedSha: SHA,
        automationId: automation.id,
      },
    });
  }

  // Card: protects=a stranded review on an open PR gets the ADR-009 notice
  // at its head, with the stranded wording; fails_when=no notice, or the
  // queue-age wording.
  it("a stranded review on an open PR is retired with one notice at its head", async () => {
    gh.headSha = SHA;
    const { threadId, threadChatId } = await strandedReview(711);
    await retireStrandedQueuedThreads();

    const row = await chatRow(threadId, threadChatId);
    expect(row.status).toBe("complete");
    expect(row.errorMessage).toBe("queue-retired");
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain(
      `<!-- automata:review-notice sha=${SHA} -->`,
    );
    expect(gh.comments[0]!.body).toContain("this review never started");
  });

  // Card: protects=no "push to re-run" notice on a PR that already closed
  // (the prod rows' PRs had merged); fails_when=a notice lands there.
  it("a stranded review on a closed PR is retired without a notice", async () => {
    gh.headSha = SHA;
    gh.sources.set(712, {
      state: "closed",
      closed_at: ago(10 * MIN).toISOString(),
    });
    const { threadId, threadChatId } = await strandedReview(712);
    await retireStrandedQueuedThreads();

    const row = await chatRow(threadId, threadChatId);
    expect(row.status).toBe("complete");
    expect(row.errorMessage).toBe("queue-retired");
    expect(gh.comments).toHaveLength(0);
  });
});
