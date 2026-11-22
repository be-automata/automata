import { beforeEach, describe, expect, it, vi } from "vitest";
import { maybeProcessFollowUpQueue } from "@/server-lib/process-follow-up-queue";
import { getThreadChat } from "@terragon/shared/model/threads";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { thread as threadTable } from "@terragon/shared/db/schema";
import {
  seedFeatureFlags,
  setUserFeatureFlagOverride,
} from "@terragon/shared/model/feature-flags";
import { advanceCellSessionHead } from "@terragon/shared/model/cell-session-checkpoint";
import {
  claimContinuation,
  countContinuations,
  getContinuationBySourceRun,
} from "@terragon/shared/model/cell-session-continuation";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import {
  maybeContinueAfterTimeout,
  renderContinuationMessage,
  type ContinuationDeps,
  type ContinuationInput,
} from "./continuation";

vi.mock("@/server-lib/process-follow-up-queue", () => ({
  maybeProcessFollowUpQueue: vi.fn(),
}));

async function ownerOf(threadId: string): Promise<string> {
  const [row] = await db
    .select({ userId: threadTable.userId })
    .from(threadTable)
    .where(eq(threadTable.id, threadId));
  if (!row) throw new Error("thread not found");
  return row.userId;
}

interface Fixture {
  input: ContinuationInput;
  deps: ContinuationDeps;
  queued: unknown[];
  logs: string[];
}

async function setup({
  head = { turn: 4 } as { turn: number; run?: string } | null,
  terminal = true,
}: {
  head?: { turn: number; run?: string } | null;
  terminal?: boolean;
} = {}): Promise<Fixture> {
  const RUN = `run-${nanoid(8)}`;
  const { user } = await createTestUser({ db });
  const { threadId, threadChatId } = await createTestThread({
    db,
    userId: user.id,
    overrides: { branchName: "work/branch" },
  });
  await db
    .update(threadTable)
    .set({
      activeRunExternalId: RUN,
      terminalCause: terminal ? "timeout" : null,
    })
    .where(eq(threadTable.id, threadId));
  if (head) {
    await advanceCellSessionHead({
      db,
      threadId,
      threadChatId,
      expectedVersion: 0,
      move: {
        sessionId: "s",
        headManifestId: "manifest-1",
        headTurn: head.turn,
        nativeBytes: 10,
        callIndexSha256: null,
        lastRunExternalId: head.run ?? RUN,
      },
    });
  }
  const queued: unknown[] = [];
  const logs: string[] = [];
  const deps: ContinuationDeps = {
    db,
    isEnabled: async () => true,
    readThread: async () => ({
      userId: user.id,
      shadow: false,
      archived: false,
      activeRunExternalId: RUN,
      terminalCause: terminal ? "timeout" : null,
      branch: "work/branch",
    }),
    queueWrite: async ({ message }) => {
      queued.push(message);
      return true;
    },
    drain: async () => {},
    log: (m) => logs.push(m),
  };
  return {
    input: {
      threadId,
      threadChatId,
      runExternalId: RUN,
      cause: "timeout",
      lane: "task",
    },
    deps,
    queued,
    logs,
  };
}

