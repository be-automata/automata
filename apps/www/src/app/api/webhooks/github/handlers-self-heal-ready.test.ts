import { beforeEach, describe, expect, it, vi } from "vitest";

import * as github from "@/lib/github";
import { runPullRequestAutomation } from "@/server-lib/automations";
import { getPullRequestAutomationsForRepo } from "@terragon/shared/model/automations";
import type { Automation } from "@terragon/shared/db/types";

import { handlePullRequestUpdated, type PullRequestEvent } from "./handlers";

vi.mock("@terragon/shared/model/automations", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@terragon/shared/model/automations")
  >()),
  getPullRequestAutomationsForRepo: vi.fn(),
}));
vi.mock("@/server-lib/automations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server-lib/automations")>()),
  runPullRequestAutomation: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));
vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  getIsPRAuthor: vi.fn(() => Promise.resolve(false)),
}));

const REPO = "owner/repo";
const BOT = "automata-app[bot]";

function reviewAutomation(filter: Record<string, unknown>): Automation {
  return {
    id: "review-1",
    userId: "user-1",
    organizationId: "org-1",
    repoFullName: REPO,
    triggerType: "pull_request",
    triggerConfig: { filter, on: { open: true } },
    action: { type: "user_message", config: { message: {} } },
  } as unknown as Automation;
}

/** The one ready_for_review GitHub emits after the App's GraphQL mutation. */
function readyForReview(): PullRequestEvent {
  return {
    action: "ready_for_review",
    pull_request: {
      number: 501,
      draft: false,
      head: { sha: "b".repeat(40), ref: "automata/fix-42-01234567-a1" },
      updated_at: "2026-10-04T12:00:00Z",
      user: { login: BOT, type: "Bot" },
    },
    repository: { full_name: REPO },
  } as unknown as PullRequestEvent;
}

// 09-12 note / SC4: marking a self-heal draft ready must start exactly one
// review. The review lane must not skip the bot-authored PR.
describe("review lane on a self-heal draft marked ready (SC4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("an all-authors review automation runs once for the bot-authored PR", async () => {
    vi.mocked(getPullRequestAutomationsForRepo).mockResolvedValue([
      reviewAutomation({ includeAllAuthors: true }),
    ]);
    await handlePullRequestUpdated(readyForReview());
    expect(runPullRequestAutomation).toHaveBeenCalledTimes(1);
    expect(runPullRequestAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: "review-1",
        prEventAction: "ready_for_review",
        repoFullName: REPO,
        prNumber: 501,
      }),
    );
  });

  it("an automation limited to its owner's PRs skips it (why includeAllAuthors is a precondition)", async () => {
    vi.mocked(getPullRequestAutomationsForRepo).mockResolvedValue([
      reviewAutomation({ includeAllAuthors: false }),
    ]);
    await handlePullRequestUpdated(readyForReview());
    expect(github.getIsPRAuthor).toHaveBeenCalledTimes(1);
    expect(runPullRequestAutomation).not.toHaveBeenCalled();
  });
});
