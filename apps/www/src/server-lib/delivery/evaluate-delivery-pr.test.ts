import type { Octokit } from "octokit";
import { nanoid } from "nanoid";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import {
  acquireDeliveryLease,
  enrollDeliveryPr,
  getDeliveryPr,
  listDeliveryFixCycles,
} from "@terragon/shared/model/delivery-loop";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import type { DeliveryHeadCi } from "./head-ci";
import {
  evaluateDeliveryPr,
  summarizeReviews,
  type EvaluateDeliveryDeps,
} from "./evaluate-delivery-pr";

const BOT = "automata-ai-bot[bot]";
const NOW = new Date("2026-10-26T12:00:00Z");

interface FakePull {
  state: "open" | "closed";
  merged_at: string | null;
  draft: boolean;
  head: { sha: string };
  base: { ref: string };
  user: { type: string };
}

/**
 * A read-only GitHub: only pulls.get and pulls.listReviews exist, so any
 * write the evaluator attempted (graphql mark-ready, a comment) would throw
 * "is not a function" and fail the test.
 */
function fakeOctokit(pull: FakePull, reviews: unknown[] = []): Octokit {
  return {
    rest: {
      pulls: {
        get: vi.fn(async () => ({ data: pull })),
        listReviews: vi.fn(async () => ({ data: reviews })),
      },
    },
  } as unknown as Octokit;
}

const GREEN: DeliveryHeadCi = {
  state: "success",
  gateSource: "all-checks",
  failing: [],
  noCi: false,
};
const RED: DeliveryHeadCi = {
  state: "failure",
  gateSource: "all-checks",
  failing: ["test"],
  noCi: false,
};

