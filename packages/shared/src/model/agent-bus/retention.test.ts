import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { env } from "@terragon/env/pkg-shared";
import { createDb, rowsOf } from "../../db";
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
import { createChildRun, ensureRootRun } from "./agent-run";
import {
  insertMessage,
  receiveFor,
  recentlyDeliveredTargets,
  sendMessage,
  type ApplyMessage,
} from "./messages";
import { AGENT_MESSAGE_RETENTION_MS, pruneAgentMessages } from "./retention";

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

describe("pruneAgentMessages", () => {
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

  it("AC8 starts no batch once the wall-clock budget is spent", async () => {
    const { taskId } = await tree();
    const id = await consumedFromGoneSender(taskId, "budget");

    // budgetMs must be > 0, so spend it before the call starts.
    const spy = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValue(1_000_000);
    try {
      expect(await pruneAgentMessages({ db, now: NOW, budgetMs: 1 })).toEqual({
        messages: 0,
        applied: 0,
        orphans: 0,
      });
    } finally {
      spy.mockRestore();
    }
    expect(await present([id])).toEqual([id]);
    await pruneAgentMessages({ db, now: NOW });
    expect(await present([id])).toEqual([]);
  });

  it("AC9 sets its timeouts per transaction (SET LOCAL): the pooled session is unchanged afterwards", async () => {
    // The in-transaction values are pinned by self-heal-tx.test.ts:24-35
    // ("sets statement and lock timeouts inside, not outside").
    await pruneAgentMessages({ db, now: NOW });
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
});
