import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../../db";
import { agentRun, thread } from "../../db/schema";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "../test-helpers";
import {
  clearBlocked,
  createChildRun,
  ensureRootRun,
  getRunForOrg,
  markBlocked,
} from "./agent-run";
import { authorizeSend, type AgentCapabilities } from "./capabilities";

const db = createDb(env.DATABASE_URL!);

async function orgThread(
  organizationId: string | null,
  overrides: { parentThreadId?: string; githubRepoFullName?: string } = {},
) {
  const { user } = await createTestUser({ db });
  const { threadId } = await createTestThread({
    db,
    userId: user.id,
    overrides: { organizationId, ...overrides },
  });
  return threadId;
}

async function rowCount(threadId: string): Promise<number> {
  const rows = await db
    .select({ id: agentRun.threadId })
    .from(agentRun)
    .where(eq(agentRun.threadId, threadId));
  return rows.length;
}

async function rootAndChild() {
  const organizationId = await createTestOrg({ db });
  const rootId = await orgThread(organizationId);
  const root = await ensureRootRun({
    db,
    threadId: rootId,
    organizationId,
    lane: "task",
  });
  if (!root) throw new Error("root not created");
  const childId = await orgThread(organizationId, { parentThreadId: rootId });
  return { organizationId, rootId, childId };
}