describe("maybeContinueAfterTimeout (#743 phase 9)", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await setup();
  });

  it("continues an eligible first timeout and names the turn and branch", async () => {
    const res = await maybeContinueAfterTimeout(f.input, f.deps);
    expect(res).toEqual({ action: "continue", turn: 4, ordinal: 1 });
    expect(f.queued).toHaveLength(1);
    expect(JSON.stringify(f.queued[0])).toContain("after 4 completed turns");
    expect(JSON.stringify(f.queued[0])).toContain("`work/branch`");
    const row = await getContinuationBySourceRun({
      db,
      sourceRunExternalId: f.input.runExternalId,
    });
    expect(row?.state).toBe("dispatched");
    expect(row?.checkpointManifestId).toBe("manifest-1");
    expect(f.logs.join("\n")).toContain("continuation: dispatched (ordinal 1)");
  });

  it("the flag off for the owner is flag-off: nothing is claimed or queued", async () => {
    const calls: string[] = [];
    const res = await maybeContinueAfterTimeout(f.input, {
      ...f.deps,
      isEnabled: async ({ userId }) => {
        calls.push(userId);
        return false;
      },
    });
    expect(res).toEqual({ action: "none", reason: "flag-off" });
    expect(calls).toHaveLength(1);
    expect(f.queued).toHaveLength(0);
    expect(await countContinuations({ db, threadId: f.input.threadId })).toBe(
      0,
    );
    expect(f.logs.join("\n")).toContain("continuation: none (flag-off)");
  });

  it("a cause other than timeout is not-timeout", async () => {
    expect(
      await maybeContinueAfterTimeout(
        { ...f.input, cause: "daemon-failed" },
        f.deps,
      ),
    ).toEqual({ action: "none", reason: "not-timeout" });
    expect(f.queued).toHaveLength(0);
  });

  it.each(["review", "pr", "self-heal-audit", "self-heal-fix"] as const)(
    "the %s lane is excluded",
    async (lane) => {
      expect(
        await maybeContinueAfterTimeout({ ...f.input, lane }, f.deps),
      ).toEqual({ action: "none", reason: "lane" });
      expect(f.queued).toHaveLength(0);
    },
  );

  it("a run with no checkpoint row (not a cell run) is no-checkpoint, and nothing is queued", async () => {
    const g = await setup({ head: null });
    expect(await maybeContinueAfterTimeout(g.input, g.deps)).toEqual({
      action: "none",
      reason: "no-checkpoint",
    });
    expect(g.queued).toHaveLength(0);
    expect(g.logs.join("\n")).toContain("continuation: none (no-checkpoint)");
    expect(await countContinuations({ db, threadId: g.input.threadId })).toBe(
      0,
    );
  });

  it("a checkpoint written by another run, or with no completed turn, is no-checkpoint", async () => {
    const other = await setup({ head: { turn: 3, run: "run-0" } });
    expect(await maybeContinueAfterTimeout(other.input, other.deps)).toEqual({
      action: "none",
      reason: "no-checkpoint",
    });
    const empty = await setup({ head: { turn: 0 } });
    expect(await maybeContinueAfterTimeout(empty.input, empty.deps)).toEqual({
      action: "none",
      reason: "no-checkpoint",
    });
  });

  it("budget-spent beats no-checkpoint (F4): a second timeout with no checkpoint names the limit", async () => {
    const g = await setup({ head: null });
    const earlier = await claimContinuation({
      db,
      threadId: g.input.threadId,
      threadChatId: g.input.threadChatId,
      sourceRunExternalId: `run-earlier-${nanoid(8)}`,
      checkpointManifestId: "m",
      checkpointTurn: 2,
    });
    expect(earlier.claimed).toBe(true);
    expect(await maybeContinueAfterTimeout(g.input, g.deps)).toEqual({
      action: "none",
      reason: "budget-spent",
    });
  });

  it("a thread that moved on (new terminal, other run, archived, gone) is superseded", async () => {
    const base = f.deps.readThread;
    for (const patch of [
      { terminalCause: "user-cancelled" },
      { activeRunExternalId: "run-2" },
      { archived: true },
    ]) {
      const deps: ContinuationDeps = {
        ...f.deps,
        readThread: async (a) => {
          const t = await base(a);
          return t && { ...t, ...patch };
        },
      };
      expect(await maybeContinueAfterTimeout(f.input, deps)).toEqual({
        action: "none",
        reason: "superseded",
      });
    }
    expect(
      await maybeContinueAfterTimeout(f.input, {
        ...f.deps,
        readThread: async () => null,
      }),
    ).toEqual({ action: "none", reason: "superseded" });
    expect(f.queued).toHaveLength(0);
  });

  it("a redelivered call is already-claimed and only one claim exists", async () => {
    expect((await maybeContinueAfterTimeout(f.input, f.deps)).action).toBe(
      "continue",
    );
    expect(await maybeContinueAfterTimeout(f.input, f.deps)).toEqual({
      action: "none",
      reason: "already-claimed",
    });
    expect(f.queued).toHaveLength(1);
    expect(await countContinuations({ db, threadId: f.input.threadId })).toBe(
      1,
    );
  });

  it("two racing calls leave exactly one winner and one queued message", async () => {
    const results = await Promise.all([
      maybeContinueAfterTimeout(f.input, f.deps),
      maybeContinueAfterTimeout(f.input, f.deps),
      maybeContinueAfterTimeout(f.input, f.deps),
    ]);
    expect(results.filter((r) => r.action === "continue")).toHaveLength(1);
    expect(f.queued).toHaveLength(1);
    expect(await countContinuations({ db, threadId: f.input.threadId })).toBe(
      1,
    );
  });

  it("a throw before the queue write releases the claim, and a retry continues (F7)", async () => {
    const failing: ContinuationDeps = {
      ...f.deps,
      queueWrite: vi.fn().mockRejectedValue(new Error("db down")),
    };
    expect(await maybeContinueAfterTimeout(f.input, failing)).toEqual({
      action: "none",
      reason: "error",
    });
    expect(await countContinuations({ db, threadId: f.input.threadId })).toBe(
      0,
    );
    expect((await maybeContinueAfterTimeout(f.input, f.deps)).action).toBe(
      "continue",
    );
  });

  it("a throw after the queue write keeps the claim; the retry is already-claimed (F7)", async () => {
    const failingDrain: ContinuationDeps = {
      ...f.deps,
      drain: vi.fn().mockRejectedValue(new Error("drain failed")),
    };
    expect(
      (await maybeContinueAfterTimeout(f.input, failingDrain)).action,
    ).toBe("continue");
    expect(f.queued).toHaveLength(1);
    expect(
      (
        await getContinuationBySourceRun({
          db,
          sourceRunExternalId: f.input.runExternalId,
        })
      )?.state,
    ).toBe("dispatched");
    expect(f.logs.join("\n")).toContain(
      "continuation: claimed, not dispatched",
    );
    expect(await maybeContinueAfterTimeout(f.input, f.deps)).toEqual({
      action: "none",
      reason: "already-claimed",
    });
    expect(f.queued).toHaveLength(1);
  });

  it("a busy chat is queued but not drained", async () => {
    const drain = vi.fn();
    const res = await maybeContinueAfterTimeout(f.input, {
      ...f.deps,
      drain,
      queueWrite: async () => false,
    });
    expect(res.action).toBe("continue");
    expect(drain).not.toHaveBeenCalled();
  });

  it("a shadow thread is claimed and queued but not drained", async () => {
    const drain = vi.fn();
    const base = f.deps.readThread;
    const res = await maybeContinueAfterTimeout(f.input, {
      ...f.deps,
      drain,
      readThread: async (a) => {
        const t = await base(a);
        return t && { ...t, shadow: true };
      },
    });
    expect(res.action).toBe("continue");
    expect(drain).not.toHaveBeenCalled();
  });

  it("the default dependencies resolve the flag per user: off by default, on with an override", async () => {
    const userId = await ownerOf(f.input.threadId);
    expect(await maybeContinueAfterTimeout(f.input)).toEqual({
      action: "none",
      reason: "flag-off",
    });
    await seedFeatureFlags({ db });
    await setUserFeatureFlagOverride({
      db,
      userId,
      name: "cellSessionContinuation",
      value: true,
    });
    expect((await maybeContinueAfterTimeout(f.input)).action).toBe("continue");
  });

  it("the default dependencies read the thread, queue the message on the chat and drain", async () => {
    await seedFeatureFlags({ db });
    await setUserFeatureFlagOverride({
      db,
      userId: await ownerOf(f.input.threadId),
      name: "cellSessionContinuation",
      value: true,
    });
    await db
      .update(threadTable)
      .set({ status: "complete" })
      .where(eq(threadTable.id, f.input.threadId));
    vi.mocked(maybeProcessFollowUpQueue).mockClear();
    const res = await maybeContinueAfterTimeout(f.input);
    expect(res).toEqual({ action: "continue", turn: 4, ordinal: 1 });
    expect(maybeProcessFollowUpQueue).toHaveBeenCalledTimes(1);
    const chat = await getThreadChat({
      db,
      threadId: f.input.threadId,
      threadChatId: f.input.threadChatId,
      userId: (
        await db
          .select()
          .from(threadTable)
          .where(eq(threadTable.id, f.input.threadId))
      )[0]!.userId,
    });
    expect(JSON.stringify(chat?.queuedMessages)).toContain(
      "Automatic continuation 1 of 1",
    );
    expect(JSON.stringify(chat?.queuedMessages)).toContain("`work/branch`");
  });
});

describe("renderContinuationMessage", () => {
  it("is built from constants, the turn and the branch only", () => {
    const text = renderContinuationMessage({ turn: 7, branch: "b/1" });
    expect(text).toContain("Automatic continuation 1 of 1");
    expect(text).toContain("after 7 completed turns");
    expect(text).toContain("`b/1`");
  });
});
