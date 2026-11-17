import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { agentMessages, thread, threadChat } from "@terragon/shared/db/schema";
import {
  createChildRun,
  ensureRootRun,
  markBlocked,
} from "@terragon/shared/model/agent-bus/agent-run";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import { insertMessage } from "@terragon/shared/model/agent-bus/messages";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { kickTarget, runAgentBusSweep, sendAgentMessage } from "./delivery";

const h = vi.hoisted(() => ({
  kick: vi.fn(),
  tier: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock("../process-follow-up-queue", () => ({
  maybeProcessFollowUpQueue: h.kick,
}));
vi.mock("@terragon/shared/broadcast-server", () => ({
  publishBroadcastUserMessage: h.broadcast,
}));
vi.mock("@/lib/subscription", () => ({
  getAccessInfoForUser: h.tier,
}));

/** A root run with one review child, both in one org; the child is the target. */
async function pair({ legacy = false }: { legacy?: boolean } = {}) {
  const organizationId = await createTestOrg({ db });
  const { user } = await createTestUser({ db });
  const root = await createTestThread({
    db,
    userId: user.id,
    overrides: { organizationId },
    enableThreadChatCreation: true,
  });
  await ensureRootRun({
    db,
    threadId: root.threadId,
    organizationId,
    lane: "task",
  });
  const child = await createTestThread({
    db,
    userId: user.id,
    overrides: { organizationId, parentThreadId: root.threadId },
    enableThreadChatCreation: !legacy,
  });
  await createChildRun({
    db,
    organizationId,
    parentThreadId: root.threadId,
    childThreadId: child.threadId,
    request: { lane: "task" },
  });
  // A fresh chat is "queued" (working); an idle, non-terminal target is a draft.
  if (legacy) {
    await db
      .update(thread)
      .set({ status: "draft" })
      .where(eq(thread.id, child.threadId));
  } else {
    await db
      .update(threadChat)
      .set({ status: "draft" })
      .where(eq(threadChat.id, child.threadChatId));
  }
  return { organizationId, userId: user.id, root, child };
}

describe("agent-bus delivery", () => {
  beforeEach(() => {
    h.kick.mockReset();
    h.kick.mockResolvedValue(undefined);
    h.tier.mockReset();
    h.tier.mockResolvedValue({ tier: "core" });
    h.broadcast.mockReset();
    h.broadcast.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  describe("kickTarget", () => {
    it("drains the queue of an idle target", async () => {
      const { userId, child } = await pair();
      await kickTarget(child.threadId);
      expect(h.kick).toHaveBeenCalledTimes(1);
      expect(h.kick).toHaveBeenCalledWith({
        userId,
        threadId: child.threadId,
        threadChatId: child.threadChatId,
      });
      expect(h.broadcast).toHaveBeenCalledTimes(1);
    });

    it("a legacy target (no thread_chat) is kicked with the legacy chat id and broadcast", async () => {
      const { userId, child } = await pair({ legacy: true });
      await kickTarget(child.threadId);
      expect(h.broadcast).toHaveBeenCalledWith({
        type: "user",
        id: userId,
        data: { threadId: child.threadId, threadChatId: LEGACY_THREAD_CHAT_ID },
      });
      expect(h.kick).toHaveBeenCalledWith({
        userId,
        threadId: child.threadId,
        threadChatId: LEGACY_THREAD_CHAT_ID,
      });
    });

    it("skips a terminal target but still broadcasts", async () => {
      const { child } = await pair();
      await db
        .update(threadChat)
        .set({ status: "complete" })
        .where(eq(threadChat.id, child.threadChatId));
      await db
        .update(thread)
        .set({ status: "complete" })
        .where(eq(thread.id, child.threadId));
      await kickTarget(child.threadId);
      expect(h.kick).not.toHaveBeenCalled();
      expect(h.broadcast).toHaveBeenCalledTimes(1);
    });

    it("skips on tier none", async () => {
      const { child } = await pair();
      h.tier.mockResolvedValue({ tier: "none" });
      await kickTarget(child.threadId);
      expect(h.kick).not.toHaveBeenCalled();
      expect(h.broadcast).toHaveBeenCalledTimes(1);
    });

    it("skips a shadow thread", async () => {
      const { child } = await pair();
      await db
        .update(thread)
        .set({ shadow: true })
        .where(eq(thread.id, child.threadId));
      await kickTarget(child.threadId);
      expect(h.kick).not.toHaveBeenCalled();
      expect(h.broadcast).toHaveBeenCalledTimes(1);
    });

    it("skips while the agent is working", async () => {
      const { child } = await pair();
      await db
        .update(threadChat)
        .set({ status: "working" })
        .where(eq(threadChat.id, child.threadChatId));
      await kickTarget(child.threadId);
      expect(h.kick).not.toHaveBeenCalled();
      expect(h.broadcast).toHaveBeenCalledTimes(1);
    });

    it("skips a blocked run", async () => {
      const { organizationId, child } = await pair();
      await markBlocked({
        db,
        organizationId,
        threadId: child.threadId,
        reason: "test",
      });
      await kickTarget(child.threadId);
      expect(h.kick).not.toHaveBeenCalled();
      expect(h.broadcast).toHaveBeenCalledTimes(1);
    });

    it("swallows a kick error", async () => {
      const { child } = await pair();
      h.kick.mockRejectedValue(new Error("boom"));
      await expect(kickTarget(child.threadId)).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe("sendAgentMessage", () => {
    it("applies, then kicks the target", async () => {
      const { organizationId, root, child } = await pair();
      const result = await sendAgentMessage({
        organizationId,
        from: root.threadId,
        to: child.threadId,
        key: "k1",
        body: "hello",
      });
      expect(result).toMatchObject({ ok: true, applied: 1 });
      expect(h.kick).toHaveBeenCalledTimes(1);
    });

    it("still resolves ok when the kick throws", async () => {
      const { organizationId, root, child } = await pair();
      h.kick.mockRejectedValue(new Error("boom"));
      const result = await sendAgentMessage({
        organizationId,
        from: root.threadId,
        to: child.threadId,
        key: "k2",
        body: "hello",
      });
      expect(result).toMatchObject({ ok: true, applied: 1 });
    });
  });

  describe("runAgentBusSweep", () => {
    it("kicks swept and recently delivered targets once each", async () => {
      const { organizationId, root, child } = await pair();
      // Delivered just now (a recent target) ...
      await sendAgentMessage({
        organizationId,
        from: root.threadId,
        to: child.threadId,
        key: "recent",
        body: "one",
      });
      // ... and a message whose receive never ran, older than the sweep cutoff.
      const inserted = await insertMessage({
        db,
        from: root.threadId,
        to: child.threadId,
        key: "stranded",
        body: "two",
      });
      if ("conflict" in inserted) throw new Error("unexpected conflict");
      await db
        .update(agentMessages)
        .set({ createdAt: new Date(Date.now() - 60_000) })
        .where(eq(agentMessages.id, inserted.id));
      h.kick.mockClear();

      await runAgentBusSweep();

      // The kick set is recentlyDeliveredTargets (swept targets are a subset).
      // The sweep is global (other tests' targets are recent too): every
      // target is kicked once, and ours, both swept and recent, exactly once.
      const kicked = (h.kick.mock.calls as [{ threadId: string }][]).map(
        ([arg]) => arg.threadId,
      );
      expect(new Set(kicked).size).toBe(kicked.length);
      expect(kicked.filter((id: string) => id === child.threadId)).toHaveLength(
        1,
      );
      const [row] = await db
        .select({ consumedAt: agentMessages.consumedAt })
        .from(agentMessages)
        .where(eq(agentMessages.id, inserted.id));
      expect(row?.consumedAt).not.toBeNull();
    });
  });
});