describe("agent run ledger", () => {
  it("AC4 an absent id and another organization's id both read null", async () => {
    const { organizationId, rootId } = await rootAndChild();
    const otherOrg = await createTestOrg({ db });
    const absent = await getRunForOrg({
      db,
      organizationId,
      threadId: "no-such-thread",
    });
    const foreign = await getRunForOrg({
      db,
      organizationId: otherOrg,
      threadId: rootId,
    });
    expect(absent).toBeNull();
    expect(foreign).toBeNull();
    expect(foreign).toEqual(absent);
  });

  it("getRunForOrg reports effective status and terminality", async () => {
    const { organizationId, rootId } = await rootAndChild();
    const live = await getRunForOrg({ db, organizationId, threadId: rootId });
    expect(live?.terminal).toBe(false);
    await db
      .update(thread)
      .set({ terminalCause: "superseded" })
      .where(eq(thread.id, rootId));
    const dead = await getRunForOrg({ db, organizationId, threadId: rootId });
    expect(dead?.terminal).toBe(true);
  });

  describe("ensureRootRun", () => {
    it("AC5 is idempotent: one row, the existing row unchanged even with another lane", async () => {
      const organizationId = await createTestOrg({ db });
      const threadId = await orgThread(organizationId, {
        githubRepoFullName: "acme/repo",
      });
      const first = await ensureRootRun({
        db,
        threadId,
        organizationId,
        lane: "task",
      });
      const second = await ensureRootRun({
        db,
        threadId,
        organizationId,
        lane: "review",
      });
      expect(first).not.toBeNull();
      expect(second).toEqual(first);
      expect(second?.lane).toBe("task");
      expect(first?.rootThreadId).toBe(threadId);
      expect(first?.depth).toBe(0);
      expect(first?.capabilities.repoGrant).toEqual([
        { repo: "acme/repo", access: "write" },
      ]);
      expect(await rowCount(threadId)).toBe(1);
    });

    it("returns null for a thread without an organization, a mismatch, or an absent thread", async () => {
      const organizationId = await createTestOrg({ db });
      const otherOrg = await createTestOrg({ db });
      const noOrg = await orgThread(null);
      const owned = await orgThread(otherOrg);
      expect(
        await ensureRootRun({
          db,
          threadId: noOrg,
          organizationId,
          lane: "task",
        }),
      ).toBeNull();
      expect(
        await ensureRootRun({
          db,
          threadId: owned,
          organizationId,
          lane: "task",
        }),
      ).toBeNull();
      expect(
        await ensureRootRun({
          db,
          threadId: "no-such-thread",
          organizationId,
          lane: "task",
        }),
      ).toBeNull();
      expect(await rowCount(noOrg)).toBe(0);
      expect(await rowCount(owned)).toBe(0);
    });
  });

  describe("createChildRun", () => {
    it("registers a narrower child in the parent's tree", async () => {
      const { organizationId, rootId, childId } = await rootAndChild();
      const res = await createChildRun({
        db,
        organizationId,
        parentThreadId: rootId,
        childThreadId: childId,
        request: { lane: "review" },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.run.rootThreadId).toBe(rootId);
      expect(res.run.parentThreadId).toBe(rootId);
      expect(res.run.depth).toBe(1);
      expect(res.run.lane).toBe("review");
      expect(res.run.capabilities.spawn).toEqual([]);
      expect(res.run.capabilities.repoGrant).toEqual([
        { repo: "terragon/test-repo", access: "read" },
      ]);
      expect(await rowCount(childId)).toBe(1);
    });

    it("not_found for a foreign organization", async () => {
      const { rootId, childId } = await rootAndChild();
      const otherOrg = await createTestOrg({ db });
      const res = await createChildRun({
        db,
        organizationId: otherOrg,
        parentThreadId: rootId,
        childThreadId: childId,
        request: { lane: "task" },
      });
      expect(res).toEqual({ ok: false, error: "not_found" });
      expect(await rowCount(childId)).toBe(0);
    });

    it("not_found when the child thread's parent is another thread", async () => {
      const { organizationId, rootId } = await rootAndChild();
      const stranger = await orgThread(organizationId);
      const res = await createChildRun({
        db,
        organizationId,
        parentThreadId: rootId,
        childThreadId: stranger,
        request: { lane: "task" },
      });
      expect(res).toEqual({ ok: false, error: "not_found" });
    });

    it("sender_not_running for a terminal parent", async () => {
      const { organizationId, rootId, childId } = await rootAndChild();
      await db
        .update(thread)
        .set({ status: "complete" })
        .where(eq(thread.id, rootId));
      const res = await createChildRun({
        db,
        organizationId,
        parentThreadId: rootId,
        childThreadId: childId,
        request: { lane: "task" },
      });
      expect(res).toEqual({ ok: false, error: "sender_not_running" });
    });

    it("sender_not_running for a parent with a terminal cause", async () => {
      const { organizationId, rootId, childId } = await rootAndChild();
      await db
        .update(thread)
        .set({ terminalCause: "superseded" })
        .where(eq(thread.id, rootId));
      const res = await createChildRun({
        db,
        organizationId,
        parentThreadId: rootId,
        childThreadId: childId,
        request: { lane: "task" },
      });
      expect(res).toEqual({ ok: false, error: "sender_not_running" });
    });

    it("agent_blocked for a blocked parent; terminal wins over blocked", async () => {
      const { organizationId, rootId, childId } = await rootAndChild();
      await markBlocked({
        db,
        organizationId,
        threadId: rootId,
        reason: "waiting",
      });
      const blocked = await createChildRun({
        db,
        organizationId,
        parentThreadId: rootId,
        childThreadId: childId,
        request: { lane: "task" },
      });
      expect(blocked).toEqual({ ok: false, error: "agent_blocked" });
      await db
        .update(thread)
        .set({ status: "complete" })
        .where(eq(thread.id, rootId));
      const both = await createChildRun({
        db,
        organizationId,
        parentThreadId: rootId,
        childThreadId: childId,
        request: { lane: "task" },
      });
      expect(both).toEqual({ ok: false, error: "sender_not_running" });
    });

    it("passes a narrowing refusal through", async () => {
      const organizationId = await createTestOrg({ db });
      const rootId = await orgThread(organizationId);
      await ensureRootRun({
        db,
        threadId: rootId,
        organizationId,
        lane: "review",
      });
      const childId = await orgThread(organizationId, {
        parentThreadId: rootId,
      });
      const res = await createChildRun({
        db,
        organizationId,
        parentThreadId: rootId,
        childThreadId: childId,
        request: { lane: "task" },
      });
      expect(res).toEqual({
        ok: false,
        error: "lane_pair_not_allowed:review->task",
      });
      expect(await rowCount(childId)).toBe(0);
    });

    it("run_exists for a duplicate child, leaving the first row intact", async () => {
      const { organizationId, rootId, childId } = await rootAndChild();
      const first = await createChildRun({
        db,
        organizationId,
        parentThreadId: rootId,
        childThreadId: childId,
        request: { lane: "task" },
      });
      expect(first.ok).toBe(true);
      const again = await createChildRun({
        db,
        organizationId,
        parentThreadId: rootId,
        childThreadId: childId,
        request: { lane: "review" },
      });
      expect(again).toEqual({ ok: false, error: "run_exists" });
      const row = await getRunForOrg({ db, organizationId, threadId: childId });
      expect(row?.lane).toBe("task");
    });
  });

  it("markBlocked and clearBlocked round-trip through getRunForOrg", async () => {
    const { organizationId, rootId } = await rootAndChild();
    await markBlocked({ db, organizationId, threadId: rootId, reason: "wait" });
    const blocked = await getRunForOrg({
      db,
      organizationId,
      threadId: rootId,
    });
    expect(blocked?.blockedAt).toBeInstanceOf(Date);
    await clearBlocked({ db, organizationId, threadId: rootId });
    const clear = await getRunForOrg({ db, organizationId, threadId: rootId });
    expect(clear?.blockedAt).toBeNull();
  });

  it("markBlocked from another organization changes nothing", async () => {
    const { organizationId, rootId } = await rootAndChild();
    const otherOrg = await createTestOrg({ db });
    await markBlocked({
      db,
      organizationId: otherOrg,
      threadId: rootId,
      reason: "x",
    });
    const run = await getRunForOrg({ db, organizationId, threadId: rootId });
    expect(run?.blockedAt).toBeNull();
  });

  it("AC7 a run in another tree of the same org is not_found to authorizeSend", async () => {
    const { organizationId, rootId, childId } = await rootAndChild();
    const child = await createChildRun({
      db,
      organizationId,
      parentThreadId: rootId,
      childThreadId: childId,
      request: { lane: "task" },
    });
    if (!child.ok) throw new Error(child.error);
    const otherRootId = await orgThread(organizationId);
    const otherRoot = await ensureRootRun({
      db,
      threadId: otherRootId,
      organizationId,
      lane: "task",
    });
    const absent = await getRunForOrg({
      db,
      organizationId,
      threadId: "no-such-thread",
    });
    expect(authorizeSend(child.run, otherRoot)).toBe("not_found");
    expect(authorizeSend(child.run, otherRoot)).toBe(
      authorizeSend(child.run, absent),
    );
  });

  it("reads null when the thread's own org differs from the ledger row's", async () => {
    const organizationId = await createTestOrg({ db });
    const rootId = await orgThread(organizationId);
    await ensureRootRun({ db, threadId: rootId, organizationId, lane: "task" });
    const otherOrg = await createTestOrg({ db });
    await db
      .update(thread)
      .set({ organizationId: otherOrg })
      .where(eq(thread.id, rootId));
    expect(await getRunForOrg({ db, organizationId, threadId: rootId })).toBe(
      null,
    );
  });

  it("throws on a row whose stored capabilities are malformed", async () => {
    const organizationId = await createTestOrg({ db });
    const rootId = await orgThread(organizationId);
    await ensureRootRun({ db, threadId: rootId, organizationId, lane: "task" });
    await db
      .update(agentRun)
      .set({
        capabilities: { spawn: ["task"] } as unknown as AgentCapabilities,
      })
      .where(eq(agentRun.threadId, rootId));
    await expect(
      getRunForOrg({ db, organizationId, threadId: rootId }),
    ).rejects.toThrow(/malformed/);
  });

  it("waits on a concurrent markBlocked of the parent and then refuses (agent_blocked)", async () => {
    const { organizationId, rootId, childId } = await rootAndChild();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let blockedInTx: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => (blockedInTx = resolve));
    const blocker = db.transaction(async (tx) => {
      await markBlocked({
        db: tx,
        organizationId,
        threadId: rootId,
        reason: "held",
      });
      blockedInTx();
      await held;
    });
    await blocked;
    let settled = false;
    const spawn = createChildRun({
      db,
      organizationId,
      parentThreadId: rootId,
      childThreadId: childId,
      request: { lane: "task" },
    }).then((res) => {
      settled = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    release();
    await blocker;
    expect(await spawn).toEqual({ ok: false, error: "agent_blocked" });
    expect(await rowCount(childId)).toBe(0);
  });

  describe("foreign keys on delete", () => {
    async function tree() {
      const { organizationId, rootId, childId } = await rootAndChild();
      const child = await createChildRun({
        db,
        organizationId,
        parentThreadId: rootId,
        childThreadId: childId,
        request: { lane: "task" },
      });
      if (!child.ok) throw new Error(child.error);
      const grandchildId = await orgThread(organizationId, {
        parentThreadId: childId,
      });
      const grandchild = await createChildRun({
        db,
        organizationId,
        parentThreadId: childId,
        childThreadId: grandchildId,
        request: { lane: "task" },
      });
      if (!grandchild.ok) throw new Error(grandchild.error);
      return { organizationId, rootId, childId, grandchildId };
    }

    it("deleting a mid-tree parent keeps the grandchild, not a root (parent nulled, depth and root kept)", async () => {
      const { organizationId, rootId, childId, grandchildId } = await tree();
      await db.delete(thread).where(eq(thread.id, childId));
      const run = await getRunForOrg({
        db,
        organizationId,
        threadId: grandchildId,
      });
      expect(run).not.toBeNull();
      expect(run?.parentThreadId).toBeNull();
      expect(run?.depth).toBe(2);
      expect(run?.rootThreadId).toBe(rootId);
      expect(run?.rootThreadId).not.toBe(run?.threadId);
    });

    it("deleting the root removes every run in its tree (root_thread_id cascade)", async () => {
      const { rootId, childId, grandchildId } = await tree();
      await db.delete(thread).where(eq(thread.id, rootId));
      expect(await rowCount(rootId)).toBe(0);
      expect(await rowCount(childId)).toBe(0);
      expect(await rowCount(grandchildId)).toBe(0);
    });
  });
});
