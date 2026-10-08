import type { Octokit } from "octokit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DBMessage } from "@terragon/shared/db/db-message";
import {
  getThread,
  updateThread,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { updateUserSettings } from "@terragon/shared/model/user";

import { db } from "@/lib/db";

import {
  openRemoteTaskPullRequest,
  remoteTaskBranchName,
} from "./remote-task-pr";

const generateContent = vi.fn(async () => ({
  title: "feat: generated title",
  body: "Generated body.",
}));

const REPO = "acme/widgets";

interface FakeGitHub {
  octokit: Octokit;
  created: Array<Record<string, unknown>>;
}

function fakeGitHub({
  compare,
  openPulls = [],
}: {
  compare: { ahead_by: number } | "missing";
  openPulls?: Array<{ number: number }>;
}): FakeGitHub {
  const created: Array<Record<string, unknown>> = [];
  const pull = (number: number) => ({
    number,
    state: "open",
    draft: true,
    merged: false,
  });
  const octokit = {
    rest: {
      repos: {
        compareCommitsWithBasehead: vi.fn(async () => {
          if (compare === "missing") {
            throw Object.assign(new Error("Not Found"), { status: 404 });
          }
          return {
            data: {
              ahead_by: compare.ahead_by,
              files: [{ filename: "a.ts", patch: "+x" }],
              commits: [
                { commit: { message: "feat(a): first step" } },
                { commit: { message: "fix(a): latest step\n\nRefs: X-1" } },
              ],
            },
          };
        }),
      },
      pulls: {
        list: vi.fn(async () => ({
          data: openPulls.map((p) => pull(p.number)),
        })),
        create: vi.fn(async (args: Record<string, unknown>) => {
          created.push(args);
          return { data: pull(77) };
        }),
      },
    },
  } as unknown as Octokit;
  return { octokit, created };
}

describe("openRemoteTaskPullRequest", () => {
  let userId: string;
  let threadId: string;
  let threadChatId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    userId = (await createTestUser({ db })).user.id;
    ({ threadId, threadChatId } = await createTestThread({
      db,
      userId,
      overrides: { githubRepoFullName: REPO, repoBaseBranchName: "main" },
    }));
  });

  const finishWith = (text: string) =>
    updateThreadChat({
      db,
      userId,
      threadId,
      threadChatId,
      updates: {
        appendMessages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text }],
          } as DBMessage,
        ],
      },
    });

  const pullRequestBlock = (value: unknown) =>
    `Delivered.\n\n\`\`\`json pull-request\n${JSON.stringify(value)}\n\`\`\``;

  const run = (gh: FakeGitHub) =>
    openRemoteTaskPullRequest({
      db,
      userId,
      threadId,
      threadChatId,
      octokitFor: async () => gh.octokit,
      generateContent,
    });

  it("opens a draft PR from the work branch and records it on the thread", async () => {
    const gh = fakeGitHub({ compare: { ahead_by: 2 } });
    await expect(run(gh)).resolves.toEqual({
      status: "opened",
      prNumber: 77,
    });
    expect(gh.created).toHaveLength(1);
    expect(gh.created[0]).toMatchObject({
      owner: "acme",
      repo: "widgets",
      head: remoteTaskBranchName(threadId),
      base: "main",
      draft: true,
      title: "feat: generated title",
    });
    expect(String(gh.created[0]?.body)).toContain(`/task/${threadId}`);
    const thread = await getThread({ db, threadId, userId });
    expect(thread?.githubPRNumber).toBe(77);
    expect(thread?.branchName).toBe(remoteTaskBranchName(threadId));
  });

  it("uses the agent's pull-request block for the title and body, without generating", async () => {
    await finishWith(
      pullRequestBlock({
        title: "feat(settings): add the Hockey tab",
        body: "## Summary\n- Hockey gets its own tab.\n\n## Test plan\n- [x] pnpm jest",
      }),
    );
    const gh = fakeGitHub({ compare: { ahead_by: 1 } });
    await run(gh);
    expect(generateContent).not.toHaveBeenCalled();
    expect(gh.created[0]).toMatchObject({
      title: "feat(settings): add the Hockey tab",
    });
    const body = String(gh.created[0]?.body);
    expect(body).toMatch(/^## Summary\n- Hockey gets its own tab\./);
    expect(body).toContain(`/task/${threadId}`);
  });

  it.each([
    ["a multi-line title", { title: "feat: a\nb", body: "Body." }],
    ["an empty body", { title: "feat: a", body: "  " }],
    ["a missing title", { body: "Body." }],
    ["an over-long title", { title: "x".repeat(300), body: "Body." }],
  ])("ignores a block with %s and generates instead", async (_, value) => {
    await finishWith(pullRequestBlock(value));
    const gh = fakeGitHub({ compare: { ahead_by: 1 } });
    await run(gh);
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(gh.created[0]).toMatchObject({ title: "feat: generated title" });
  });

  it("ignores a block that is not JSON", async () => {
    await finishWith("Done.\n\n```json pull-request\ntitle: feat: a\n```");
    const gh = fakeGitHub({ compare: { ahead_by: 1 } });
    await run(gh);
    expect(gh.created[0]).toMatchObject({ title: "feat: generated title" });
  });

  it("falls back to the latest commit subject, not the task name, when generation fails", async () => {
    generateContent.mockRejectedValueOnce(new Error("no key"));
    const gh = fakeGitHub({ compare: { ahead_by: 2 } });
    await run(gh);
    expect(gh.created[0]).toMatchObject({ title: "fix(a): latest step" });
  });

  it("opens a ready PR when the owner's PR type is ready", async () => {
    await updateUserSettings({ db, userId, updates: { prType: "ready" } });
    const gh = fakeGitHub({ compare: { ahead_by: 1 } });
    await run(gh);
    expect(gh.created[0]).toMatchObject({ draft: false });
  });

  it("adopts an open PR for the branch instead of opening a second one", async () => {
    const gh = fakeGitHub({
      compare: { ahead_by: 1 },
      openPulls: [{ number: 12 }],
    });
    await expect(run(gh)).resolves.toEqual({
      status: "adopted",
      prNumber: 12,
    });
    expect(gh.created).toHaveLength(0);
  });

  it("skips when the agent never pushed the branch", async () => {
    const gh = fakeGitHub({ compare: "missing" });
    await expect(run(gh)).resolves.toEqual({
      status: "skipped",
      reason: "no_branch",
    });
  });

  it("skips when the branch is not ahead of the base", async () => {
    const gh = fakeGitHub({ compare: { ahead_by: 0 } });
    await expect(run(gh)).resolves.toEqual({
      status: "skipped",
      reason: "no_changes",
    });
    expect(gh.created).toHaveLength(0);
  });

  it("skips a thread that disabled git checkpointing, without calling GitHub", async () => {
    await updateThread({
      db,
      userId,
      threadId,
      updates: { disableGitCheckpointing: true },
    });
    const gh = fakeGitHub({ compare: { ahead_by: 1 } });
    await expect(run(gh)).resolves.toEqual({
      status: "skipped",
      reason: "checkpointing_off",
    });
    expect(
      vi.mocked(gh.octokit.rest.repos.compareCommitsWithBasehead),
    ).not.toHaveBeenCalled();
  });

  it("skips when the owner turned automatic PRs off, without calling GitHub", async () => {
    await updateUserSettings({ db, userId, updates: { autoCreatePRs: false } });
    const gh = fakeGitHub({ compare: { ahead_by: 1 } });
    await expect(run(gh)).resolves.toEqual({
      status: "skipped",
      reason: "auto_create_off",
    });
    expect(
      vi.mocked(gh.octokit.rest.repos.compareCommitsWithBasehead),
    ).not.toHaveBeenCalled();
  });
});

describe("remoteTaskBranchName", () => {
  it("derives a stable, lowercase name from the thread id", () => {
    expect(remoteTaskBranchName("ABCDEF1234-5678")).toBe(
      "automata/task-abcdef12",
    );
  });
});
