import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestAutomation,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { automations as automationsTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import { createNewThread } from "./new-thread-shared";
import { getOctokitForBackground, getIsPRAuthor } from "@/lib/github";
import { addEyesReactionToPullRequest } from "@/app/api/webhooks/github/utils";
import { runPullRequestAutomation, runIssueAutomation } from "./automations";

vi.mock("./new-thread-shared", () => ({
  createNewThread: vi
    .fn()
    .mockResolvedValue({ threadId: "t1", threadChatId: "tc1" }),
}));

vi.mock("@/app/api/webhooks/github/utils", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, addEyesReactionToPullRequest: vi.fn() };
});

const mockOctokit = {
  rest: {
    pulls: {
      get: vi.fn().mockResolvedValue({ data: { head: { ref: "feature" } } }),
    },
    repos: {
      get: vi.fn().mockResolvedValue({ data: { default_branch: "main" } }),
    },
  },
};

async function seedAutomation(
  user: User,
  mode: "shadow" | "active",
  triggerType: "pull_request" | "issue",
) {
  const org = await createOrganization({
    db,
    name: "Org",
    slug: `org-${nanoid(8).toLowerCase()}`,
  });
  await bindGithubInstallationToOrg({
    db,
    installationId: Math.floor(Math.random() * 1_000_000_000),
    organizationId: org.id,
    mode,
  });
  const automation = await createTestAutomation({
    db,
    userId: user.id,
    values: { triggerType, repoFullName: "be-automata/automata" },
  });
  await db
    .update(automationsTable)
    .set({ organizationId: org.id })
    .where(eq(automationsTable.id, automation.id));
  return automation;
}

describe("automation path shadow suppression", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(createNewThread).mockResolvedValue({
      threadId: "t1",
      threadChatId: "tc1",
    });
    vi.mocked(getOctokitForBackground).mockResolvedValue(mockOctokit as any);
    vi.mocked(getIsPRAuthor).mockResolvedValue(false);
    user = (await createTestUser({ db })).user;
  });

  it("shadow PR automation: NO eyes reaction, thread created as shadow", async () => {
    const automation = await seedAutomation(user, "shadow", "pull_request");
    await runPullRequestAutomation({
      userId: user.id,
      automationId: automation.id,
      repoFullName: "be-automata/automata",
      prEventAction: "opened",
      prNumber: 1,
      source: "automated",
    });
    expect(addEyesReactionToPullRequest).not.toHaveBeenCalled();
    expect(createNewThread).toHaveBeenCalledWith(
      expect.objectContaining({ shadow: true }),
    );
  });

  it("active PR automation: eyes reaction IS added", async () => {
    const automation = await seedAutomation(user, "active", "pull_request");
    await runPullRequestAutomation({
      userId: user.id,
      automationId: automation.id,
      repoFullName: "be-automata/automata",
      prEventAction: "opened",
      prNumber: 1,
      source: "automated",
    });
    expect(addEyesReactionToPullRequest).toHaveBeenCalledTimes(1);
    expect(createNewThread).toHaveBeenCalledWith(
      expect.objectContaining({ shadow: false }),
    );
  });

  it("shadow issue automation: NO eyes reaction", async () => {
    const automation = await seedAutomation(user, "shadow", "issue");
    await runIssueAutomation({
      userId: user.id,
      automationId: automation.id,
      repoFullName: "be-automata/automata",
      issueEventAction: "opened",
      issueNumber: 1,
      source: "automated",
    });
    expect(addEyesReactionToPullRequest).not.toHaveBeenCalled();
  });

  it("active issue automation: eyes reaction IS added", async () => {
    const automation = await seedAutomation(user, "active", "issue");
    await runIssueAutomation({
      userId: user.id,
      automationId: automation.id,
      repoFullName: "be-automata/automata",
      issueEventAction: "opened",
      issueNumber: 1,
      source: "automated",
    });
    expect(addEyesReactionToPullRequest).toHaveBeenCalledTimes(1);
  });
});
