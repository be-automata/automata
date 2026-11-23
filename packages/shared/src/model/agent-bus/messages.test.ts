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
  AGENT_MESSAGE_MAX_ATTEMPTS,
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

/** Moves `created_at` / `consumed_at` of the given messages `ms` into the past (negative: the future). */
async function backdateCreated(ids: number[], ms: number): Promise<void> {
  await db
    .update(agentMessages)
    .set({ createdAt: new Date(Date.now() - ms) })
    .where(inArray(agentMessages.id, ids));
}

async function backdateConsumed(ids: number[], ms: number): Promise<void> {
  await db
    .update(agentMessages)
    .set({ consumedAt: new Date(Date.now() - ms) })
    .where(inArray(agentMessages.id, ids));
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

  it("a delivery failure after the insert committed still resolves ok, logs once, leaves the row unconsumed", async () => {
    const { organizationId, rootId, taskId } = await tree();
    const apply: ApplyMessage = async (_tx, message) => {
      if (message.body === "M1") throw new Error("poison M1 secret-body");
    };
    const base = { db, organizationId, from: rootId, to: taskId, apply };
    const logger1 = { error: vi.fn() };
    const first = await sendMessage({
      ...base,
      key: "m1",
      body: "M1",
      logger: logger1,
    });
    expect(first).toMatchObject({ ok: true, duplicate: false, applied: 0 });

    // M1 stays unconsumed and is claimed first (id order): M2's receive throws too.
    const logger2 = { error: vi.fn() };
    const second = await sendMessage({
      ...base,
      key: "m2",
      body: "M2",
      logger: logger2,
    });
    expect(second).toMatchObject({ ok: true, duplicate: false, applied: 0 });
    expect(logger2.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger2.error.mock.calls)).not.toContain("M1");
    expect(JSON.stringify(logger2.error.mock.calls)).not.toContain("M2");
    const rows = await db
      .select({
        body: agentMessages.body,
        consumedAt: agentMessages.consumedAt,
      })
      .from(agentMessages)
      .where(eq(agentMessages.toRun, taskId));
    expect(rows.map((r) => r.body).sort()).toEqual(["M1", "M2"]);
    expect(rows.every((r) => r.consumedAt === null)).toBe(true);
  });

  it("reports the count applied before a later message fails", async () => {
    const { organizationId, rootId, taskId } = await tree();
    await seed(rootId, taskId, 1);
    const apply: ApplyMessage = async (_tx, message) => {
      if (message.body === "boom") throw new Error("late failure");
    };
    const logger = { error: vi.fn() };
    const res = await sendMessage({
      db,
      organizationId,
      from: rootId,
      to: taskId,
      key: "late",
      body: "boom",
      apply,
      logger,
    });
    expect(res).toMatchObject({ ok: true, applied: 1 });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  describe("body normalization", () => {
    it("a NUL byte is stripped, and the retry is a duplicate with the same id", async () => {
      const { rootId, taskId } = await tree();
      const args = {
        db,
        from: rootId,
        to: taskId,
        key: "nul",
        body: "a\u0000b",
      };
      const first = await insertMessage(args);
      if ("conflict" in first) throw new Error("unexpected conflict");
      const [row] = await db
        .select({ body: agentMessages.body })
        .from(agentMessages)
        .where(eq(agentMessages.id, first.id));
      expect(row?.body).toBe("ab");
      expect(await insertMessage(args)).toEqual({
        id: first.id,
        duplicate: true,
      });
    });

    it("an unpaired surrogate retried is a duplicate, not idem_key_conflict", async () => {
      const { rootId, taskId } = await tree();
      const args = {
        db,
        from: rootId,
        to: taskId,
        key: "surrogate",
        body: "a\uD800b",
      };
      const first = await insertMessage(args);
      if ("conflict" in first) throw new Error("unexpected conflict");
      expect(await insertMessage(args)).toEqual({
        id: first.id,
        duplicate: true,
      });
    });
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
      deadLettered: 0,
    });
    expect(seen.map((m) => m.body)).toEqual(["body 0", "body 1", "body 2"]);
    expect(await receiveFor({ db, toRun: taskId, apply })).toEqual({
      applied: 0,
      deadLettered: 0,
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

  it("concurrent receivers queue three messages in id order", async () => {
    const { rootId, taskId } = await tree();
    const ids = await seed(rootId, taskId, 3);
    const seen: number[] = [];
    const apply: ApplyMessage = async (_tx, message) => {
      if (message.id === ids[0]) {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      seen.push(message.id);
    };
    await Promise.all([
      receiveFor({ db, toRun: taskId, apply }),
      receiveFor({ db, toRun: taskId, apply }),
    ]);
    expect(seen).toEqual(ids);
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
      .select({
        consumedAt: agentMessages.consumedAt,
        attempts: agentMessages.attempts,
      })
      .from(agentMessages)
      .where(eq(agentMessages.id, id as number));
    expect(row?.consumedAt).toBeNull();
    expect(row?.attempts).toBe(1);
    expect((await counts([taskId])).applied).toBe(0);
    // The next receive retries it.
    const { seen, apply } = recorder();
    expect(await receiveFor({ db, toRun: taskId, apply })).toEqual({
      applied: 1,
      deadLettered: 0,
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
      deadLettered: 0,
    });
    expect(seen).toHaveLength(0);
    const [row] = await db
      .select({ consumedAt: agentMessages.consumedAt })
      .from(agentMessages)
      .where(eq(agentMessages.id, id as number));
    expect(row?.consumedAt).not.toBeNull();
  });
});

async function messageRow(id: number) {
  const [row] = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.id, id));
  if (!row) throw new Error(`message ${id} missing`);
  return row;
}

const failing: ApplyMessage = async () => {
  throw new Error("poison");
};

describe("dead-lettering (#758)", () => {
  it("AC2: one failure records the attempt, keeps the message deliverable and delivers it once later", async () => {
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
    const row = await messageRow(id as number);
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("Error: apply failed");
    expect(row.deadLetteredAt).toBeNull();
    expect(row.consumedAt).toBeNull();
    expect((await counts([taskId])).applied).toBe(0);

    const { seen, apply } = recorder();
    expect(await receiveFor({ db, toRun: taskId, apply })).toEqual({
      applied: 1,
      deadLettered: 0,
    });
    expect(seen.map((m) => m.id)).toEqual([id]);
    expect((await counts([taskId])).applied).toBe(1);
  });

  it("AC3: after the cap the message is dead-lettered and never applied again", async () => {
    const { rootId, taskId } = await tree();
    const [id] = await seed(rootId, taskId, 1);
    const logger = { error: vi.fn() };
    for (let i = 1; i < AGENT_MESSAGE_MAX_ATTEMPTS; i++) {
      await expect(
        receiveFor({ db, toRun: taskId, apply: failing, logger }),
      ).rejects.toThrow("poison");
      expect((await messageRow(id as number)).attempts).toBe(i);
    }
    expect(
      await receiveFor({ db, toRun: taskId, apply: failing, logger }),
    ).toEqual({ applied: 0, deadLettered: 1 });
    const row = await messageRow(id as number);
    expect(row.attempts).toBe(AGENT_MESSAGE_MAX_ATTEMPTS);
    expect(row.deadLetteredAt).not.toBeNull();
    expect(row.consumedAt).toBeNull();

    const { seen, apply } = recorder();
    expect(await receiveFor({ db, toRun: taskId, apply })).toEqual({
      applied: 0,
      deadLettered: 0,
    });
    await db
      .update(agentMessages)
      .set({ createdAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(agentMessages.id, id as number));
    const swept = await sweepUnconsumed({ db, apply });
    expect(swept.targets).not.toContain(taskId);
    expect(seen).toHaveLength(0);
    expect((await messageRow(id as number)).attempts).toBe(
      AGENT_MESSAGE_MAX_ATTEMPTS,
    );
  });

  it("AC4: the receive that dead-letters m1 goes on to apply m2, in FIFO order", async () => {
    const { rootId, taskId } = await tree();
    const [m1, m2] = await seed(rootId, taskId, 2);
    const applied: number[] = [];
    const apply: ApplyMessage = async (_tx, message) => {
      if (message.id === m1) throw new Error("poison");
      applied.push(message.id);
    };
    for (let i = 1; i < AGENT_MESSAGE_MAX_ATTEMPTS; i++) {
      await expect(receiveFor({ db, toRun: taskId, apply })).rejects.toThrow(
        "poison",
      );
      // m2 is never applied before m1 is dead-lettered.
      expect(applied).toEqual([]);
    }
    expect(await receiveFor({ db, toRun: taskId, apply })).toEqual({
      applied: 1,
      deadLettered: 1,
    });
    expect(applied).toEqual([m2]);
    expect((await messageRow(m1 as number)).deadLetteredAt).not.toBeNull();
    expect((await messageRow(m2 as number)).consumedAt).not.toBeNull();
  });

  it("AC5: dead-lettered poison targets leave the sweep, so a healthy target is delivered", async () => {
    const t = await tree();
    const poisonA = await seed(t.rootId, t.taskId, 1);
    const poisonB = await insertMessage({
      db,
      from: t.rootId,
      to: t.reviewId,
      key: "poison-b",
      body: "poison b",
    });
    if ("conflict" in poisonB) throw new Error("unexpected conflict");
    const healthyTarget = await orgThread(t.organizationId, {
      parentThreadId: t.rootId,
    });
    const healthy = await insertMessage({
      db,
      from: t.rootId,
      to: healthyTarget,
      key: "healthy",
      body: "healthy",
    });
    if ("conflict" in healthy) throw new Error("unexpected conflict");
    // Explicit order, minutes apart, so rows left by other tests cannot take the slots:
    // both poison targets are older than the healthy one and older than anything else.
    const base = 24 * 60 * 60_000;
    await backdateCreated(poisonA as number[], base + 3 * 60_000);
    await backdateCreated([poisonB.id], base + 2 * 60_000);
    await backdateCreated([healthy.id], base + 60_000);

    const { seen, apply } = recorder();
    const poisonIds = new Set<number>([...poisonA, poisonB.id]);
    const sweepApply: ApplyMessage = async (tx, message) => {
      if (poisonIds.has(message.id)) throw new Error("poison");
      await apply(tx, message);
    };
    const logger = { error: vi.fn() };
    let delivered = false;
    for (let pass = 1; pass <= AGENT_MESSAGE_MAX_ATTEMPTS + 1; pass++) {
      const result = await sweepUnconsumed({
        db,
        apply: sweepApply,
        logger,
        limit: 2,
      });
      if (result.targets.includes(healthyTarget)) {
        delivered = true;
        break;
      }
    }
    expect(delivered).toBe(true);
    expect(seen.map((m) => m.id)).toEqual([healthy.id]);
    for (const id of poisonIds) {
      const row = await messageRow(id);
      expect(row.deadLetteredAt).not.toBeNull();
      expect(row.attempts).toBe(AGENT_MESSAGE_MAX_ATTEMPTS);
    }
  });

  it("AC6: a target whose only unconsumed rows are dead-lettered is not swept", async () => {
    const { rootId, taskId } = await tree();
    const [id] = await seed(rootId, taskId, 1);
    await db
      .update(agentMessages)
      .set({
        createdAt: new Date(Date.now() - 60 * 60_000),
        deadLetteredAt: new Date(),
        attempts: AGENT_MESSAGE_MAX_ATTEMPTS,
      })
      .where(eq(agentMessages.id, id as number));
    const { seen, apply } = recorder();
    const result = await sweepUnconsumed({ db, apply, limit: 1000 });
    expect(result.targets).not.toContain(taskId);
    expect(seen.map((m) => m.id)).not.toContain(id);
  });

  it("AC8: exactly one dead-letter log, no body in any log argument, bounded last_error without the body", async () => {
    const { rootId, taskId } = await tree();
    const body = "SECRET-BODY-4711";
    const inserted = await insertMessage({
      db,
      from: rootId,
      to: taskId,
      key: "secret",
      body,
    });
    if ("conflict" in inserted) throw new Error("unexpected conflict");
    const echo: ApplyMessage = async (_tx, message) => {
      throw new Error(
        `rejected ${message.body}: ${message.body} ${"x".repeat(900)}`,
      );
    };
    const logger = { error: vi.fn() };
    for (let i = 1; i < AGENT_MESSAGE_MAX_ATTEMPTS; i++) {
      await expect(
        receiveFor({ db, toRun: taskId, apply: echo, logger }),
      ).rejects.toThrow();
    }
    expect(logger.error).not.toHaveBeenCalled();
    await receiveFor({ db, toRun: taskId, apply: echo, logger });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "agent-bus: message dead-lettered",
      {
        messageId: inserted.id,
        fromRun: rootId,
        toRun: taskId,
        attempts: AGENT_MESSAGE_MAX_ATTEMPTS,
        errorName: "Error",
      },
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(body);
    const row = await messageRow(inserted.id);
    expect(row.lastError).not.toContain(body);
    expect(row.lastError).toContain("[body]");
    expect(row.lastError?.length).toBeLessThanOrEqual(500);
  });

  it("a NUL byte in the error message never reaches last_error", async () => {
    const { rootId, taskId } = await tree();
    const [id] = await seed(rootId, taskId, 1);
    await expect(
      receiveFor({
        db,
        toRun: taskId,
        apply: async () => {
          throw new Error("bad\u0000byte");
        },
      }),
    ).rejects.toThrow();
    expect((await messageRow(id as number)).lastError).not.toContain("\u0000");
  });

  it("savepoint: the agent_applied row inserted before the throw is gone, the attempt committed", async () => {
    const { rootId, taskId } = await tree();
    const [id] = await seed(rootId, taskId, 1);
    let sawRowInsideApply = false;
    await expect(
      receiveFor({
        db,
        toRun: taskId,
        apply: async (tx, message) => {
          const inside = await tx
            .select({ id: agentApplied.msgId })
            .from(agentApplied)
            .where(eq(agentApplied.msgId, message.id));
          sawRowInsideApply = inside.length === 1;
          throw new Error("poison");
        },
      }),
    ).rejects.toThrow("poison");
    expect(sawRowInsideApply).toBe(true);
    expect((await counts([taskId])).applied).toBe(0);
    expect((await messageRow(id as number)).attempts).toBe(1);
  });

  it("the test seam fires once per failure with the right dead-letter flag", async () => {
    const { rootId, taskId } = await tree();
    await seed(rootId, taskId, 1);
    const seam = vi.fn();
    for (let i = 1; i < AGENT_MESSAGE_MAX_ATTEMPTS; i++) {
      await expect(
        receiveFor({
          db,
          toRun: taskId,
          apply: failing,
          logger: { error: vi.fn() },
          __testOnAttemptRecorded: seam,
        }),
      ).rejects.toThrow();
      expect(seam).toHaveBeenCalledTimes(i);
      expect(seam).toHaveBeenLastCalledWith(
        expect.objectContaining({ attempts: i, deadLettered: false }),
      );
    }
    await receiveFor({
      db,
      toRun: taskId,
      apply: failing,
      logger: { error: vi.fn() },
      __testOnAttemptRecorded: seam,
    });
    expect(seam).toHaveBeenCalledTimes(AGENT_MESSAGE_MAX_ATTEMPTS);
    expect(seam).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attempts: AGENT_MESSAGE_MAX_ATTEMPTS,
        deadLettered: true,
      }),
    );
  });
});

