import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestOrg,
  createTestRemoteRun,
} from "@terragon/shared/model/test-helpers";
import { findOrphanRemoteThreads } from "@terragon/shared/model/threads";
import type { AgentRunStatus } from "@/agent/hatchet/transport";
import { runSupersedeSweep } from "./supersede-sweep";
import { replyToMentionsAtTerminal } from "./review/mention-terminal-reply";

/**
 * #668: the sweep answers the mentions of the threads it ended, once per
 * tick and from a `finally`.
 *
 * protects: a terminal an earlier rule already wrote is answered even when a
 *   later rule throws (the thread is terminal now; no later tick would pick
 *   it up), and a silent cause (a person's stop) is never handed over.
 * fails_when: the reply moves back after the rules without a `finally`, or
 *   the silent-cause filter is dropped.
 * no_claim: the writer itself (mention-reply-finish suite) and the rules'
 *   own decisions (supersede-sweep suite).
 */

vi.mock("./supersede-recheck", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  maybeRecheckOnComplete: vi
    .fn()
    .mockResolvedValue({ rechecked: false, reason: "test" }),
}));
vi.mock("./review/mention-terminal-reply", () => ({
  replyToMentionsAtTerminal: vi.fn(async () => undefined),
}));
// Fault injection on rule (ii)'s read; everything else is the real module.
vi.mock("@terragon/shared/model/threads", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    findOrphanRemoteThreads: vi.fn(
      actual.findOrphanRemoteThreads as (...a: unknown[]) => Promise<unknown>,
    ),
  };
});

describe("supersede sweep — mention replies (#668)", () => {
  const T = 10 * 60 * 1000;
  const N = 15 * 60 * 1000;
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    userId = (await createTestUser({ db })).user.id;
    orgId = await createTestOrg({ db });
  });

  it("rule (ii) throws after rule (i) wrote terminals → the written failure is still answered, the person's stop is not", async () => {
    const failed = await createTestRemoteRun({
      db,
      userId,
      organizationId: orgId,
      prNumber: 6681,
      externalId: "r-668-failed",
      ageMs: T + 60_000,
    });
    const stopped = await createTestRemoteRun({
      db,
      userId,
      organizationId: orgId,
      prNumber: 6682,
      externalId: "r-668-stopped",
      ageMs: T + 60_000,
    });
    vi.mocked(findOrphanRemoteThreads).mockRejectedValueOnce(
      new Error("db down"),
    );
    const status: Record<string, AgentRunStatus> = {
      "r-668-failed": "FAILED",
      "r-668-stopped": "CANCELLED",
    };

    await expect(
      runSupersedeSweep({
        cancelledAfterMs: T,
        orphanAfterMs: N,
        readStatus: async (id) => status[id] ?? "RUNNING",
        listRuns: async () => [],
      }),
    ).rejects.toThrow("db down");

    expect(replyToMentionsAtTerminal).toHaveBeenCalledTimes(1);
    const targets = vi
      .mocked(replyToMentionsAtTerminal)
      .mock.calls[0]![0].map((t) => t.threadId);
    expect(targets).toContain(failed.threadId);
    expect(targets).not.toContain(stopped.threadId);
  });

  it("a clean tick hands over every non-silent terminal once", async () => {
    const failed = await createTestRemoteRun({
      db,
      userId,
      organizationId: orgId,
      prNumber: 6683,
      externalId: "r-668-clean",
      ageMs: T + 60_000,
    });
    const report = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus: async (id) => (id === "r-668-clean" ? "FAILED" : "RUNNING"),
      listRuns: async () => [],
    });
    expect(report.terminals).toContainEqual({
      threadId: failed.threadId,
      cause: "daemon-failed",
    });
    expect(replyToMentionsAtTerminal).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(replyToMentionsAtTerminal).mock.calls[0]![0],
    ).toContainEqual({ threadId: failed.threadId });
  });
});
