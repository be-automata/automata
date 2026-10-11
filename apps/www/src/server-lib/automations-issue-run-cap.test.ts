import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db } from "@/lib/db";
import {
  createTestAutomation,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { automations as automationsTable } from "@terragon/shared/db/schema";
import type {
  Automation,
  ThreadStatus,
  ThreadStatusDeprecated,
} from "@terragon/shared/db/types";
import { User } from "@terragon/shared";
import { getOctokitForBackground } from "@/lib/github";
import { addEyesReactionToPullRequest } from "@/app/api/webhooks/github/utils";

import { createNewThread } from "./new-thread-shared";
import { MAX_ISSUE_RUNS_PER_ISSUE, runIssueAutomation } from "./automations";

vi.mock("./new-thread-shared", () => ({
  createNewThread: vi
    .fn()
    .mockResolvedValue({ threadId: "t1", threadChatId: "tc1" }),
}));

vi.mock("@/app/api/webhooks/github/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/webhooks/github/utils")>()),
  addEyesReactionToPullRequest: vi.fn(),
}));

const REPO = "be-automata/automata";
const ISSUE = 277;

const mockOctokit = {
  rest: {
    repos: {
      get: vi.fn().mockResolvedValue({ data: { default_branch: "main" } }),
    },
  },
};

async function seedIssueAutomation(user: User): Promise<Automation> {
  const org = await createOrganization({
    db,
    name: "Org",
    slug: `org-${nanoid(8).toLowerCase()}`,
  });
  await bindGithubInstallationToOrg({
    db,
    installationId: Math.floor(Math.random() * 1_000_000_000),
    organizationId: org.id,
    mode: "active",
  });
  const automation = await createTestAutomation({
    db,
    userId: user.id,
    values: { triggerType: "issue", repoFullName: REPO },
  });
  await db
    .update(automationsTable)
    .set({ organizationId: org.id })
    .where(eq(automationsTable.id, automation.id));
  return automation;
}

async function seedPriorRun(
  user: User,
  automation: Automation,
  status: Exclude<ThreadStatus, ThreadStatusDeprecated>,
): Promise<void> {
  await createTestThread({
    db,
    userId: user.id,
    overrides: {
      githubRepoFullName: REPO,
      automationId: automation.id,
      githubIssueNumber: ISSUE,
    },
    chatOverrides: { status },
  });
}

function run(
  user: User,
  automation: Automation,
  over: {
    issueState?: string;
    source?: "automated" | "manual";
  } = {},
): Promise<void> {
  return runIssueAutomation({
    userId: user.id,
    automationId: automation.id,
    repoFullName: REPO,
    issueEventAction: "labeled",
    issueNumber: ISSUE,
    issueState: over.issueState ?? "open",
    source: over.source ?? "automated",
  });
}

describe("runIssueAutomation — per-issue run bound", () => {
  let user: User;
  let automation: Automation;
  let logs: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(createNewThread).mockResolvedValue({
      threadId: "t1",
      threadChatId: "tc1",
    });
    // any: a partial Octokit stub carrying only repos.get.
    vi.mocked(getOctokitForBackground).mockResolvedValue(mockOctokit as any);
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    user = (await createTestUser({ db })).user;
    automation = await seedIssueAutomation(user);
  });

  it("starts the first run on an open issue", async () => {
    await run(user, automation);
    expect(addEyesReactionToPullRequest).toHaveBeenCalledTimes(1);
    expect(createNewThread).toHaveBeenCalledWith(
      expect.objectContaining({ githubIssueNumber: ISSUE }),
    );
  });

  it("skips a closed issue without touching GitHub", async () => {
    await run(user, automation, { issueState: "closed" });
    expect(createNewThread).not.toHaveBeenCalled();
    expect(addEyesReactionToPullRequest).not.toHaveBeenCalled();
    expect(getOctokitForBackground).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("issue-closed"))).toBe(true);
  });

  it("skips while an earlier run on the issue is still in flight", async () => {
    await seedPriorRun(user, automation, "working");
    await run(user, automation);
    expect(createNewThread).not.toHaveBeenCalled();
    expect(addEyesReactionToPullRequest).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("run-in-flight"))).toBe(true);
  });

  it("starts another run below the cap once earlier runs finished", async () => {
    for (let i = 0; i < MAX_ISSUE_RUNS_PER_ISSUE - 1; i++) {
      await seedPriorRun(user, automation, "complete");
    }
    await run(user, automation);
    expect(createNewThread).toHaveBeenCalledTimes(1);
  });

  it(`skips once the issue already had ${MAX_ISSUE_RUNS_PER_ISSUE} runs`, async () => {
    for (let i = 0; i < MAX_ISSUE_RUNS_PER_ISSUE; i++) {
      await seedPriorRun(user, automation, "complete");
    }
    await run(user, automation);
    expect(createNewThread).not.toHaveBeenCalled();
    expect(addEyesReactionToPullRequest).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("run-cap-reached"))).toBe(true);
  });

  it("does not bound a manual run", async () => {
    for (let i = 0; i < MAX_ISSUE_RUNS_PER_ISSUE; i++) {
      await seedPriorRun(user, automation, "complete");
    }
    await run(user, automation, { source: "manual", issueState: "closed" });
    expect(createNewThread).toHaveBeenCalledTimes(1);
  });
});