describe("recentlyDeliveredTargets", () => {
  it("lists a target consumed inside the window and not one outside it", async () => {
    const { rootId, taskId } = await tree();
    const [id] = await seed(rootId, taskId, 1);
    const { apply } = recorder();
    await receiveFor({ db, toRun: taskId, apply });
    expect(await recentlyDeliveredTargets({ db })).toContain(taskId);

    await backdateConsumed([id as number], 10 * 60_000);
    expect(await recentlyDeliveredTargets({ db })).not.toContain(taskId);
    expect(
      await recentlyDeliveredTargets({ db, withinMs: 60 * 60_000 }),
    ).toContain(taskId);
  });
});

describe("recentlyDeliveredTargets limit", () => {
  it("limit 1 returns the most recently consumed target", async () => {
    const t = await tree();
    const [a] = await seed(t.rootId, t.taskId, 1);
    const b = await insertMessage({
      db,
      from: t.rootId,
      to: t.reviewId,
      key: "newest",
      body: "newest",
    });
    if ("conflict" in b) throw new Error("unexpected conflict");
    const { apply } = recorder();
    await receiveFor({ db, toRun: t.taskId, apply });
    await receiveFor({ db, toRun: t.reviewId, apply });
    // Future stamps make both newer than anything other tests consumed.
    await backdateConsumed([a as number], -30 * 60_000);
    await backdateConsumed([b.id], -60 * 60_000);
    expect(await recentlyDeliveredTargets({ db, limit: 1 })).toEqual([
      t.reviewId,
    ]);
    expect(
      (await recentlyDeliveredTargets({ db, limit: 2 })).slice(0, 2),
    ).toEqual([t.reviewId, t.taskId]);
  });
});

