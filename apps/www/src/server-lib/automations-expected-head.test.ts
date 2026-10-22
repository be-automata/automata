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
import { runPullRequestAutomation } from "./automations";

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
    vi.mocked(getIsPRAuthor).mockResolvedValue(false);
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

  it("starts the run when the PR is open at the expected head", async () => {
    get.mockResolvedValue(prData("open", "abc"));
    expect(await run("abc")).toBe(true);
    expect(createNewThread).toHaveBeenCalledTimes(1);
  });

  it("refuses when the head moved", async () => {
    get.mockResolvedValue(prData("open", "newer"));
    expect(await run("abc")).toBe(false);
    expect(createNewThread).not.toHaveBeenCalled();
  });

  it("refuses when the PR closed", async () => {
    get.mockResolvedValue(prData("closed", "abc"));
    expect(await run("abc")).toBe(false);
    expect(createNewThread).not.toHaveBeenCalled();
  });

  it("without the option nothing changes (webhook runs)", async () => {
    get.mockResolvedValue(prData("closed", "newer"));
    expect(await run()).toBe(true);
    expect(createNewThread).toHaveBeenCalledTimes(1);
  });
});
