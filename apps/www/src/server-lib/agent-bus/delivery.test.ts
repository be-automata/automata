import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { waitUntil } from "@/lib/wait-until";
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

async function backdateCreated(ids: number[], ms: number): Promise<void> {
  await db
    .update(agentMessages)
    .set({ createdAt: new Date(Date.now() - ms) })
    .where(inArray(agentMessages.id, ids));
}

describe("agent-bus delivery", () => {
  beforeEach(() => {
    vi.mocked(waitUntil).mockClear();
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

    type Pair = Awaited<ReturnType<typeof pair>>;
    it.each<[string, (p: Pair) => Promise<void>]>([
      [
        "a terminal target",
        async ({ child }) => {
          await db
            .update(threadChat)
            .set({ status: "complete" })
            .where(eq(threadChat.id, child.threadChatId));
          await db
            .update(thread)
            .set({ status: "complete" })
            .where(eq(thread.id, child.threadId));
        },
      ],
      [
        "tier none",
        async () => {
          h.tier.mockResolvedValue({ tier: "none" });
        },
      ],
      [
        "a shadow thread",
        async ({ child }) => {
          await db
            .update(thread)
            .set({ shadow: true })
            .where(eq(thread.id, child.threadId));
        },
      ],
      [
        "a working agent",
        async ({ child }) => {
          await db
            .update(threadChat)
            .set({ status: "working" })
            .where(eq(threadChat.id, child.threadChatId));
        },
      ],
      [
        "a blocked run",
        async ({ organizationId, child }) => {
          await markBlocked({
            db,
            organizationId,
            threadId: child.threadId,
            reason: "test",
          });
        },
      ],
    ])("skips %s but still broadcasts", async (_name, arrange) => {
      const fixture = await pair();
      await arrange(fixture);
      await kickTarget(fixture.child.threadId);
      expect(h.kick).not.toHaveBeenCalled();
      expect(h.broadcast).toHaveBeenCalledTimes(1);
    });

    it("swallows a kick error", async () => {
      const { child } = await pair();
      h.kick.mockRejectedValue(new Error("boom"));
      await expect(kickTarget(child.threadId)).resolves.toBeUndefined();
      await vi.waitFor(() =>
        expect(console.error).toHaveBeenCalledWith(
          "[agent-bus] drain failed (non-fatal)",
          expect.anything(),
        ),
      );
    });

    it("still drains when the broadcast fails", async () => {
      const { child } = await pair();
      h.broadcast.mockRejectedValue(new Error("broadcast down"));
      await expect(kickTarget(child.threadId)).resolves.toBeUndefined();
      expect(h.kick).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(
        "[agent-bus] broadcast failed (non-fatal)",
        expect.anything(),
      );
    });

    it("does not wait for the drain (it can boot a sandbox)", async () => {
      const { child } = await pair();
      h.kick.mockReturnValue(new Promise(() => undefined));
      await expect(kickTarget(child.threadId)).resolves.toBeUndefined();
      expect(h.kick).toHaveBeenCalledTimes(1);
      expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
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

    it("resolves before the target's agent has started", async () => {
      const { organizationId, root, child } = await pair();
      h.kick.mockReturnValue(new Promise(() => undefined));
      const result = await sendAgentMessage({
        organizationId,
        from: root.threadId,
        to: child.threadId,
        key: "k3",
        body: "hello",
      });
      expect(result).toMatchObject({ ok: true, applied: 1 });
      expect(h.kick).toHaveBeenCalledTimes(1);
      expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
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
      await backdateCreated([inserted.id], 60_000);
      h.kick.mockClear();
      h.broadcast.mockClear();

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
      // This sweep applied to the child, so it is broadcast once.
      expect(broadcastsFor(child.threadId)).toBe(1);
    });

    it("re-kicks a recently delivered target without broadcasting again", async () => {
      const { organizationId, root, child } = await pair();
      await sendAgentMessage({
        organizationId,
        from: root.threadId,
        to: child.threadId,
        key: "already-broadcast",
        body: "one",
      });
      h.kick.mockClear();
      h.broadcast.mockClear();

      await runAgentBusSweep();

      const kicked = (h.kick.mock.calls as [{ threadId: string }][]).map(
        ([arg]) => arg.threadId,
      );
      expect(kicked.filter((id: string) => id === child.threadId)).toHaveLength(
        1,
      );
      expect(broadcastsFor(child.threadId)).toBe(0);
    });
    it("kicks in parallel batches of at most 10", async () => {
      const pairs = await Promise.all(Array.from({ length: 12 }, () => pair()));
      await Promise.all(
        pairs.map(({ organizationId, root, child }, i) =>
          sendAgentMessage({
            organizationId,
            from: root.threadId,
            to: child.threadId,
            key: `batch-${i}`,
            body: "one",
          }),
        ),
      );
      let inFlight = 0;
      let maxInFlight = 0;
      h.tier.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return { tier: "core" };
      });
      h.kick.mockClear();

      await runAgentBusSweep();

      const ours = new Set(pairs.map(({ child }) => child.threadId));
      const kicked = (h.kick.mock.calls as [{ threadId: string }][])
        .map(([arg]) => arg.threadId)
        .filter((id) => ours.has(id));
      expect(new Set(kicked).size).toBe(12);
      expect(maxInFlight).toBeGreaterThan(1);
      expect(maxInFlight).toBeLessThanOrEqual(10);
    });
  });
});

function broadcastsFor(threadId: string): number {
  return (h.broadcast.mock.calls as [{ data: { threadId: string } }][]).filter(
    ([arg]) => arg.data.threadId === threadId,
  ).length;
}
