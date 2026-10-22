import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestAutomation,
  createTestOrg,
} from "@terragon/shared/model/test-helpers";
import { User } from "@terragon/shared";
import { createNewThread } from "./new-thread-shared";
import { getOctokitForBackground, getIsPRAuthor } from "@/lib/github";
import { addEyesReactionToPullRequest } from "@/app/api/webhooks/github/utils";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { runPullRequestAutomation } from "./automations";
import {
  createGitHubCheckRunForAutomation,
  updateGitHubCheckRunForAutomation,
} from "./github";

/**
 * #107: a re-run of a failed review is for ONE head. `expectedHeadSha` makes
 * runPullRequestAutomation refuse (false, no thread) when the PR closed or its
 * head moved between the re-run's own check and this read — the newer head
 * belongs to its own webhook-driven run, never to the re-run.
 */
vi.mock("./new-thread-shared", () => ({
  createNewThread: vi
    .fn()
    .mockResolvedValue({ threadId: "t1", threadChatId: "tc1" }),
}));
vi.mock("@/app/api/webhooks/github/utils", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, addEyesReactionToPullRequest: vi.fn() };
});
vi.mock("@terragon/shared/model/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFeatureFlagForUser: vi.fn(),
}));
vi.mock("./github", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createGitHubCheckRunForAutomation: vi.fn().mockResolvedValue(99),
  updateGitHubCheckRunForAutomation: vi.fn().mockResolvedValue(undefined),
}));

function prData(state: "open" | "closed", sha: string) {
  return {
    data: {
      state,
      head: { ref: "feature", repo: { fork: false }, sha },
      base: { ref: "main" },
      author_association: "OWNER",
    },
  };
}

describe("runPullRequestAutomation — #107 expectedHeadSha", () => {
  let user: User;
  let orgId: string;
  const REPO = "acme/widgets";
  const get = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    orgId = await createTestOrg({ db });
    // Check runs ON for this owner, so a refusal that leaked into the
    // check-run path would be visible.
    vi.mocked(getFeatureFlagForUser).mockResolvedValue(true);
    vi.mocked(getIsPRAuthor).mockResolvedValue(true);
    vi.mocked(getOctokitForBackground).mockResolvedValue({
      rest: { pulls: { get } },
    } as never);
  });

  async function run(expectedHeadSha?: string) {
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: {
        organizationId: orgId,
        triggerType: "pull_request",
        repoFullName: REPO,
      },
    });
    return await runPullRequestAutomation({
      userId: user.id,
      automationId: automation.id,
      repoFullName: REPO,
      prEventAction: "synchronize",
      prNumber: 7,
      source: "automated",
      deliveryId: "rerun:o/acme/widgets/7:abc:1",
      expectedHeadSha,
    });
  }

  function expectNothingOnThePr() {
    expect(createNewThread).not.toHaveBeenCalled();
    expect(addEyesReactionToPullRequest).not.toHaveBeenCalled();
    expect(createGitHubCheckRunForAutomation).not.toHaveBeenCalled();
    expect(updateGitHubCheckRunForAutomation).not.toHaveBeenCalled();
  }

  it("starts the run when the PR is open at the expected head (one PR read)", async () => {
    get.mockResolvedValue(prData("open", "abc"));
    expect(await run("abc")).toBe(true);
    expect(createNewThread).toHaveBeenCalledTimes(1);
    expect(addEyesReactionToPullRequest).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("refuses when the head moved — no reaction, no check run, no thread", async () => {
    get.mockResolvedValue(prData("open", "newer"));
    expect(await run("abc")).toBe(false);
    expectNothingOnThePr();
  });

  it("refuses when the PR closed — no reaction, no check run, no thread", async () => {
    get.mockResolvedValue(prData("closed", "abc"));
    expect(await run("abc")).toBe(false);
    expectNothingOnThePr();
  });

  it("without the option nothing changes (webhook runs)", async () => {
    get.mockResolvedValue(prData("closed", "newer"));
    expect(await run()).toBe(true);
    expect(createNewThread).toHaveBeenCalledTimes(1);
  });
});
