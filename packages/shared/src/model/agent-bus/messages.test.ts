import { eq, inArray, or } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../../db";
import {
  agentApplied,
  agentMessages,
  thread,
  threadChat,
} from "../../db/schema";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "../test-helpers";
import { createChildRun, ensureRootRun, markBlocked } from "./agent-run";
import {
  insertMessage,
  queuedFollowUpApply,
  receiveFor,
  recentlyDeliveredTargets,
  sendMessage,
  sweepUnconsumed,
  type AgentMessage,
  type ApplyMessage,
} from "./messages";

const db = createDb(env.DATABASE_URL!);

async function orgThread(
  organizationId: string,
  overrides: { parentThreadId?: string } = {},
) {
  const { user } = await createTestUser({ db });
  const { threadId } = await createTestThread({
    db,
    userId: user.id,
    overrides: { organizationId, ...overrides },
  });
  return threadId;
}

/** A root (task), a review child and a task child, all in one tree. */
async function tree() {
  const organizationId = await createTestOrg({ db });
  const rootId = await orgThread(organizationId);
  const root = await ensureRootRun({
    db,
    threadId: rootId,
    organizationId,
    lane: "task",
  });
  if (!root) throw new Error("root not created");
  const reviewId = await orgThread(organizationId, { parentThreadId: rootId });
  const review = await createChildRun({
    db,
    organizationId,
    parentThreadId: rootId,
    childThreadId: reviewId,
    request: { lane: "review" },
  });
  const taskId = await orgThread(organizationId, { parentThreadId: rootId });
  const task = await createChildRun({
    db,
    organizationId,
    parentThreadId: rootId,
    childThreadId: taskId,
    request: { lane: "task" },
  });
  if (!review.ok || !task.ok) throw new Error("children not created");
  return { organizationId, rootId, reviewId, taskId };
}

function recorder() {
  const seen: AgentMessage[] = [];
  const apply: ApplyMessage = async (_tx, message) => {
    seen.push(message);
  };
  return { seen, apply };
}

async function counts(runIds: string[]) {
  const messages = await db
    .select({ id: agentMessages.id })
    .from(agentMessages)
    .where(
      or(
        inArray(agentMessages.fromRun, runIds),
        inArray(agentMessages.toRun, runIds),
      ),
    );
  const applied = await db
    .select({ id: agentApplied.msgId })
    .from(agentApplied)
    .where(inArray(agentApplied.run, runIds));
  return { messages: messages.length, applied: applied.length };
}

async function seed(from: string, to: string, n: number) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await insertMessage({
      db,
      from,
      to,
      key: `k${i}`,
      body: `body ${i}`,
    });
    if ("conflict" in res) throw new Error("unexpected conflict");
    ids.push(res.id);
  }
  return ids;
}