describe("#509 evaluateDeliveryPr (shadow)", () => {
  let organizationId: string;
  let threadId: string;
  let deliveryPrId: string;

  beforeEach(async () => {
    const userId = (await createTestUser({ db })).user.id;
    organizationId = await createTestOrg({ db });
    threadId = (await createTestThread({ db, userId })).threadId;
    const { row } = await enrollDeliveryPr(db, {
      organizationId,
      repoFullName: `acme/widgets-${nanoid(6)}`,
      prNumber: 12,
      issueNumber: 4,
      headRef: "automata/task-abcd1234",
      baseRef: "main",
      headSha: null,
      deliveryThreadId: threadId,
      automationId: "auto-1",
      now: NOW,
    });
    deliveryPrId = row.id;
  });

  function deps(
    pull: Partial<FakePull>,
    ci: DeliveryHeadCi,
    over: Partial<EvaluateDeliveryDeps> = {},
  ): Partial<EvaluateDeliveryDeps> {
    const octokit = fakeOctokit({
      state: "open",
      merged_at: null,
      draft: true,
      head: { sha: "H1" },
      base: { ref: "main" },
      user: { type: "User" },
      ...pull,
    });
    return {
      octokitFor: async () => octokit,
      loadMode: async () => "shadow",
      readHeadCi: async () => ci,
      botLogin: () => BOT,
      now: () => NOW,
      ...over,
    };
  }

  it("mode off: GitHub is not read and the loop state is untouched; the row only moves to the back of the sweep", async () => {
    const octokitFor = vi.fn();
    expect(
      await evaluateDeliveryPr({
        deliveryPrId,
        deps: { ...deps({}, GREEN), loadMode: async () => "off", octokitFor },
      }),
    ).toEqual({ status: "skipped", reason: "mode_off" });
    expect(octokitFor).not.toHaveBeenCalled();
    expect(await getDeliveryPr(db, deliveryPrId)).toMatchObject({
      headSha: null,
      phase: "awaiting_ci",
      leaseUntil: null,
      evaluatedAt: NOW,
    });
  });

  it("a fresh enrollment observes the head, then records the mark-ready it would do, with no GitHub write", async () => {
    const outcome = await evaluateDeliveryPr({
      deliveryPrId,
      deps: deps({}, GREEN),
    });
    expect(outcome).toMatchObject({
      status: "evaluated",
      steps: [
        { kind: "observe_head", headSha: "H1", phase: "awaiting_ci" },
        { kind: "mark_ready", noCi: false },
      ],
    });
    expect(await getDeliveryPr(db, deliveryPrId)).toMatchObject({
      phase: "awaiting_ci",
      headSha: "H1",
      headSeenAt: NOW,
      readyMarkedHeadSha: null,
      lastReason: "shadow: would mark ready",
      leaseUntil: null,
      evaluatedAt: NOW,
    });
  });

  it("red CI records one shadow cycle per head and spends nothing, however often it is evaluated", async () => {
    for (let i = 0; i < 3; i++) {
      await evaluateDeliveryPr({ deliveryPrId, deps: deps({}, RED) });
    }
    const cycles = await listDeliveryFixCycles(db, deliveryPrId);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({
      state: "shadow",
      trigger: "ci",
      triggerHeadSha: "H1",
      failingChecks: ["test"],
    });
    expect(await getDeliveryPr(db, deliveryPrId)).toMatchObject({
      phase: "awaiting_ci",
      cyclesUsed: 0,
    });
  });

  it("a merged PR closes the row", async () => {
    await evaluateDeliveryPr({ deliveryPrId, deps: deps({}, GREEN) });
    const outcome = await evaluateDeliveryPr({
      deliveryPrId,
      deps: deps({ state: "closed", merged_at: "2026-10-26T11:59:00Z" }, GREEN),
    });
    expect(outcome).toMatchObject({
      steps: [{ kind: "close", phase: "merged" }, { kind: "noop" }],
    });
    expect((await getDeliveryPr(db, deliveryPrId))?.phase).toBe("merged");
  });

  it("an App-authored PR goes to needs_human after its head is observed", async () => {
    await evaluateDeliveryPr({
      deliveryPrId,
      deps: deps({ user: { type: "Bot" } }, GREEN),
    });
    expect(await getDeliveryPr(db, deliveryPrId)).toMatchObject({
      phase: "needs_human",
      lastReason: "app_authored_pr",
    });
  });

  it("a held lease skips the evaluation", async () => {
    expect(await acquireDeliveryLease(db, deliveryPrId, NOW)).toBe(true);
    expect(
      await evaluateDeliveryPr({ deliveryPrId, deps: deps({}, GREEN) }),
    ).toEqual({ status: "skipped", reason: "leased" });
  });

  it("a GitHub read failure is reported, never thrown, and the lease is released", async () => {
    const outcome = await evaluateDeliveryPr({
      deliveryPrId,
      deps: deps({}, GREEN, {
        readHeadCi: async () => {
          throw new Error("HTTP 502");
        },
      }),
    });
    expect(outcome).toEqual({ status: "failed", reason: "HTTP 502" });
    expect((await getDeliveryPr(db, deliveryPrId))?.leaseUntil).toBeNull();
  });

  it("a missing row is skipped", async () => {
    expect(
      await evaluateDeliveryPr({
        deliveryPrId: "no-such-row",
        deps: deps({}, GREEN),
      }),
    ).toEqual({ status: "skipped", reason: "missing" });
  });
});

describe("#509 summarizeReviews", () => {
  const review = (
    id: number,
    login: string,
    state: string,
    commit_id = "H",
  ) => ({ id, state, commit_id, user: { login } });

  it("takes the bot's latest formal review at THIS head only", () => {
    expect(
      summarizeReviews(
        [
          review(1, BOT, "CHANGES_REQUESTED", "OLD"),
          review(2, BOT, "COMMENTED"),
          review(3, "Automata-AI-Bot[bot]", "APPROVED"),
        ],
        "H",
        BOT,
      ),
    ).toEqual({
      botReviewAtHead: { id: 3, state: "APPROVED" },
      humanChangesRequested: false,
    });
    expect(
      summarizeReviews([review(1, BOT, "APPROVED", "OLD")], "H", BOT)
        .botReviewAtHead,
    ).toBeNull();
  });

  it("a person's request for changes stands until their own later approval; a comment does not withdraw it", () => {
    expect(
      summarizeReviews(
        [
          review(1, "alice", "CHANGES_REQUESTED"),
          review(2, "alice", "COMMENTED"),
        ],
        "H",
        BOT,
      ).humanChangesRequested,
    ).toBe(true);
    expect(
      summarizeReviews(
        [
          review(1, "alice", "CHANGES_REQUESTED"),
          review(2, "alice", "APPROVED"),
        ],
        "H",
        BOT,
      ).humanChangesRequested,
    ).toBe(false);
  });
});
