import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestAutomation,
  createTestThread,
  createTestOrg,
} from "@terragon/shared/model/test-helpers";
import { User } from "@terragon/shared";
import { createNewThread } from "./new-thread-shared";
import { getOctokitForBackground, getIsPRAuthor } from "@/lib/github";
import { runPullRequestAutomation } from "./automations";
import { archiveAndStopThread } from "./archive-thread";

/**
 * #165 (ADR-007): www owns NO supersession path. The automation's legacy
 * "archive + stop every other thread of this PR" step is DELETED — the engine
 * variant's per-PR concurrency supersedes prior runs, the C4 sweep reconciles.
 * These tests are the regression fence: no dispatch of a PR automation may
 * ever archive or stop a prior thread again, for any source.
 */
vi.mock("./new-thread-shared", () => ({
  createNewThread: vi
    .fn()
    .mockResolvedValue({ threadId: "t1", threadChatId: "tc1" }),
}));
vi.mock("@/app/api/webhooks/github/utils", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, addEyesReactionToPullRequest: vi.fn() };
});
vi.mock("./archive-thread", () => ({
  archiveAndStopThread: vi.fn().mockResolvedValue(undefined),
}));

const octokit = {
  rest: {
    pulls: {
      get: vi.fn().mockResolvedValue({
        data: {
          head: { ref: "feature", repo: { fork: false }, sha: "abc" },
          base: { ref: "main" },
          author_association: "OWNER",
        },
      }),
    },
  },
};

describe("runPullRequestAutomation — #165: prior threads are NEVER archived by www", () => {
  let user: User;
  let orgId: string;
  const REPO = "acme/widgets";

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    orgId = await createTestOrg({ db });
    vi.mocked(getIsPRAuthor).mockResolvedValue(false);
    vi.mocked(getOctokitForBackground).mockResolvedValue(octokit as any);
  });

  async function priorThread(automationId: string) {
    return createTestThread({
      db,
      userId: user.id,
      overrides: {
        organizationId: orgId,
        automationId,
        githubRepoFullName: REPO,
        githubPRNumber: 7,
      },
      chatOverrides: { status: "working" },
    });
  }

  it("automated dispatch with a live prior thread of the same PR: the prior thread is LEFT ALONE", async () => {
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: {
        organizationId: orgId,
        triggerType: "pull_request",
        repoFullName: REPO,
      },
    });
    await priorThread(automation.id);
    await runPullRequestAutomation({
      userId: user.id,
      automationId: automation.id,
      repoFullName: REPO,
      prEventAction: "synchronize",
      prNumber: 7,
      source: "automated",
    });
    expect(archiveAndStopThread).not.toHaveBeenCalled();
    expect(createNewThread).toHaveBeenCalledTimes(1);
  });

  it("manual dispatch: same — no prior-thread side effects", async () => {
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: {
        organizationId: orgId,
        triggerType: "pull_request",
        repoFullName: REPO,
      },
    });
    await priorThread(automation.id);
    await runPullRequestAutomation({
      userId: user.id,
      automationId: automation.id,
      repoFullName: REPO,
      prEventAction: "synchronize",
      prNumber: 7,
      source: "manual",
    });
    expect(archiveAndStopThread).not.toHaveBeenCalled();
    expect(createNewThread).toHaveBeenCalledTimes(1);
  });
});