describe("sweepUnconsumed", () => {
  it("ignores a backdated message to a deleted target: not swept, not logged", async () => {
    const t = await tree();
    const gone = `deleted-${t.taskId}`;
    const res = await insertMessage({
      db,
      from: t.rootId,
      to: gone,
      key: "gone",
      body: "to nobody",
    });
    if ("conflict" in res) throw new Error("unexpected conflict");
    await backdateCreated([res.id], 60_000);
    const logger = { error: vi.fn() };
    const result = await sweepUnconsumed({
      db,
      logger,
      apply: queuedFollowUpApply,
    });
    expect(result.targets).not.toContain(gone);
    expect(logger.error).not.toHaveBeenCalled();
    await db.delete(agentMessages).where(eq(agentMessages.id, res.id));
  });

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
    await backdateCreated([oldId as number], 60_000);

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
    await backdateCreated([badId as number, good.id], 60_000);

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
    await backdateCreated([a as number, b.id], 60_000);
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

  it("a legacy thread (no thread_chat) queues one D2 message on thread.queued_messages", async () => {
    const t = await tree();
    const chats = await db
      .select({ id: threadChat.id })
      .from(threadChat)
      .where(eq(threadChat.threadId, t.taskId));
    expect(chats).toHaveLength(0);

    const res = await sendMessage({
      db,
      organizationId: t.organizationId,
      from: t.rootId,
      to: t.taskId,
      key: "legacy",
      body: "hello legacy\u0000",
      apply: queuedFollowUpApply,
    });
    expect(res).toMatchObject({ ok: true, applied: 1 });
    const [row] = await db
      .select({ queued: thread.queuedMessages })
      .from(thread)
      .where(eq(thread.id, t.taskId));
    expect(row?.queued).toHaveLength(1);
    expect(row?.queued?.[0]).toMatchObject({
      type: "user",
      model: null,
      parts: [
        {
          type: "text",
          text: `Message from agent run ${t.rootId}:\n\nhello legacy`,
        },
      ],
    });
  });

  it("throws, and rolls the message back, when the thread is deleted", async () => {
    const t = await tree();
    const gone = `deleted-${t.taskId}`;
    const res = await insertMessage({
      db,
      from: t.rootId,
      to: gone,
      key: "deleted",
      body: "x",
    });
    if ("conflict" in res) throw new Error("unexpected conflict");
    await expect(
      receiveFor({ db, toRun: gone, apply: queuedFollowUpApply }),
    ).rejects.toThrow(/not found/);
    const rows = await db
      .select({ consumedAt: agentMessages.consumedAt })
      .from(agentMessages)
      .where(eq(agentMessages.toRun, gone));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consumedAt).toBeNull();
    expect((await counts([gone])).applied).toBe(0);
    await db.delete(agentMessages).where(eq(agentMessages.toRun, gone));
  });
});
