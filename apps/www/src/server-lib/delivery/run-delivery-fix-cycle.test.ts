import type { Octokit } from "octokit";
import { nanoid } from "nanoid";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import {
  enrollDeliveryPr,
  getDeliveryPr,
  listDeliveryFixCycles,
  transitionDeliveryPr,
  type DeliveryPullRequestRow,
} from "@terragon/shared/model/delivery-loop";
import {
  createTestAutomation,
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { runDeliveryFixCycle } from "./run-delivery-fix-cycle";

const NOW = new Date("2026-10-26T12:00:00Z");

const octokit = {
  rest: {
    pulls: {
      getReview: async () => ({ data: { body: "Fix the null check." } }),
      listCommentsForReview: async () => ({
        data: [{ path: "src/x.ts", line: 7, body: "here" }],
      }),
    },
    checks: {
      listForRef: async () => ({
        data: {
          check_runs: [
            { name: "test", output: { title: "1 failed", summary: "x" } },
          ],
        },
      }),
    },
  },
} as unknown as Octokit;

describe("#509 runDeliveryFixCycle", () => {
  let row: DeliveryPullRequestRow;
  let userId: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    const organizationId = await createTestOrg({ db });
    const repoFullName = `acme/widgets-${nanoid(6)}`;
    const automationId = (
      await createTestAutomation({
        db,
        userId,
        values: { triggerType: "issue", repoFullName },
      })
    ).id;
    const threadId = (await createTestThread({ db, userId })).threadId;
    const { row: enrolled } = await enrollDeliveryPr(db, {
      organizationId,
      repoFullName,
      prNumber: 12,
      issueNumber: 4,
      headRef: "automata/task-abcd1234",
      baseRef: "main",
      headSha: "H1",
      deliveryThreadId: threadId,
      automationId,
      now: NOW,
    });
    await transitionDeliveryPr(db, {
      id: enrolled.id,
      expectedPhase: "awaiting_ci",
      expectedHeadSha: "H1",
      patch: { phase: "awaiting_review" },
    });
    row = (await getDeliveryPr(db, enrolled.id))!; // updated one line above
  });

  const run = (runAutomation: ReturnType<typeof vi.fn>) =>
    runDeliveryFixCycle({
      db,
      octokit,
      row,
      headSha: "H1",
      trigger: "review+ci",
      reviewId: 9,
      failingChecks: ["test"],
      conflicting: false,
      deps: { runAutomation, now: () => NOW },
    });

  it("dispatches the issue-delivery automation on the PR head, stamped, without an issue number", async () => {
    const cycleThread = (await createTestThread({ db, userId })).threadId;
    const runAutomation = vi.fn(async () => ({
      threadId: cycleThread,
      threadChatId: "c",
    }));
    const outcome = await run(runAutomation);
    expect(outcome).toMatchObject({
      status: "dispatched",
      threadId: cycleThread,
    });
    const call = (runAutomation.mock.calls as unknown[][])[0]?.[0] as {
      userId: string;
      automationId: string;
      source: string;
      options: Record<string, unknown> & {
        transformMessage: (m: unknown) => { parts: { text: string }[] };
      };
    };
    expect(call).toMatchObject({
      userId,
      automationId: row.automationId,
      source: "automated",
    });
    expect(call.options).toMatchObject({
      branchName: "automata/task-abcd1234",
      prBaseBranchName: "main",
      prNumber: 12,
      stampExtra: {
        delivery: {
          deliveryPrId: row.id,
          cycleNo: 1,
          headSha: "H1",
          issueNumber: 4,
        },
      },
    });
    expect(call.options).not.toHaveProperty("issueNumber");
    expect(call.options).not.toHaveProperty("headSha");
    const prompt = call.options
      .transformMessage({
        type: "user",
        model: null,
        parts: [],
        timestamp: "t",
      })
      .parts.map((p) => p.text)
      .join("\n");
    expect(prompt).toContain("cycle 1/3");
    expect(prompt).toContain("Fix the null check.");
    expect(prompt).toContain("`src/x.ts:7`");
    expect(prompt).toContain("**test**");
    expect(await listDeliveryFixCycles(db, row.id)).toMatchObject([
      { state: "running", threadId: cycleThread, trigger: "review+ci" },
    ]);
    expect(await getDeliveryPr(db, row.id)).toMatchObject({
      phase: "fixing",
      cyclesUsed: 1,
    });
  });

  it("a thread that fails to start is abandoned and refunded, and the PR goes back to its phase", async () => {
    const outcome = await run(
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    expect(outcome).toEqual({ status: "abandoned", reason: "boom" });
    expect(await getDeliveryPr(db, row.id)).toMatchObject({
      phase: "awaiting_review",
      cyclesUsed: 0,
    });
    expect((await listDeliveryFixCycles(db, row.id))[0]?.state).toBe(
      "abandoned",
    );
  });

  it("a second trigger at the same head starts nothing", async () => {
    const cycleThread = (await createTestThread({ db, userId })).threadId;
    const runAutomation = vi.fn(async () => ({
      threadId: cycleThread,
      threadChatId: "c",
    }));
    await run(runAutomation);
    row = (await getDeliveryPr(db, row.id))!; // exists: enrolled in beforeEach
    expect(await run(runAutomation)).toMatchObject({
      status: "not_started",
      reason: "duplicate",
    });
    expect(runAutomation).toHaveBeenCalledTimes(1);
  });

  it("once the thread exists a failed bind refunds nothing: the cycle stays in flight", async () => {
    // A thread id that does not exist makes the bind's FK fail (it throws).
    const runAutomation = vi.fn(async () => ({
      threadId: "no-such-thread",
      threadChatId: "c",
    }));
    expect(await run(runAutomation)).toMatchObject({
      status: "dispatched",
      threadId: "no-such-thread",
    });
    expect(await getDeliveryPr(db, row.id)).toMatchObject({
      phase: "fixing",
      cyclesUsed: 1,
    });
    expect((await listDeliveryFixCycles(db, row.id))[0]).toMatchObject({
      state: "dispatching",
      threadId: null,
    });
  });

  it("an abandoned dispatch can be retried at the same head", async () => {
    await run(
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    row = (await getDeliveryPr(db, row.id))!; // exists: enrolled in beforeEach
    const cycleThread = (await createTestThread({ db, userId })).threadId;
    expect(
      await run(
        vi.fn(async () => ({ threadId: cycleThread, threadChatId: "c" })),
      ),
    ).toMatchObject({ status: "dispatched", threadId: cycleThread });
    expect(await listDeliveryFixCycles(db, row.id)).toMatchObject([
      { state: "running", threadId: cycleThread },
    ]);
  });
});