describe("sendMessage", () => {
  it("stores, delivers and reports one applied message", async () => {
    const { organizationId, rootId, taskId } = await tree();
    const { seen, apply } = recorder();
    const res = await sendMessage({
      db,
      organizationId,
      from: rootId,
      to: taskId,
      key: "a",
      body: "hello",
      apply,
    });
    expect(res).toMatchObject({ ok: true, duplicate: false, applied: 1 });
    expect(seen.map((m) => m.body)).toEqual(["hello"]);
    expect(seen[0]).toMatchObject({ fromRun: rootId, toRun: taskId });
    expect(await counts([rootId, taskId])).toEqual({
      messages: 1,
      applied: 1,
    });
  });

  it("a duplicate key returns the same id with duplicate: true and applies nothing more", async () => {
    const { organizationId, rootId, taskId } = await tree();
    const { seen, apply } = recorder();
    const args = {
      db,
      organizationId,
      from: rootId,
      to: taskId,
      key: "dup",
      body: "once",
      apply,
    };
    const first = await sendMessage(args);
    const second = await sendMessage(args);
    if (!first.ok || !second.ok) throw new Error("expected both ok");
    expect(second.id).toBe(first.id);
    expect(second.duplicate).toBe(true);
    expect(second.applied).toBe(0);
    expect(seen).toHaveLength(1);
    expect(await counts([rootId, taskId])).toEqual({
      messages: 1,
      applied: 1,
    });
  });

  it("the same key with a different body or target is idem_key_conflict", async () => {
    const { organizationId, rootId, taskId, reviewId } = await tree();
    const { apply } = recorder();
    const base = {
      db,
      organizationId,
      from: rootId,
      key: "conflict",
      apply,
    };
    const first = await sendMessage({ ...base, to: taskId, body: "one" });
    expect(first.ok).toBe(true);
    expect(await sendMessage({ ...base, to: taskId, body: "two" })).toEqual({
      ok: false,
      error: "idem_key_conflict",
    });
    expect(await sendMessage({ ...base, to: reviewId, body: "one" })).toEqual({
      ok: false,
      error: "idem_key_conflict",
    });
    expect((await counts([rootId, taskId, reviewId])).messages).toBe(1);
  });

  describe("every refusal writes no agent_messages / agent_applied row", () => {
    async function expectRefused(
      run: (t: Awaited<ReturnType<typeof tree>>) => Promise<void> | void,
      send: (t: Awaited<ReturnType<typeof tree>>) => {
        from: string;
        to: string;
      },
      error: string,
    ) {
      const t = await tree();
      await run(t);
      const apply = vi.fn<ApplyMessage>(async () => {});
      const { from, to } = send(t);
      const res = await sendMessage({
        db,
        organizationId: t.organizationId,
        from,
        to,
        key: "refused",
        body: "nope",
        apply,
      });
      expect(res).toEqual({ ok: false, error });
      expect(apply).not.toHaveBeenCalled();
      expect(await counts([t.rootId, t.reviewId, t.taskId])).toEqual({
        messages: 0,
        applied: 0,
      });
    }

    it("not_found for an unknown sender", async () => {
      await expectRefused(
        () => {},
        (t) => ({ from: "no-such-run", to: t.taskId }),
        "not_found",
      );
    });

    it("not_found for an unknown target", async () => {
      await expectRefused(
        () => {},
        (t) => ({ from: t.rootId, to: "no-such-run" }),
        "not_found",
      );
    });

    it("not_found for a target in another organization", async () => {
      const other = await tree();
      const t = await tree();
      const apply = vi.fn<ApplyMessage>(async () => {});
      const res = await sendMessage({
        db,
        organizationId: t.organizationId,
        from: t.rootId,
        to: other.taskId,
        key: "x",
        body: "x",
        apply,
      });
      expect(res).toEqual({ ok: false, error: "not_found" });
      expect(apply).not.toHaveBeenCalled();
      expect(await counts([t.rootId, other.taskId])).toEqual({
        messages: 0,
        applied: 0,
      });
    });

    it("lane_pair_not_allowed for a review run messaging a task sibling", async () => {
      await expectRefused(
        () => {},
        (t) => ({ from: t.reviewId, to: t.taskId }),
        "lane_pair_not_allowed:review->task",
      );
    });

    it("sender_not_running for a terminal sender", async () => {
      await expectRefused(
        async (t) => {
          await db
            .update(thread)
            .set({ status: "complete" })
            .where(eq(thread.id, t.rootId));
        },
        (t) => ({ from: t.rootId, to: t.taskId }),
        "sender_not_running",
      );
    });

    it("target_not_running for a terminal target", async () => {
      await expectRefused(
        async (t) => {
          await db
            .update(thread)
            .set({ status: "complete" })
            .where(eq(thread.id, t.taskId));
        },
        (t) => ({ from: t.rootId, to: t.taskId }),
        "target_not_running",
      );
    });

    it("agent_blocked for a blocked target", async () => {
      await expectRefused(
        async (t) => {
          await markBlocked({
            db,
            organizationId: t.organizationId,
            threadId: t.taskId,
            reason: "test",
          });
        },
        (t) => ({ from: t.rootId, to: t.taskId }),
        "agent_blocked",
      );
    });

    it("agent_blocked for a blocked sender", async () => {
      await expectRefused(
        async (t) => {
          await markBlocked({
            db,
            organizationId: t.organizationId,
            threadId: t.rootId,
            reason: "test",
          });
        },
        (t) => ({ from: t.rootId, to: t.taskId }),
        "agent_blocked",
      );
    });
  });
});

