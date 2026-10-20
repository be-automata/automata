import { beforeEach, describe, expect, it, vi } from "vitest";

import { runPullRequestAutomation } from "@/server-lib/automations";
import { getPullRequestAutomationsForRepo } from "@terragon/shared/model/automations";
import type { Automation } from "@terragon/shared/db/types";

import { handlePullRequestUpdated, type PullRequestEvent } from "./handlers";

/**
 * `filter.excludeBotSenders` (legacy-orchestrator parity): a bot's push or
 * opening is not reviewed; a human's is.
 *
 * protects: dependabot and the App's own pushes stop triggering reviews on
 *   repos that opt in, while humans (and ready_for_review) still do.
 * fails_when: a bot `synchronize` triggers, a human push is skipped, or an
 *   automation without the filter changes behaviour.
 * no_claim: GitHub's sender payload shape beyond `sender.type`.
 */

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

function automation(filter: Record<string, unknown>): Automation {
  return {
    id: "review-1",
    userId: "user-1",
    organizationId: "org-1",
    repoFullName: REPO,
    triggerType: "pull_request",
    triggerConfig: { filter, on: { open: true, update: true } },
    action: {
      type: "skill_message",
      config: { skillName: "github-ops", version: "latest" },
    },
  } as unknown as Automation;
}

function event(
  action: "opened" | "synchronize" | "ready_for_review",
  sender: { login: string; type: "Bot" | "User" },
): PullRequestEvent {
  return {
    action,
    sender,
    pull_request: {
      number: 77,
      draft: false,
      head: { sha: "c".repeat(40), ref: "deps/bump" },
      updated_at: "2026-10-20T12:00:00Z",
      user: { login: "dependabot[bot]", type: "Bot" },
    },
    repository: { full_name: REPO },
  } as unknown as PullRequestEvent;
}

const DEPENDABOT = { login: "dependabot[bot]", type: "Bot" as const };
const APP = { login: "automata-ai-bot[bot]", type: "Bot" as const };
const HUMAN = { login: "dev", type: "User" as const };

describe("excludeBotSenders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("skips opened and synchronize sent by a bot (dependabot, the App)", async () => {
    vi.mocked(getPullRequestAutomationsForRepo).mockResolvedValue([
      automation({ includeAllAuthors: true, excludeBotSenders: true }),
    ]);
    await handlePullRequestUpdated(event("opened", DEPENDABOT));
    await handlePullRequestUpdated(event("synchronize", APP));
    expect(runPullRequestAutomation).not.toHaveBeenCalled();
  });

  it("still reviews a human push to a bot-authored PR, and a ready_for_review", async () => {
    vi.mocked(getPullRequestAutomationsForRepo).mockResolvedValue([
      automation({ includeAllAuthors: true, excludeBotSenders: true }),
    ]);
    await handlePullRequestUpdated(event("synchronize", HUMAN));
    await handlePullRequestUpdated(event("ready_for_review", APP));
    expect(runPullRequestAutomation).toHaveBeenCalledTimes(2);
  });

  it("an automation without the filter keeps today's behaviour (bots trigger)", async () => {
    vi.mocked(getPullRequestAutomationsForRepo).mockResolvedValue([
      automation({ includeAllAuthors: true }),
    ]);
    await handlePullRequestUpdated(event("synchronize", DEPENDABOT));
    expect(runPullRequestAutomation).toHaveBeenCalledTimes(1);
  });
});
