import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "@terragon/env/pkg-shared";
import { createDb, rowsOf } from "../../db";
import {
  agentApplied,
  agentMessagePruneCursor,
  agentMessages,
  thread,
  threadChat,
} from "../../db/schema";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "../test-helpers";
import { withSelfHealTx } from "../self-heal-tx";
import { createChildRun, ensureRootRun } from "./agent-run";
import {
  insertMessage,
  receiveFor,
  recentlyDeliveredTargets,
  sendMessage,
  type ApplyMessage,
} from "./messages";
import {
  AGENT_MESSAGE_RETENTION_MS,
  AgentMessagePruneError,
  pruneAgentMessages,
} from "./retention";

// Passthrough spy: AC9 checks the timeouts each batch transaction asks for.
vi.mock("../self-heal-tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../self-heal-tx")>();
  return { ...actual, withSelfHealTx: vi.fn(actual.withSelfHealTx) };
});

const db = createDb(env.DATABASE_URL!);

const R = AGENT_MESSAGE_RETENTION_MS;
const DAY = 86_400_000;
/** The fake clock: every cut and every backdate is relative to this. */
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const noopApply: ApplyMessage = async () => {};

/** Small batches, so a pass needs several to drain. */
const SMALL = { batch: 2, maxBatches: 2 };

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

/** A root (task) with one task child, both with an agent_run row. */
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
  const taskId = await orgThread(organizationId, { parentThreadId: rootId });
  const task = await createChildRun({
    db,
    organizationId,
    parentThreadId: rootId,
    childThreadId: taskId,
    request: { lane: "task" },
  });
  if (!task.ok) throw new Error("child not created");
  return { organizationId, rootId, taskId };
}

async function insert(from: string, to: string, key: string): Promise<number> {
  const res = await insertMessage({ db, from, to, key, body: `body ${key}` });
  if ("conflict" in res) throw new Error("unexpected conflict");
  return res.id;
}

/** Inserts and delivers one message to `to`; returns its id. */
async function sendConsumed(
  from: string,
  to: string,
  key: string,
): Promise<number> {
  const id = await insert(from, to, key);
  await receiveFor({ db, toRun: to, apply: noopApply });
  return id;
}

/** Stamps `created_at` and, when set, `consumed_at` of the messages `ms` before NOW. */
async function backdateMessages(ids: number[], ms: number): Promise<void> {
  await db
    .update(agentMessages)
    .set({ createdAt: ago(ms) })
    .where(inArray(agentMessages.id, ids));
  await db
    .update(agentMessages)
    .set({ consumedAt: ago(ms) })
    .where(
      and(
        inArray(agentMessages.id, ids),
        sql`${agentMessages.consumedAt} is not null`,
      ),
    );
}

/**
 * Terminal (a typed cause) or live, last written `lastWriteMs` before NOW.
 * Call it LAST: a later drizzle update re-stamps updated_at through $onUpdate.
 */
async function setSender(
  threadId: string,
  state: {
    terminal: boolean;
    lastWriteMs: number;
    /** `thread_chat.updated_at` offset (default: `lastWriteMs`). */
    chatWriteMs?: number;
    /** A terminal status held only on the chat row. */
    chatStatus?: "complete";
  },
): Promise<void> {
  await db
    .update(thread)
    .set({
      terminalCause: state.terminal ? "superseded" : null,
      updatedAt: ago(state.lastWriteMs),
    })
    .where(eq(thread.id, threadId));
  await db
    .update(threadChat)
    .set({
      updatedAt: ago(state.chatWriteMs ?? state.lastWriteMs),
      ...(state.chatStatus ? { status: state.chatStatus } : {}),
    })
    .where(eq(threadChat.threadId, threadId));
}

/** A thread with `thread_chat` rows, in its own org. */
async function chatThread(): Promise<string> {
  const organizationId = await createTestOrg({ db });
  const { user } = await createTestUser({ db });
  const { threadId } = await createTestThread({
    db,
    userId: user.id,
    enableThreadChatCreation: true,
    overrides: { organizationId },
  });
  return threadId;
}

