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

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture }),
}));

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

function skippedEvents(): unknown[] {
  return capture.mock.calls
    .map(([arg]) => arg as { event: string })
    .filter((arg) => arg.event === "automation_skipped");
}

function run(
  user: User,
  automation: Automation,
  over: { source?: "automated" | "manual" } = {},
): Promise<void> {
  return runIssueAutomation({
    userId: user.id,
    automationId: automation.id,
    repoFullName: REPO,
    issueEventAction: "labeled",
    issueNumber: ISSUE,
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
    expect(skippedEvents()).toEqual([]);
  });

  it("starts one run when two events for the issue arrive together", async () => {
    await Promise.all([run(user, automation), run(user, automation)]);
    expect(createNewThread).toHaveBeenCalledTimes(1);
    expect(addEyesReactionToPullRequest).toHaveBeenCalledTimes(1);
    expect(
      logs.some((l) =>
        l.includes("run-in-flight (claim held by a concurrent event"),
      ),
    ).toBe(true);
    expect(skippedEvents()).toEqual([
      {
        distinctId: user.id,
        event: "automation_skipped",
        properties: {
          automationId: automation.id,
          repoFullName: REPO,
          issueNumber: ISSUE,
          reason: "run-in-flight",
        },
      },
    ]);
  });

  it("skips a second event inside the claim window", async () => {
    await run(user, automation);
    // createNewThread is mocked, so no thread row exists: only the claim stops it.
    await run(user, automation);
    expect(createNewThread).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when a run fails before its thread exists, so a retry starts", async () => {
    vi.mocked(getOctokitForBackground).mockRejectedValueOnce(
      new Error("github down"),
    );
    await expect(run(user, automation)).rejects.toThrow("github down");
    await run(user, automation);
    expect(createNewThread).toHaveBeenCalledTimes(1);
  });

  it("skips while an earlier run on the issue is still in flight", async () => {
    await seedPriorRun(user, automation, "working");
    await run(user, automation);
    expect(createNewThread).not.toHaveBeenCalled();
    expect(addEyesReactionToPullRequest).not.toHaveBeenCalled();
    expect(
      logs.some((l) => l.includes("run-in-flight (runs=1, inFlight=1, cap=3)")),
    ).toBe(true);
    expect(skippedEvents()).toEqual([
      {
        distinctId: user.id,
        event: "automation_skipped",
        properties: {
          automationId: automation.id,
          repoFullName: REPO,
          issueNumber: ISSUE,
          reason: "run-in-flight",
          runs: 1,
          inFlight: 1,
        },
      },
    ]);
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
    expect(
      logs.some((l) =>
        l.includes(
          `run-cap-reached (runs=${MAX_ISSUE_RUNS_PER_ISSUE}, inFlight=0, cap=${MAX_ISSUE_RUNS_PER_ISSUE})`,
        ),
      ),
    ).toBe(true);
    expect(skippedEvents()).toEqual([
      {
        distinctId: user.id,
        event: "automation_skipped",
        properties: {
          automationId: automation.id,
          repoFullName: REPO,
          issueNumber: ISSUE,
          reason: "run-cap-reached",
          runs: MAX_ISSUE_RUNS_PER_ISSUE,
          inFlight: 0,
        },
      },
    ]);
  });

  it("does not bound a manual run", async () => {
    for (let i = 0; i < MAX_ISSUE_RUNS_PER_ISSUE; i++) {
      await seedPriorRun(user, automation, "complete");
    }
    await run(user, automation, { source: "manual" });
    expect(createNewThread).toHaveBeenCalledTimes(1);
    expect(skippedEvents()).toEqual([]);
  });
});
