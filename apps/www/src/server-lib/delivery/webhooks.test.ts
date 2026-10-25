import { nanoid } from "nanoid";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import {
  enrollDeliveryPr,
  transitionDeliveryPr,
} from "@terragon/shared/model/delivery-loop";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { runDeliveryLoopSweep } from "./delivery-cron";
import {
  handleDeliveryCiEvent,
  handleDeliveryPullRequestEvent,
  handleDeliveryReviewEvent,
} from "./webhooks";

const BOT = "automata-ai-bot[bot]";
const BRANCH = "automata/task-abcd1234";

describe("#509 delivery-loop webhooks and sweep", () => {
  let repo: string;
  let deliveryPrId: string;

  beforeEach(async () => {
    const userId = (await createTestUser({ db })).user.id;
    const organizationId = await createTestOrg({ db });
    const threadId = (await createTestThread({ db, userId })).threadId;
    repo = `Acme/Widgets-${nanoid(6)}`;
    deliveryPrId = (
      await enrollDeliveryPr(db, {
        organizationId,
        repoFullName: repo,
        prNumber: 12,
        issueNumber: 4,
        headRef: BRANCH,
        baseRef: "main",
        headSha: null,
        deliveryThreadId: threadId,
        automationId: "auto-1",
        now: new Date(),
      })
    ).row.id;
  });

  function deps() {
    const evaluate = vi.fn(async () => undefined);
    const scheduled: Promise<unknown>[] = [];
    return {
      evaluate,
      scheduled,
      overrides: {
        db,
        evaluate,
        schedule: (p: Promise<unknown>) => {
          scheduled.push(p);
        },
        botLogin: () => BOT,
      },
    };
  }

  const repository = () => ({ full_name: repo });

  it("a CI completion on the delivery branch evaluates the row (matched by branch, before any head is recorded)", async () => {
    for (const payload of [
      {
        repository: repository(),
        check_suite: { head_branch: BRANCH, head_sha: "H" },
      },
      {
        repository: repository(),
        workflow_run: { head_branch: BRANCH, head_sha: "H" },
      },
    ]) {
      const d = deps();
      await handleDeliveryCiEvent(payload, d.overrides);
      expect(d.evaluate).toHaveBeenCalledWith({ deliveryPrId });
    }
  });

  it("events on other branches or repos cost no evaluation", async () => {
    const d = deps();
    await handleDeliveryCiEvent(
      {
        repository: repository(),
        check_suite: { head_branch: "main", head_sha: "H" },
      },
      d.overrides,
    );
    await handleDeliveryCiEvent(
      {
        repository: { full_name: "other/repo" },
        check_suite: { head_branch: BRANCH, head_sha: "H" },
      },
      d.overrides,
    );
    await handleDeliveryCiEvent(null, d.overrides);
    expect(d.evaluate).not.toHaveBeenCalled();
  });

  it("only the bot's review moves the loop", async () => {
    const event = (login: string) => ({
      repository: repository(),
      review: { user: { login } },
      pull_request: { number: 12, head: { ref: BRANCH } },
    });
    const human = deps();
    await handleDeliveryReviewEvent(event("alice"), human.overrides);
    expect(human.evaluate).not.toHaveBeenCalled();
    const bot = deps();
    await handleDeliveryReviewEvent(
      event("Automata-AI-Bot[bot]"),
      bot.overrides,
    );
    expect(bot.evaluate).toHaveBeenCalledWith({ deliveryPrId });
  });

  it("a PR event on an enrolled PR evaluates it; a terminal row is not matched", async () => {
    const event = {
      repository: repository(),
      pull_request: { number: 12, head: { ref: BRANCH } },
    };
    const d = deps();
    await handleDeliveryPullRequestEvent(event, d.overrides);
    expect(d.evaluate).toHaveBeenCalledTimes(1);
    await transitionDeliveryPr(db, {
      id: deliveryPrId,
      expectedPhase: "awaiting_ci",
      expectedHeadSha: null,
      patch: { phase: "closed" },
    });
    const after = deps();
    await handleDeliveryPullRequestEvent(event, after.overrides);
    expect(after.evaluate).not.toHaveBeenCalled();
  });

  it("a lookup failure is logged, never thrown", async () => {
    const d = deps();
    const broken = {
      ...d.overrides,
      db: {
        select: () => {
          throw new Error("db down");
        },
      } as unknown as typeof db,
    };
    await expect(
      handleDeliveryPullRequestEvent(
        {
          repository: repository(),
          pull_request: { number: 12, head: { ref: BRANCH } },
        },
        broken,
      ),
    ).resolves.toBeUndefined();
  });

  it("the sweep evaluates open rows", async () => {
    const evaluate = vi.fn(async () => ({
      status: "skipped" as const,
      reason: "leased" as const,
    }));
    const { evaluated } = await runDeliveryLoopSweep({
      db,
      evaluate,
      limit: 500,
    });
    expect(evaluated).toBeGreaterThanOrEqual(1);
    expect(evaluate).toHaveBeenCalledWith({ deliveryPrId });
  });
});