/** A consumed message to `to` from a sender whose thread is then deleted, backdated past R. */
async function consumedFromGoneSender(to: string, key: string) {
  const gone = await orgThread(await createTestOrg({ db }));
  const id = await insert(gone, to, key);
  await receiveFor({ db, toRun: to, apply: noopApply });
  await backdateMessages([id], R + DAY);
  await db.delete(thread).where(eq(thread.id, gone));
  return id;
}

/** The value of `SHOW <name>` on the pooled session. */
async function show(name: "statement_timeout" | "lock_timeout") {
  const [row] = rowsOf<Record<string, unknown>>(
    await db.execute(sql.raw(`SHOW ${name}`)),
  );
  const value = row?.[name];
  // A broken read must fail loudly, never pass the "not 10s" check vacuously.
  if (typeof value !== "string")
    throw new Error(`SHOW ${name} returned no value`);
  return value;
}

async function present(ids: number[]): Promise<number[]> {
  const rows = await db
    .select({ id: agentMessages.id })
    .from(agentMessages)
    .where(inArray(agentMessages.id, ids));
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

async function appliedPresent(ids: number[]): Promise<number> {
  const rows = await db
    .select({ id: agentApplied.msgId })
    .from(agentApplied)
    .where(inArray(agentApplied.msgId, ids));
  return rows.length;
}

/** The stored consumed-pass cursor, or null when there is no row. */
async function storedCursor() {
  const [row] = await db
    .select({
      consumedAt: agentMessagePruneCursor.consumedAt,
      id: agentMessagePruneCursor.msgId,
    })
    .from(agentMessagePruneCursor);
  return row ?? null;
}

async function clearCursor() {
  await db.delete(agentMessagePruneCursor);
}

describe("pruneAgentMessages", () => {
  // The cursor persists across calls (#769): each test starts from the beginning.
  beforeEach(clearCursor);

  it("AC1 deletes a consumed row and its agent_applied row when the sender is terminal and idle past R", async () => {
    const { rootId, taskId } = await tree();
    const id = await sendConsumed(rootId, taskId, "ac1");
    expect(await appliedPresent([id])).toBe(1);
    await backdateMessages([id], R + DAY);
    await setSender(rootId, { terminal: true, lastWriteMs: R + DAY });

    const res = await pruneAgentMessages({ db, now: NOW });
    expect(res.messages).toBeGreaterThanOrEqual(1);
    expect(res.applied).toBeGreaterThanOrEqual(1);
    // Both rows are gone: the delete of the pair is one transaction.
    expect(await present([id])).toEqual([]);
    expect(await appliedPresent([id])).toBe(0);
  });

  it("AC2 keeps a consumed row older than R whose sender is not terminal", async () => {
    const { rootId, taskId } = await tree();
    const id = await sendConsumed(rootId, taskId, "ac2");
    await backdateMessages([id], R + DAY);
    await setSender(rootId, { terminal: false, lastWriteMs: R + DAY });

    await pruneAgentMessages({ db, now: NOW });
    expect(await present([id])).toEqual([id]);
    expect(await appliedPresent([id])).toBe(1);
  });

  it("AC3 keeps a consumed row whose terminal sender was last written within R", async () => {
    const { rootId, taskId } = await tree();
    const id = await sendConsumed(rootId, taskId, "ac3");
    await backdateMessages([id], R + DAY);
    await setSender(rootId, { terminal: true, lastWriteMs: R - DAY });

    await pruneAgentMessages({ db, now: NOW });
    expect(await present([id])).toEqual([id]);
    expect(await appliedPresent([id])).toBe(1);
  });

  it("AC4 keeps a consumed row younger than R whatever the sender's state", async () => {
    const { rootId, taskId } = await tree();
    const id = await sendConsumed(rootId, taskId, "ac4");
    await backdateMessages([id], R - DAY);
    await setSender(rootId, { terminal: true, lastWriteMs: R + DAY });

    await pruneAgentMessages({ db, now: NOW });
    expect(await present([id])).toEqual([id]);
  });

  it("AC5 never deletes an unconsumed row whose target exists, at any age", async () => {
    const { rootId, taskId } = await tree();
    const id = await insert(rootId, taskId, "ac5");
    await backdateMessages([id], 10 * R);
    await setSender(rootId, { terminal: true, lastWriteMs: 10 * R });

    await pruneAgentMessages({ db, now: NOW });
    expect(await present([id])).toEqual([id]);
  });

  it("AC6 deletes a consumed row older than R whose sender thread no longer exists", async () => {
    const { taskId } = await tree();
    const id = await consumedFromGoneSender(taskId, "ac6");
    expect(await appliedPresent([id])).toBe(1);

    await pruneAgentMessages({ db, now: NOW });
    expect(await present([id])).toEqual([]);
    expect(await appliedPresent([id])).toBe(0);
  });

  it("AC7 deletes an unconsumed row older than R whose target thread is gone, with its agent_applied row", async () => {
    const { rootId } = await tree();
    const gone = `deleted-${rootId}`;
    const id = await insert(rootId, gone, "ac7");
    await db.insert(agentApplied).values({ msgId: id, run: gone });
    await backdateMessages([id], R + DAY);

    const res = await pruneAgentMessages({ db, now: NOW });
    expect(res.orphans).toBeGreaterThanOrEqual(1);
    expect(await present([id])).toEqual([]);
    expect(await appliedPresent([id])).toBe(0);
  });

  it("AC7 (F2) keeps a delivered-and-failed unconsumed row while its target exists, prunes it once the target is deleted", async () => {
    const { rootId } = await tree();
    const target = await orgThread(await createTestOrg({ db }));
    const id = await insert(rootId, target, "ac7-f2");
    await backdateMessages([id], R + DAY);

    await pruneAgentMessages({ db, now: NOW });
    expect(await present([id])).toEqual([id]);

    await db.delete(thread).where(eq(thread.id, target));
    const res = await pruneAgentMessages({ db, now: NOW });
    expect(res.orphans).toBeGreaterThanOrEqual(1);
    expect(await present([id])).toEqual([]);
  });

  it("AC8 deletes at most batch x maxBatches per pass, each batch commits, a second call continues", async () => {
    // The prune is table-wide: drain rows other tests left prunable so they
    // cannot take this test's batch slots.
    await pruneAgentMessages({ db, now: NOW });
    const organizationId = await createTestOrg({ db });
    const senderGone = await orgThread(organizationId);
    const target = await orgThread(organizationId);
    const consumed: number[] = [];
    const orphans: number[] = [];
    for (let i = 0; i < 5; i++) {
      consumed.push(await insert(senderGone, target, `c${i}`));
      orphans.push(await insert(senderGone, `deleted-${senderGone}`, `o${i}`));
    }
    // Consumed rows share one timestamp: the keyset must break ties by id.
    await receiveFor({ db, toRun: target, apply: noopApply });
    await backdateMessages([...consumed, ...orphans], R + DAY);
    await db.delete(thread).where(eq(thread.id, senderGone));

    const first = await pruneAgentMessages({ db, now: NOW, ...SMALL });
    expect(first.messages).toBeLessThanOrEqual(2 * 2);
    expect(first.orphans).toBeLessThanOrEqual(2 * 2);
    expect(first.applied).toBeLessThanOrEqual(2 * 2 * 2);
    // Own ids only: the table may hold other tests' rows.
    expect(await present(consumed)).toHaveLength(1);
    expect(await present(orphans)).toHaveLength(1);

    const second = await pruneAgentMessages({ db, now: NOW, ...SMALL });
    expect(second.messages).toBeLessThanOrEqual(2 * 2);
    expect(second.orphans).toBeLessThanOrEqual(2 * 2);
    expect(await present([...consumed, ...orphans])).toEqual([]);
  });

  it("orphan pass keeps an unconsumed row whose target is gone but created_at is within R", async () => {
    const { rootId } = await tree();
    const id = await insert(rootId, `deleted-${rootId}`, "orphan-young");
    await backdateMessages([id], R - DAY);

    await pruneAgentMessages({ db, now: NOW });
    expect(await present([id])).toEqual([id]);
  });

  it("chat mode: keeps a terminal sender whose thread row is idle past R but a thread_chat row was written within R", async () => {
    const { taskId } = await tree();
    const sender = await chatThread();
    const id = await insert(sender, taskId, "chat-recent");
    await receiveFor({ db, toRun: taskId, apply: noopApply });
    await backdateMessages([id], R + DAY);
    await setSender(sender, {
      terminal: true,
      lastWriteMs: R + DAY,
      chatWriteMs: R - DAY,
    });

    await pruneAgentMessages({ db, now: NOW });
    expect(await present([id])).toEqual([id]);
  });

  it("chat mode: a terminal status only on the chat row, everything idle past R, is pruned", async () => {
    const { taskId } = await tree();
    const sender = await chatThread();
    const id = await insert(sender, taskId, "chat-terminal");
    await receiveFor({ db, toRun: taskId, apply: noopApply });
    await backdateMessages([id], R + DAY);
    await setSender(sender, {
      terminal: false,
      lastWriteMs: R + DAY,
      chatStatus: "complete",
    });

    await pruneAgentMessages({ db, now: NOW });
    expect(await present([id])).toEqual([]);
  });

  it("a kept row with the earliest consumed_at does not block pruning the rows behind it", async () => {
    // Not observable directly: the sender rule is in the WHERE, so a kept row
    // is never selected. This proves the call terminates and, with batch 2 and
    // maxBatches 2, the kept head does not eat a batch slot: all 4 are deleted.
    const organizationId = await createTestOrg({ db });
    const live = await orgThread(organizationId);
    const gone = await orgThread(organizationId);
    const target = await orgThread(organizationId);
    const kept = await insert(live, target, "head");
    const prunable: number[] = [];
    for (let i = 0; i < 4; i++) {
      prunable.push(await insert(gone, target, `p${i}`));
    }
    await receiveFor({ db, toRun: target, apply: noopApply });
    await backdateMessages([kept], R + 3 * DAY);
    await backdateMessages(prunable, R + DAY);
    await db.delete(thread).where(eq(thread.id, gone));

    await pruneAgentMessages({ db, now: NOW, ...SMALL });
    expect(await present(prunable)).toEqual([]);
    expect(await present([kept])).toEqual([kept]);
  });

  it("rejects non-positive or non-integer batch, maxBatches and budgetMs with a RangeError", async () => {
    for (const bad of [
      { batch: 0 },
      { batch: 1.5 },
      { maxBatches: 0 },
      { maxBatches: -1 },
      { budgetMs: 0 },
      { budgetMs: Number.NaN },
      { budgetMs: Number.POSITIVE_INFINITY },
    ]) {
      await expect(
        pruneAgentMessages({ db, now: NOW, ...bad }),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });

  it("AC8 once the wall-clock budget is spent, the orphan pass starts no batch and the consumed pass at most one", async () => {
    await pruneAgentMessages({ db, now: NOW });
    const { consumed, orphan } = await consumedAndOrphan("budget");
    const tx = vi.mocked(withSelfHealTx);
    tx.mockClear();

    // budgetMs must be > 0, so spend it before the call starts.
    const spy = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValue(1_000_000);
    try {
      expect(await pruneAgentMessages({ db, now: NOW, budgetMs: 1 })).toEqual({
        messages: 1,
        applied: 1,
        orphans: 0,
      });
    } finally {
      spy.mockRestore();
    }
    expect(tx).toHaveBeenCalledTimes(1);
    expect(await present([orphan])).toEqual([orphan]);
    expect(await present([consumed])).toEqual([]);
    await pruneAgentMessages({ db, now: NOW });
    expect(await present([orphan])).toEqual([]);
  });

  it("AC8 an orphan pass that spends the whole budget still leaves the consumed pass one batch", async () => {
    await pruneAgentMessages({ db, now: NOW });
    const a = await consumedAndOrphan("starve-a");
    const b = await consumedAndOrphan("starve-b");
    // The clock jumps past the budget while the orphan pass's first batch runs.
    let clock = 1_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const tx = vi.mocked(withSelfHealTx);
    const real = tx.getMockImplementation();
    if (!real) throw new Error("withSelfHealTx spy has no implementation");
    tx.mockImplementationOnce(async (...args) => {
      const result = await real(...args);
      clock += 60_000;
      return result;
    });
    try {
      expect(
        await pruneAgentMessages({ db, now: NOW, batch: 1, budgetMs: 20_000 }),
      ).toMatchObject({ messages: 1, orphans: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(await present([a.orphan, b.orphan])).toHaveLength(1);
    expect(await present([a.consumed, b.consumed])).toHaveLength(1);
  });

  it("AC9 asks every batch transaction for 10 s / 1 s (SET LOCAL): the pooled session is unchanged afterwards", async () => {
    // That withSelfHealTx applies them inside the transaction only is pinned by
    // self-heal-tx.test.ts:24-35 ("sets statement and lock timeouts inside, not outside").
    const spy = vi.mocked(withSelfHealTx);
    spy.mockClear();
    await pruneAgentMessages({ db, now: NOW });
    // At least one batch per pass, even when nothing is prunable.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of spy.mock.calls) {
      expect(call[2]).toEqual({
        statementTimeoutMs: 10_000,
        lockTimeoutMs: 1_000,
      });
    }
    expect(await show("statement_timeout")).not.toBe("10s");
    expect(await show("lock_timeout")).not.toBe("1s");
  });

  it("AC11 a retry of a pruned key from the still-terminal sender is sender_not_running and writes no row", async () => {
    const { organizationId, rootId, taskId } = await tree();
    const id = await sendConsumed(rootId, taskId, "ac11");
    await backdateMessages([id], R + DAY);
    await setSender(rootId, { terminal: true, lastWriteMs: R + DAY });
    await pruneAgentMessages({ db, now: NOW });
    expect(await present([id])).toEqual([]);

    // The target stays alive with its agent_run row, so the refusal is the sender's.
    const retry = await sendMessage({
      db,
      organizationId,
      from: rootId,
      to: taskId,
      key: "ac11",
      body: "body ac11",
      apply: noopApply,
    });
    expect(retry).toEqual({ ok: false, error: "sender_not_running" });
    const rows = await db
      .select({ id: agentMessages.id })
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.fromRun, rootId),
          eq(agentMessages.idemKey, "ac11"),
        ),
      );
    expect(rows).toEqual([]);
  });

  it("AC12 recentlyDeliveredTargets still returns a target consumed 60 s ago, right after a prune", async () => {
    const { rootId, taskId } = await tree();
    const id = await sendConsumed(rootId, taskId, "ac12");
    await db
      .update(agentMessages)
      .set({ consumedAt: new Date(Date.now() - 60_000) })
      .where(eq(agentMessages.id, id));

    await pruneAgentMessages({ db, now: new Date() });
    expect(await present([id])).toEqual([id]);
    expect(await recentlyDeliveredTargets({ db })).toContain(taskId);
  });

  it("C1 skips a sender whose thread row a concurrent transaction holds (a resume in flight), prunes it once released", async () => {
    const { rootId, taskId } = await tree();
    const id = await sendConsumed(rootId, taskId, "c1-thread");
    await backdateMessages([id], R + DAY);
    await setSender(rootId, { terminal: true, lastWriteMs: R + DAY });

    await whileLocked(
      sql`select 1 from ${thread} where ${thread.id} = ${rootId} for update`,
      async () => {
        await pruneAgentMessages({ db, now: NOW });
        expect(await present([id])).toEqual([id]);
      },
    );
    await pruneAgentMessages({ db, now: NOW });
    expect(await present([id])).toEqual([]);
  });

  it("C1 skips a chat-mode sender whose thread_chat row a concurrent transaction holds, prunes it once released", async () => {
    const { taskId } = await tree();
    const sender = await chatThread();
    const id = await insert(sender, taskId, "c1-chat");
    await receiveFor({ db, toRun: taskId, apply: noopApply });
    await backdateMessages([id], R + DAY);
    await setSender(sender, {
      terminal: false,
      lastWriteMs: R + DAY,
      chatStatus: "complete",
    });

    await whileLocked(
      sql`select 1 from ${threadChat} where ${threadChat.threadId} = ${sender} for update`,
      async () => {
        await pruneAgentMessages({ db, now: NOW });
        expect(await present([id])).toEqual([id]);
      },
    );
    await pruneAgentMessages({ db, now: NOW });
    expect(await present([id])).toEqual([]);
  });

  it("C2 a failing orphan pass still lets the consumed pass delete its rows, and the call rejects with both counts", async () => {
    await pruneAgentMessages({ db, now: NOW });
    const { consumed, orphan } = await consumedAndOrphan("c2-orphan");
    const spy = vi.mocked(withSelfHealTx);
    spy.mockImplementationOnce(async () => {
      throw new Error("injected orphan failure");
    });

    const error = await pruneAgentMessages({ db, now: NOW }).catch((e) => e);
    expect(error).toBeInstanceOf(AgentMessagePruneError);
    expect((error as AgentMessagePruneError).errors).toHaveLength(1);
    expect((error as AgentMessagePruneError).counts.messages).toBe(1);
    expect((error as AgentMessagePruneError).counts.orphans).toBe(0);
    expect(await present([consumed])).toEqual([]);
    expect(await present([orphan])).toEqual([orphan]);
  });

  it("C2 a failing consumed pass still lets the orphan pass delete its rows, and the call rejects", async () => {
    await pruneAgentMessages({ db, now: NOW });
    const { consumed, orphan } = await consumedAndOrphan("c2-consumed");
    const spy = vi.mocked(withSelfHealTx);
    const real = spy.getMockImplementation();
    if (!real) throw new Error("withSelfHealTx spy has no implementation");
    spy.mockImplementationOnce(real).mockImplementationOnce(async () => {
      throw new Error("injected consumed failure");
    });

    const error = await pruneAgentMessages({ db, now: NOW }).catch((e) => e);
    expect(error).toBeInstanceOf(AgentMessagePruneError);
    expect((error as AgentMessagePruneError).errors).toHaveLength(1);
    expect((error as AgentMessagePruneError).counts.orphans).toBe(1);
    expect((error as AgentMessagePruneError).counts.messages).toBe(0);
    expect(await present([orphan])).toEqual([]);
    expect(await present([consumed])).toEqual([consumed]);
  });

  describe("persisted cursor (#769)", () => {
    /**
     * 3 x batch consumed rows the pass selects but keeps (their sender's thread
     * row is held, so `fenceSenders` skips it), older than 2 deletable rows.
     */
    async function fencedHeadThenDeletable() {
      await pruneAgentMessages({ db, now: NOW });
      await clearCursor();
      const { rootId, taskId } = await tree();
      const fenced: number[] = [];
      for (let i = 0; i < 6; i++) {
        fenced.push(await insert(rootId, taskId, `fenced-${i}`));
      }
      await receiveFor({ db, toRun: taskId, apply: noopApply });
      await backdateMessages(fenced, R + 3 * DAY);
      await setSender(rootId, { terminal: true, lastWriteMs: R + 3 * DAY });
      const deletable = [
        await consumedFromGoneSender(taskId, "behind-0"),
        await consumedFromGoneSender(taskId, "behind-1"),
      ];
      const lockFenced = sql`select 1 from ${thread} where ${thread.id} = ${rootId} for update`;
      return { fenced, deletable, lockFenced };
    }

    const ONE = { batch: 2, maxBatches: 1 };

    it("AC1 kept rows filling the batch budget no longer starve the deletable rows behind them", async () => {
      const { fenced, deletable, lockFenced } = await fencedHeadThenDeletable();
      await whileLocked(lockFenced, async () => {
        // Contrast: without the cursor (as before #769) every call re-reads the head.
        for (let call = 0; call < 4; call++) {
          await clearCursor();
          await pruneAgentMessages({ db, now: NOW, ...ONE });
        }
        expect(await present(deletable)).toEqual(deletable);

        await clearCursor();
        for (let call = 0; call < 4; call++) {
          await pruneAgentMessages({ db, now: NOW, ...ONE });
        }
        expect(await present(deletable)).toEqual([]);
        expect(await present(fenced)).toEqual(fenced);
      });
    });

    it("AC1 live senders (filtered by the sender rule) never took batch slots and still do not", async () => {
      await pruneAgentMessages({ db, now: NOW });
      const { rootId, taskId } = await tree();
      const kept: number[] = [];
      for (let i = 0; i < 6; i++) {
        kept.push(await insert(rootId, taskId, `live-${i}`));
      }
      await receiveFor({ db, toRun: taskId, apply: noopApply });
      await backdateMessages(kept, R + 3 * DAY);
      await setSender(rootId, { terminal: false, lastWriteMs: R + 3 * DAY });
      const deletable = await consumedFromGoneSender(taskId, "live-behind");

      await pruneAgentMessages({ db, now: NOW, ...ONE });
      expect(await present([deletable])).toEqual([]);
      expect(await present(kept)).toEqual(kept);
    });

    it("AC1 a full batch stores the cursor of its last selected row", async () => {
      const { fenced, lockFenced } = await fencedHeadThenDeletable();
      await whileLocked(lockFenced, async () => {
        await pruneAgentMessages({ db, now: NOW, ...ONE });
      });
      expect((await storedCursor())?.id).toBe(fenced[1]);
    });

    it("AC2 a batch that fails after its delete rolls the delete and the cursor back", async () => {
      await pruneAgentMessages({ db, now: NOW });
      const { taskId } = await tree();
      const ids = [
        await consumedFromGoneSender(taskId, "ac2-tx-0"),
        await consumedFromGoneSender(taskId, "ac2-tx-1"),
        await consumedFromGoneSender(taskId, "ac2-tx-2"),
      ];
      // A first call leaves the cursor at ids[1] (a full batch of 2).
      await pruneAgentMessages({ db, now: NOW, ...ONE });
      expect(await present(ids)).toEqual([ids[2]]);
      const before = await storedCursor();
      expect(before?.id).toBe(ids[1]);

      const spy = vi.mocked(withSelfHealTx);
      const real = spy.getMockImplementation();
      if (!real) throw new Error("withSelfHealTx spy has no implementation");
      let deletedInTx: number[] | null = null;
      spy.mockImplementationOnce(real).mockImplementationOnce(
        async (txDb, fn, opts) =>
          real(
            txDb,
            async (tx) => {
              await fn(tx);
              // The delete and the cursor write happened, uncommitted.
              const rows = await tx
                .select({ id: agentMessages.id })
                .from(agentMessages)
                .where(inArray(agentMessages.id, ids));
              deletedInTx = rows.map((r) => r.id);
              throw new Error("injected failure before commit");
            },
            opts,
          ) as never,
      );

      const error = await pruneAgentMessages({ db, now: NOW, ...ONE }).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(AgentMessagePruneError);
      expect(deletedInTx).toEqual([]);
      expect(await present(ids)).toEqual([ids[2]]);
      expect(await storedCursor()).toEqual(before);
    });

    it("AC3 a short batch clears the cursor and the next call starts from the beginning", async () => {
      await pruneAgentMessages({ db, now: NOW });
      const { taskId } = await tree();
      const ids = [
        await consumedFromGoneSender(taskId, "ac3-wrap-0"),
        await consumedFromGoneSender(taskId, "ac3-wrap-1"),
      ];
      await pruneAgentMessages({ db, now: NOW, ...ONE });
      expect(await storedCursor()).not.toBeNull();

      // A row behind the cursor: only a pass from the beginning reaches it.
      const behind = await consumedFromGoneSender(taskId, "ac3-behind");
      await backdateMessages([behind], R + 5 * DAY);
      await pruneAgentMessages({ db, now: NOW, ...ONE });
      expect(await storedCursor()).toBeNull();
      expect(await present([behind])).toEqual([behind]);

      await pruneAgentMessages({ db, now: NOW, ...ONE });
      expect(await present([...ids, behind])).toEqual([]);
      expect(await storedCursor()).toBeNull();
    });

    it("AC4 two concurrent calls delete each row once, both resolve, and leave nothing deletable behind", async () => {
      await pruneAgentMessages({ db, now: NOW });
      const { taskId } = await tree();
      const ids: number[] = [];
      for (let i = 0; i < 12; i++) {
        ids.push(await consumedFromGoneSender(taskId, `ac4-${i}`));
      }
      const results = await Promise.all([
        pruneAgentMessages({ db, now: NOW, batch: 2, maxBatches: 3 }),
        pruneAgentMessages({ db, now: NOW, batch: 2, maxBatches: 3 }),
      ]);
      const deletedNow = ids.length - (await present(ids)).length;
      // Each deleted id is counted by exactly one call.
      expect(results[0]!.messages + results[1]!.messages).toBe(deletedNow);
      // Whatever cursor won, calls until a wrap reach every row.
      for (let call = 0; call < 10 && (await present(ids)).length > 0; call++) {
        await pruneAgentMessages({ db, now: NOW, batch: 2, maxBatches: 3 });
      }
      expect(await present(ids)).toEqual([]);
    });

    it("AC5 with no cursor row the pass starts from the beginning", async () => {
      await pruneAgentMessages({ db, now: NOW });
      const { taskId } = await tree();
      const id = await consumedFromGoneSender(taskId, "ac5-empty");
      await backdateMessages([id], R + 10 * DAY);
      expect(await storedCursor()).toBeNull();
      await pruneAgentMessages({ db, now: NOW, ...ONE });
      expect(await present([id])).toEqual([]);
    });
  });
});

/**
 * Runs `fn` while a second connection holds the row lock `lockSql` takes, as a
 * resume's UPDATE would; the lock is released (rolled back) afterwards.
 */
async function whileLocked(lockSql: SQL, fn: () => Promise<void>) {
  let locked!: () => void;
  const taken = new Promise<void>((resolve) => (locked = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const holder = db
    .transaction(async (tx) => {
      await tx.execute(lockSql);
      locked();
      await released;
      throw new Error("rollback");
    })
    .catch(() => {});
  await taken;
  try {
    await fn();
  } finally {
    release();
    await holder;
  }
}

/** One prunable consumed row (terminal sender idle past R) and one prunable orphan. */
async function consumedAndOrphan(key: string) {
  const { rootId, taskId } = await tree();
  const consumed = await sendConsumed(rootId, taskId, `${key}-consumed`);
  const orphan = await insert(rootId, `deleted-${rootId}`, `${key}-orphan`);
  await backdateMessages([consumed, orphan], R + DAY);
  await setSender(rootId, { terminal: true, lastWriteMs: R + DAY });
  return { consumed, orphan };
}