describe("receiveFor", () => {
  it("applies each message once, oldest first, and marks it consumed", async () => {
    const { rootId, taskId } = await tree();
    await seed(rootId, taskId, 3);
    const { seen, apply } = recorder();
    expect(await receiveFor({ db, toRun: taskId, apply })).toEqual({
      applied: 3,
    });
    expect(seen.map((m) => m.body)).toEqual(["body 0", "body 1", "body 2"]);
    expect(await receiveFor({ db, toRun: taskId, apply })).toEqual({
      applied: 0,
    });
    const rows = await db
      .select({ consumedAt: agentMessages.consumedAt })
      .from(agentMessages)
      .where(eq(agentMessages.toRun, taskId));
    expect(rows.every((r) => r.consumedAt !== null)).toBe(true);
  });

  it("two concurrent receives apply 3 messages exactly 3 times in total", async () => {
    const { rootId, taskId } = await tree();
    await seed(rootId, taskId, 3);
    const seen: number[] = [];
    const apply: ApplyMessage = async (_tx, message) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      seen.push(message.id);
    };
    const results = await Promise.all([
      receiveFor({ db, toRun: taskId, apply }),
      receiveFor({ db, toRun: taskId, apply }),
    ]);
    expect(results[0].applied + results[1].applied).toBe(3);
    expect(new Set(seen).size).toBe(3);
    expect(seen).toHaveLength(3);
    expect((await counts([taskId])).applied).toBe(3);
  });

  it("an apply that throws rolls back (message stays unconsumed, no agent_applied row) and rethrows", async () => {
    const { rootId, taskId } = await tree();
    const [id] = await seed(rootId, taskId, 1);
    const boom = new Error("apply failed");
    await expect(
      receiveFor({
        db,
        toRun: taskId,
        apply: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    const [row] = await db
      .select({ consumedAt: agentMessages.consumedAt })
      .from(agentMessages)
      .where(eq(agentMessages.id, id as number));
    expect(row?.consumedAt).toBeNull();
    expect((await counts([taskId])).applied).toBe(0);
    // The next receive retries it.
    const { seen, apply } = recorder();
    expect(await receiveFor({ db, toRun: taskId, apply })).toEqual({
      applied: 1,
    });
    expect(seen.map((m) => m.id)).toEqual([id]);
  });

  it("an already-applied but unconsumed message is consumed without a second apply", async () => {
    const { rootId, taskId } = await tree();
    const [id] = await seed(rootId, taskId, 1);
    await db.insert(agentApplied).values({ msgId: id as number, run: taskId });
    const { seen, apply } = recorder();
    expect(await receiveFor({ db, toRun: taskId, apply })).toEqual({
      applied: 0,
    });
    expect(seen).toHaveLength(0);
    const [row] = await db
      .select({ consumedAt: agentMessages.consumedAt })
      .from(agentMessages)
      .where(eq(agentMessages.id, id as number));
    expect(row?.consumedAt).not.toBeNull();
  });

  it("unsafeApplyOutsideTransaction passes the plain db, not the transaction", async () => {
    const { rootId, taskId } = await tree();
    await seed(rootId, taskId, 1);
    const targets: unknown[] = [];
    await receiveFor({
      db,
      toRun: taskId,
      unsafeApplyOutsideTransaction: true,
      apply: async (executor) => {
        targets.push(executor);
      },
    });
    expect(targets).toEqual([db]);
  });
});

describe("recentlyDeliveredTargets", () => {
  it("lists a target consumed inside the window and not one outside it", async () => {
    const { rootId, taskId } = await tree();
    const [id] = await seed(rootId, taskId, 1);
    const { apply } = recorder();
    await receiveFor({ db, toRun: taskId, apply });
    expect(await recentlyDeliveredTargets({ db })).toContain(taskId);

    await db
      .update(agentMessages)
      .set({ consumedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(agentMessages.id, id as number));
    expect(await recentlyDeliveredTargets({ db })).not.toContain(taskId);
    expect(
      await recentlyDeliveredTargets({ db, withinMs: 60 * 60_000 }),
    ).toContain(taskId);
  });
});

describe("sweepUnconsumed", () => {
  it("delivers a message older than 10s and leaves a fresh one alone", async () => {
    const t = await tree();
    const [oldId] = await seed(t.rootId, t.taskId, 1);
    const fresh = await insertMessage({
      db,
      from: t.rootId,
      to: t.reviewId,
      key: "fresh",
      body: "fresh",
    });
    if ("conflict" in fresh) throw new Error("unexpected conflict");
    await db
      .update(agentMessages)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(agentMessages.id, oldId as number));

    const { seen, apply } = recorder();
    const result = await sweepUnconsumed({ db, apply });
    expect(result.targets).toContain(t.taskId);
    expect(result.targets).not.toContain(t.reviewId);
    expect(seen.map((m) => m.id)).toContain(oldId);
    expect(seen.map((m) => m.id)).not.toContain(fresh.id);

    const [freshRow] = await db
      .select({ consumedAt: agentMessages.consumedAt })
      .from(agentMessages)
      .where(eq(agentMessages.id, fresh.id));
    expect(freshRow?.consumedAt).toBeNull();
  });

  it("logs one target's failure and still delivers the others", async () => {
    const t = await tree();
    const [badId] = await seed(t.rootId, t.taskId, 1);
    const good = await insertMessage({
      db,
      from: t.rootId,
      to: t.reviewId,
      key: "good",
      body: "good",
    });
    if ("conflict" in good) throw new Error("unexpected conflict");
    await db
      .update(agentMessages)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(inArray(agentMessages.id, [badId as number, good.id]));

    const logger = { error: vi.fn() };
    const applied: number[] = [];
    const result = await sweepUnconsumed({
      db,
      logger,
      apply: async (_tx, message) => {
        if (message.toRun === t.taskId) throw new Error("poison");
        applied.push(message.id);
      },
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(result.targets).toContain(t.reviewId);
    expect(result.targets).not.toContain(t.taskId);
    expect(applied).toContain(good.id);
    // Clean up the poison row so it cannot leak into other sweeps.
    await db.delete(agentMessages).where(eq(agentMessages.id, badId as number));
  });

  it("respects the limit on distinct targets", async () => {
    const t = await tree();
    const [a] = await seed(t.rootId, t.taskId, 1);
    const b = await insertMessage({
      db,
      from: t.rootId,
      to: t.reviewId,
      key: "limit",
      body: "limit",
    });
    if ("conflict" in b) throw new Error("unexpected conflict");
    await db
      .update(agentMessages)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(inArray(agentMessages.id, [a as number, b.id]));
    const { apply } = recorder();
    const result = await sweepUnconsumed({ db, apply, limit: 1 });
    expect(result.targets).toHaveLength(1);
    // Drain whatever is left.
    await sweepUnconsumed({ db, apply });
  });
});

describe("queuedFollowUpApply", () => {
  it("appends the D2-framed message to the primary (oldest) thread chat", async () => {
    const t = await tree();
    const [owner] = await db
      .select({ userId: thread.userId })
      .from(thread)
      .where(eq(thread.id, t.taskId));
    if (!owner) throw new Error("task thread missing");
    // The test thread is legacy (no chat rows): give it a primary and a newer chat.
    const chatBase = {
      userId: owner.userId,
      threadId: t.taskId,
      organizationId: t.organizationId,
      agent: "claudeCode" as const,
    };
    const [primary] = await db
      .insert(threadChat)
      .values({ ...chatBase, createdAt: new Date(Date.now() - 60_000) })
      .returning({ id: threadChat.id });
    const [newer] = await db
      .insert(threadChat)
      .values({ ...chatBase, createdAt: new Date() })
      .returning({ id: threadChat.id });
    if (!primary || !newer) throw new Error("chats not created");
    const primaryChatId = primary.id;

    const res = await sendMessage({
      db,
      organizationId: t.organizationId,
      from: t.rootId,
      to: t.taskId,
      key: "q1",
      body: "/compact\u0001 please",
      apply: queuedFollowUpApply,
    });
    expect(res).toMatchObject({ ok: true, applied: 1 });
    await sendMessage({
      db,
      organizationId: t.organizationId,
      from: t.rootId,
      to: t.taskId,
      key: "q2",
      body: "second",
      apply: queuedFollowUpApply,
    });

    const [after] = await db
      .select({ queued: threadChat.queuedMessages })
      .from(threadChat)
      .where(eq(threadChat.id, primaryChatId));
    expect(after?.queued).toHaveLength(2);
    expect(after?.queued?.[0]).toMatchObject({
      type: "user",
      model: null,
      parts: [
        {
          type: "text",
          text: `Message from agent run ${t.rootId}:\n\n/compact please`,
        },
      ],
    });
    expect(typeof after?.queued?.[0]?.timestamp).toBe("string");
    const [other] = await db
      .select({ queued: threadChat.queuedMessages })
      .from(threadChat)
      .where(eq(threadChat.id, newer.id));
    expect(other?.queued ?? []).toHaveLength(0);
  });

  it("throws, and rolls the message back, when the thread has no chat", async () => {
    const t = await tree();
    await db.delete(threadChat).where(eq(threadChat.threadId, t.taskId));
    await expect(
      sendMessage({
        db,
        organizationId: t.organizationId,
        from: t.rootId,
        to: t.taskId,
        key: "nochat",
        body: "x",
        apply: queuedFollowUpApply,
      }),
    ).rejects.toThrow(/no thread chat/);
    const rows = await db
      .select({ consumedAt: agentMessages.consumedAt, id: agentMessages.id })
      .from(agentMessages)
      .where(eq(agentMessages.toRun, t.taskId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consumedAt).toBeNull();
    expect((await counts([t.taskId])).applied).toBe(0);
    await db.delete(agentMessages).where(eq(agentMessages.toRun, t.taskId));
  });
});
