import { nanoid } from "nanoid";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import type { ThreadSourceMetadata } from "@terragon/shared";
import {
  findDeliveryPr,
  listDeliveryPrsForSweep,
} from "@terragon/shared/model/delivery-loop";
import {
  createTestAutomation,
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { enrollDeliveryAtPrOpen } from "./enroll";

const NOW = new Date("2026-10-26T12:00:00Z");

const deliveryStamp: ThreadSourceMetadata = {
  type: "automation-skill",
  skillName: "issue-delivery",
  contentSha: "sha",
  source: "db-version",
};

describe("#509 enrollDeliveryAtPrOpen", () => {
  let userId: string;
  let organizationId: string;
  let automationId: string;
  let repoFullName: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    organizationId = await createTestOrg({ db });
    repoFullName = `Acme/Widgets-${nanoid(6)}`;
    automationId = (
      await createTestAutomation({
        db,
        userId,
        values: { triggerType: "issue", repoFullName },
      })
    ).id;
  });

  async function thread(
    sourceMetadata: ThreadSourceMetadata | null,
    over: Record<string, unknown> = {},
  ) {
    return (
      await createTestThread({
        db,
        userId,
        overrides: {
          organizationId,
          automationId,
          githubRepoFullName: repoFullName,
          githubIssueNumber: 4,
          sourceMetadata,
          ...over,
        },
      })
    ).threadId;
  }

  function enroll(threadId: string, mode: "off" | "shadow" | "on" = "shadow") {
    const evaluate = vi.fn(async () => ({
      status: "skipped" as const,
      reason: "leased" as const,
    }));
    return {
      evaluate,
      result: enrollDeliveryAtPrOpen({
        userId,
        threadId,
        prNumber: 31,
        db,
        evaluate,
        loadMode: async () => mode,
        now: () => NOW,
      }),
    };
  }

  it("enrolls an issue-delivery PR once on its work branch and evaluates it", async () => {
    const threadId = await thread(deliveryStamp);
    const first = enroll(threadId);
    expect(await first.result).toMatchObject({
      status: "enrolled",
      created: true,
    });
    expect(first.evaluate).toHaveBeenCalledTimes(1);
    const row = await findDeliveryPr(db, {
      organizationId,
      repoFullName,
      prNumber: 31,
    });
    expect(row).toMatchObject({
      repoFullName: repoFullName.toLowerCase(),
      issueNumber: 4,
      headRef: `automata/task-${threadId.slice(0, 8).toLowerCase()}`,
      baseRef: "main",
      headSha: null,
      deliveryThreadId: threadId,
      automationId,
      phase: "awaiting_ci",
    });
    expect(await enroll(threadId).result).toMatchObject({
      status: "enrolled",
      created: false,
    });
  });

  it("skips anything that is not an issue-delivery run, and fix-cycle threads", async () => {
    for (const stamp of [
      null,
      { ...deliveryStamp, skillName: "audit-fix" },
      {
        ...deliveryStamp,
        delivery: {
          deliveryPrId: "x",
          cycleNo: 1,
          headSha: "H",
          issueNumber: 4,
        },
      },
    ] as const) {
      const { result, evaluate } = enroll(await thread(stamp));
      expect(await result).toEqual({
        status: "skipped",
        reason: "not_delivery",
      });
      expect(evaluate).not.toHaveBeenCalled();
    }
  });

  it("skips when the loop is off for the repo, or the thread lacks an issue", async () => {
    expect(await enroll(await thread(deliveryStamp), "off").result).toEqual({
      status: "skipped",
      reason: "mode_off",
    });
    expect(
      await enroll(await thread(deliveryStamp, { githubIssueNumber: null }))
        .result,
    ).toEqual({ status: "skipped", reason: "no_issue" });
    expect(
      (await listDeliveryPrsForSweep(db, 500)).filter(
        (r) => r.organizationId === organizationId,
      ),
    ).toEqual([]);
  });
});
