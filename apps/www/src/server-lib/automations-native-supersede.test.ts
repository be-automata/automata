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
import { engineOwnsSupersession } from "@/agent/hatchet/dispatch";

/**
 * #125: the automation's "archive + stop every other thread of this PR" step
 * is the LEGACY app-side supersede. Under a native policy the engine owns
 * supersession (cancel / queue / discard) — stopping the prior thread here
 * cancelled the running review under complete-run-queue in production.
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
vi.mock("@/agent/hatchet/dispatch", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  engineOwnsSupersession: vi.fn(),
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

describe("runPullRequestAutomation — prior-thread archival vs native supersede policies", () => {
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

  it("engine-owned policy → the prior review thread is LEFT ALONE (the policy decides)", async () => {
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
    vi.mocked(engineOwnsSupersession).mockResolvedValue(true);
    await runPullRequestAutomation({
      userId: user.id,
      automationId: automation.id,
      repoFullName: REPO,
      prEventAction: "synchronize",
      prNumber: 7,
      source: "automated",
    });
    expect(engineOwnsSupersession).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: orgId, repoFullName: REPO }),
    );
    expect(archiveAndStopThread).not.toHaveBeenCalled();
    expect(createNewThread).toHaveBeenCalledTimes(1);
  });

  it("control-plane policy (flag off / app-side) → legacy behaviour: the prior thread is archived + stopped", async () => {
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: {
        organizationId: orgId,
        triggerType: "pull_request",
        repoFullName: REPO,
      },
    });
    const prior = await priorThread(automation.id);
    vi.mocked(engineOwnsSupersession).mockResolvedValue(false);
    await runPullRequestAutomation({
      userId: user.id,
      automationId: automation.id,
      repoFullName: REPO,
      prEventAction: "synchronize",
      prNumber: 7,
      source: "automated",
    });
    expect(archiveAndStopThread).toHaveBeenCalledWith({
      userId: user.id,
      threadId: prior.threadId,
    });
  });
});
