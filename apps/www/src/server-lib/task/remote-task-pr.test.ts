import type { Octokit } from "octokit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DBMessage } from "@terragon/shared/db/db-message";
import type { ThreadSourceMetadata } from "@terragon/shared/db/types";
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

import * as schema from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";

import { publicAppUrl } from "@terragon/env/next-public";

import { db } from "@/lib/db";
import {
  mentionSourceMetadata,
  mentionStamp,
} from "@/test-helpers/mention-stamp";

import {
  openRemoteTaskPullRequest,
  remoteTaskBranchFor,
  remoteTaskBranchName,
  isMentionPullRequestThread,
  mentionPullRequestPolicy,
  taskRunPushBranch,
  withIssueReference,
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
  compare = { ahead_by: 1 },
  openPulls = [],
  createFails,
}: {
  compare?: { ahead_by: number } | "missing";
  openPulls?: Array<{ number: number }>;
  /** pulls.create rejects with this HTTP status. */
  createFails?: number;
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
          if (createFails) {
            throw Object.assign(new Error("refused"), { status: createFails });
          }
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

  const run = (gh: FakeGitHub, user: FakeGitHub | null = null) =>
    openRemoteTaskPullRequest({
      db,
      userId,
      threadId,
      threadChatId,
      octokitFor: async () => gh.octokit,
      userOctokitFor: async () => user?.octokit ?? null,
      generateContent,
    });

  it("opens the PR as the user when they have a GitHub token, reading as the App", async () => {
    const app = fakeGitHub({ compare: { ahead_by: 2 } });
    const user = fakeGitHub({});
    await expect(run(app, user)).resolves.toEqual({
      status: "opened",
      prNumber: 77,
      recorded: true,
    });
    expect(user.created).toHaveLength(1);
    expect(app.created).toHaveLength(0);
    expect(
      vi.mocked(app.octokit.rest.repos.compareCommitsWithBasehead),
    ).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(user.octokit.rest.repos.compareCommitsWithBasehead),
    ).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])(
    "opens the PR as the App when GitHub refuses the user's token (%i)",
    async (status) => {
      const app = fakeGitHub({});
      const user = fakeGitHub({ createFails: status });
      await expect(run(app, user)).resolves.toEqual({
        status: "opened",
        prNumber: 77,
        recorded: true,
      });
      expect(app.created).toHaveLength(1);
    },
  );

  it("does not retry as the App on a validation error from the user's create", async () => {
    const app = fakeGitHub({});
    const user = fakeGitHub({ createFails: 422 });
    await expect(run(app, user)).rejects.toThrow("refused");
    expect(app.created).toHaveLength(0);
  });

  it("opens a draft PR from the work branch and records it on the thread", async () => {
    const gh = fakeGitHub({ compare: { ahead_by: 2 } });
    await expect(run(gh)).resolves.toEqual({
      status: "opened",
      prNumber: 77,
      recorded: true,
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

  describe("a thread an issue mention started (OD-2, OD-5)", () => {
    const issueStamp = mentionSourceMetadata(
      mentionStamp({
        isPullRequest: false,
        repoFullName: REPO,
        issueOrPrNumber: 42,
      }),
    );

    beforeEach(async () => {
      await updateThread({
        db,
        userId,
        threadId,
        updates: { sourceMetadata: issueStamp },
      });
    });

    it("opens a draft even when the owner's PR type is ready, ending in Refs #N", async () => {
      await updateUserSettings({ db, userId, updates: { prType: "ready" } });
      const gh = fakeGitHub({ compare: { ahead_by: 1 } });
      await run(gh);
      expect(gh.created[0]).toMatchObject({ draft: true });
      const body = String(gh.created[0]?.body);
      expect(body).toContain("Generated body.\n\nRefs #42");
      expect(body).toContain(`/task/${threadId}`);
    });

    it("keeps the agent's own block and still references the issue", async () => {
      await finishWith(
        pullRequestBlock({ title: "feat: a", body: "## Summary\n- Did it." }),
      );
      const gh = fakeGitHub({ compare: { ahead_by: 1 } });
      await run(gh);
      expect(String(gh.created[0]?.body)).toMatch(
        /^## Summary\n- Did it\.\n\nRefs #42\n\n---/,
      );
    });

    it("rewrites a closing keyword in the agent's block, so the PR never closes the issue", async () => {
      await finishWith(
        pullRequestBlock({
          title: "feat: a",
          body: "Closes #42 and fixes acme/widgets#42.",
        }),
      );
      const gh = fakeGitHub({ compare: { ahead_by: 1 } });
      await run(gh);
      const body = String(gh.created[0]?.body);
      expect(body).toContain("Refs #42 and Refs acme/widgets#42.");
      expect(body).not.toMatch(/closes|fixes/i);
    });

    it("skips when the owner turned automatic PRs off, without calling GitHub (OD-7)", async () => {
      await updateUserSettings({
        db,
        userId,
        updates: { autoCreatePRs: false },
      });
      const gh = fakeGitHub({ compare: { ahead_by: 1 } });
      await expect(run(gh)).resolves.toEqual({
        status: "skipped",
        reason: "auto_create_off",
      });
      expect(
        vi.mocked(gh.octokit.rest.repos.compareCommitsWithBasehead),
      ).not.toHaveBeenCalled();
    });

    it("a question run (branch never ahead) opens nothing", async () => {
      const gh = fakeGitHub({ compare: { ahead_by: 0 } });
      await expect(run(gh)).resolves.toEqual({
        status: "skipped",
        reason: "no_changes",
      });
      expect(gh.created).toHaveLength(0);
    });
  });

  describe("a mention thread on a ticket-keyed branch (#752)", () => {
    const WORK_BRANCH = "feat/ACME-123-add-request-logging";
    const stampWith = (extra: {
      workBranch?: string;
      workBranchTaken?: true;
      isPullRequest?: boolean;
    }) =>
      mentionSourceMetadata(
        mentionStamp({
          isPullRequest: false,
          repoFullName: REPO,
          issueOrPrNumber: 42,
          ...extra,
        }),
      );
    const stampThread = (sourceMetadata: ThreadSourceMetadata) =>
      updateThread({ db, userId, threadId, updates: { sourceMetadata } });
    const mentionReply = '```json mention-reply\n{"reply":"Done."}\n```';

    it("compares, lists, opens and records the convention branch (AC-1)", async () => {
      await stampThread(stampWith({ workBranch: WORK_BRANCH }));
      const gh = fakeGitHub({ compare: { ahead_by: 1 } });
      await expect(run(gh)).resolves.toMatchObject({ status: "opened" });
      expect(
        vi.mocked(gh.octokit.rest.repos.compareCommitsWithBasehead),
      ).toHaveBeenCalledWith({
        owner: "acme",
        repo: "widgets",
        basehead: "main...feat/ACME-123-add-request-logging",
      });
      expect(vi.mocked(gh.octokit.rest.pulls.list)).toHaveBeenCalledWith(
        expect.objectContaining({
          head: "acme:feat/ACME-123-add-request-logging",
        }),
      );
      expect(gh.created[0]).toMatchObject({
        head: "feat/ACME-123-add-request-logging",
        base: "main",
        draft: true,
      });
      const thread = await getThread({ db, threadId, userId });
      expect(thread?.branchName).toBe("feat/ACME-123-add-request-logging");
      expect(thread?.githubPRNumber).toBe(77);
    });

    it("appends the thread suffix when intake found the name taken", async () => {
      await stampThread(
        stampWith({ workBranch: WORK_BRANCH, workBranchTaken: true }),
      );
      const gh = fakeGitHub({ compare: { ahead_by: 1 } });
      await run(gh);
      const suffix = threadId.slice(0, 8).toLowerCase();
      expect(gh.created[0]).toMatchObject({
        head: `feat/ACME-123-add-request-logging-${suffix}`,
      });
      const thread = await getThread({ db, threadId, userId });
      expect(thread?.branchName).toBe(
        `feat/ACME-123-add-request-logging-${suffix}`,
      );
    });

    it("falls back to the task branch when the stored name is invalid", async () => {
      await stampThread(stampWith({ workBranch: "feat/../x" }));
      const gh = fakeGitHub({ compare: { ahead_by: 1 } });
      await run(gh);
      expect(gh.created[0]).toMatchObject({
        head: `automata/task-${threadId.slice(0, 8).toLowerCase()}`,
      });
    });

    it("takes the title and body from a pull-request block ahead of the mention-reply block (AC-3)", async () => {
      await stampThread(stampWith({ workBranch: WORK_BRANCH }));
      await finishWith(
        [
          "Delivered.",
          "",
          "```json pull-request",
          JSON.stringify({
            title: "feat(logging): add request logging",
            body: "## Ticket\nACME-123\n\n## Checks\n- [x] pnpm test",
          }),
          "```",
          "",
          mentionReply,
        ].join("\n"),
      );
      const gh = fakeGitHub({ compare: { ahead_by: 1 } });
      await run(gh);
      expect(generateContent).not.toHaveBeenCalled();
      expect(gh.created[0]).toMatchObject({
        title: "feat(logging): add request logging",
      });
      expect(String(gh.created[0]?.body)).toBe(
        `## Ticket\nACME-123\n\n## Checks\n- [x] pnpm test\n\nRefs #42\n\n---\n\n📎 **Task**: ${publicAppUrl()}/task/${threadId}`,
      );
    });

    it("keeps today's body when the final message has only the mention-reply block", async () => {
      await stampThread(stampWith({ workBranch: WORK_BRANCH }));
      await finishWith(`Delivered.\n\n${mentionReply}`);
      const gh = fakeGitHub({ compare: { ahead_by: 1 } });
      await run(gh);
      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(String(gh.created[0]?.body)).toContain(
        "Generated body.\n\nRefs #42",
      );
    });

    it("ignores a pull-request body over the agent cap", async () => {
      await stampThread(stampWith({ workBranch: WORK_BRANCH }));
      await finishWith(
        pullRequestBlock({ title: "feat: a", body: "x".repeat(60_001) }),
      );
      const gh = fakeGitHub({ compare: { ahead_by: 1 } });
      await run(gh);
      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(gh.created[0]).toMatchObject({ title: "feat: generated title" });
    });

    it("rebuilds a body that closing-keyword rewrites pushed past GitHub's cap (D4)", async () => {
      await stampThread(stampWith({ workBranch: WORK_BRANCH }));
      const body = "fix #1 ".repeat(8_571);
      expect(body.length).toBeLessThanOrEqual(60_000);
      await finishWith(pullRequestBlock({ title: "feat: big", body }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const gh = fakeGitHub({ compare: { ahead_by: 1 } });
      await run(gh);
      expect(gh.created[0]).toMatchObject({ title: "feat: big" });
      expect(String(gh.created[0]?.body)).toBe(
        `Changes made by an automated task run.\n\nRefs #42\n\n---\n\n📎 **Task**: ${publicAppUrl()}/task/${threadId}`,
      );
      expect(warn).toHaveBeenCalledWith(
        "[remote-task-pr] agent body over GitHub's cap",
        expect.objectContaining({ threadId }),
      );
      warn.mockRestore();
    });

    it("leaves a body under the cap alone", async () => {
      await stampThread(stampWith({ workBranch: WORK_BRANCH }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await finishWith(
        pullRequestBlock({ title: "feat: ok", body: "y".repeat(59_000) }),
      );
      const gh = fakeGitHub({ compare: { ahead_by: 1 } });
      await run(gh);
      expect(String(gh.created[0]?.body)).toMatch(/^y{59000}\n\nRefs #42/);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("a PR mention carrying a forged workBranch keeps the task branch", async () => {
      await stampThread(
        stampWith({ workBranch: WORK_BRANCH, isPullRequest: true }),
      );
      const gh = fakeGitHub({ compare: { ahead_by: 1 } });
      await run(gh);
      expect(gh.created[0]).toMatchObject({
        head: `automata/task-${threadId.slice(0, 8).toLowerCase()}`,
      });
    });

    it("an issue-delivery thread keeps the task branch and the mention policy stays off", async () => {
      await updateThread({
        db,
        userId,
        threadId,
        updates: {
          githubIssueNumber: 42,
          sourceMetadata: {
            type: "automation-skill",
            skillName: "issue-delivery",
            contentSha: "sha",
            source: "org",
          },
        },
      });
      const gh = fakeGitHub({ compare: { ahead_by: 1 } });
      await run(gh);
      const head = `automata/task-${threadId.slice(0, 8).toLowerCase()}`;
      expect(
        vi.mocked(gh.octokit.rest.repos.compareCommitsWithBasehead),
      ).toHaveBeenCalledWith(
        expect.objectContaining({ basehead: `main...${head}` }),
      );
      expect(vi.mocked(gh.octokit.rest.pulls.list)).toHaveBeenCalledWith(
        expect.objectContaining({ head: `acme:${head}` }),
      );
      expect(gh.created[0]).toMatchObject({ head });
      expect(String(gh.created[0]?.body)).not.toContain("Refs #");
    });
  });

  it("a failure recording the PR still names it, flagged unrecorded and logged", async () => {
    const gh = fakeGitHub({ compare: { ahead_by: 1 } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // The thread row vanishes after the PR is created: the writes then fail.
    const github = gh.octokit.rest.pulls.create as unknown as ReturnType<
      typeof vi.fn
    >;
    github.mockImplementationOnce(async () => {
      await db.delete(schema.thread).where(eq(schema.thread.id, threadId));
      return {
        data: { number: 77, state: "open", draft: true, merged: false },
      };
    });
    await expect(run(gh)).resolves.toEqual({
      status: "opened",
      prNumber: 77,
      recorded: false,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "[remote-task-pr] PR opened but not recorded",
      expect.objectContaining({ threadId, prNumber: 77 }),
    );
    errorSpy.mockRestore();
  });

  it("a plain task thread keeps the owner's prType and gets no Refs line", async () => {
    await updateUserSettings({ db, userId, updates: { prType: "ready" } });
    const gh = fakeGitHub({ compare: { ahead_by: 1 } });
    await run(gh);
    expect(gh.created[0]).toMatchObject({ draft: false });
    expect(String(gh.created[0]?.body)).not.toContain("Refs #");
  });

  it("adopts an open PR for the branch instead of opening a second one", async () => {
    const gh = fakeGitHub({
      compare: { ahead_by: 1 },
      openPulls: [{ number: 12 }],
    });
    await expect(run(gh)).resolves.toEqual({
      status: "adopted",
      prNumber: 12,
      recorded: true,
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

const prMention = mentionSourceMetadata(mentionStamp({ isPullRequest: true }));
const issueMention = mentionSourceMetadata(
  mentionStamp({ isPullRequest: false }),
);

const issueWorkBranch = (
  extra: { taken?: true; workBranch?: string } = {},
): ThreadSourceMetadata =>
  mentionSourceMetadata(
    mentionStamp({
      isPullRequest: false,
      workBranch: extra.workBranch ?? "feat/ACME-123-add-request-logging",
      ...(extra.taken ? { workBranchTaken: true as const } : {}),
    }),
  );
const prWorkBranch = mentionSourceMetadata(
  mentionStamp({
    isPullRequest: true,
    workBranch: "feat/ACME-123-add-request-logging",
  }),
);

describe("remoteTaskBranchFor", () => {
  const threadId = "ABCDEF12-0000-0000-0000-000000000000";
  const TASK_BRANCH = "automata/task-abcdef12";
  const branchFor = (
    sourceMetadata: ThreadSourceMetadata | null | undefined,
    baseBranch: string | null | undefined = "main",
  ) => remoteTaskBranchFor({ threadId, sourceMetadata, baseBranch });

  it("returns the literal convention name for an issue mention (AC-1)", () => {
    expect(branchFor(issueWorkBranch())).toBe(
      "feat/ACME-123-add-request-logging",
    );
  });
  it("appends the lowercase thread suffix when the name was taken", () => {
    expect(branchFor(issueWorkBranch({ taken: true }))).toBe(
      "feat/ACME-123-add-request-logging-abcdef12",
    );
  });
  it.each([
    [
      "a stamp with no work branch",
      mentionSourceMetadata(mentionStamp({ isPullRequest: false })),
    ],
    ["a PR mention with a forged work branch", prWorkBranch],
    ["no metadata", null],
    ["undefined metadata", undefined],
    ["a non-automation stamp", { type: "manual" } as never],
    [
      "an issue-delivery stamp",
      {
        type: "automation-skill",
        skillName: "issue-delivery",
        contentSha: "sha",
        source: "org",
      } as ThreadSourceMetadata,
    ],
    [
      "a self-heal stamp",
      {
        type: "automation-skill",
        skillName: "self-heal-fix",
        contentSha: "sha",
        source: "org",
        selfHealAttemptId: "attempt-1",
      } as ThreadSourceMetadata,
    ],
  ])("keeps the task branch for %s", (_, sourceMetadata) => {
    expect(branchFor(sourceMetadata)).toBe(TASK_BRANCH);
  });
  it.each([
    "main",
    "feat/../x",
    "feat/ACME-1.lock",
    "feat/ACME-1-café",
    "-feat/ACME-1",
    "automata/task-abcdef12",
    "",
  ])("falls back to the task branch for the invalid name %j", (workBranch) => {
    expect(branchFor(issueWorkBranch({ workBranch }))).toBe(TASK_BRANCH);
    expect(branchFor(issueWorkBranch({ workBranch, taken: true }))).toBe(
      TASK_BRANCH,
    );
  });
  it("falls back to the task branch when the name equals the base branch (RF-2)", () => {
    expect(
      branchFor(issueWorkBranch(), "feat/ACME-123-add-request-logging"),
    ).toBe(TASK_BRANCH);
  });
  it("is not fooled by a null or missing base branch", () => {
    expect(branchFor(issueWorkBranch(), null)).toBe(
      "feat/ACME-123-add-request-logging",
    );
    expect(branchFor(issueWorkBranch(), undefined)).toBe(
      "feat/ACME-123-add-request-logging",
    );
  });
  it("never returns main or the base for any stamp", () => {
    for (const workBranch of ["main", "develop", "master"]) {
      for (const base of ["main", "develop", "master"]) {
        expect(branchFor(issueWorkBranch({ workBranch }), base)).toBe(
          TASK_BRANCH,
        );
      }
    }
  });
});

describe("taskRunPushBranch", () => {
  const threadId = "abcdef12-0000-0000-0000-000000000000";
  const push = (patch: {
    prNumber?: number;
    branch?: string | null;
    baseBranch?: string | null;
    sourceMetadata?: ThreadSourceMetadata;
  }) =>
    taskRunPushBranch({
      threadId,
      prNumber: undefined,
      branch: "main",
      baseBranch: "main",
      ...patch,
    });

  it("a base-branch run with no PR pushes the thread's task branch", () => {
    expect(push({})).toBe(remoteTaskBranchName(threadId));
  });
  it("an existing PR on a non-base branch pushes that branch", () => {
    expect(push({ prNumber: 7, branch: "feat/x" })).toBe("feat/x");
  });
  it("a non-base branch with no PR pushes that branch", () => {
    expect(push({ branch: "feat/x" })).toBe("feat/x");
  });
  it("a mention thread on a PR pushes the PR head it checked out, never null", () => {
    // The thread stores the PR head as its "base" and as the branch.
    expect(
      push({
        prNumber: 7,
        branch: "feat/pr-head",
        baseBranch: "feat/pr-head",
        sourceMetadata: prMention,
      }),
    ).toBe("feat/pr-head");
  });
  it("other PR threads (review, companion, delivery fix) keep null", () => {
    expect(
      push({
        prNumber: 7,
        branch: "feat/pr-head",
        baseBranch: "feat/pr-head",
        sourceMetadata: issueMention,
      }),
    ).toBeNull();
    expect(
      push({ prNumber: 7, branch: "feat/pr-head", baseBranch: "feat/pr-head" }),
    ).toBeNull();
  });
  it("a mention PR thread never resolves to a blank branch", () => {
    expect(
      push({ prNumber: 7, branch: null, sourceMetadata: prMention }),
    ).toBeNull();
  });
  it("an issue mention with a work branch pushes the convention name (AC-1)", () => {
    expect(push({ sourceMetadata: issueWorkBranch() })).toBe(
      "feat/ACME-123-add-request-logging",
    );
  });
  it("a taken name pushes the name plus the thread suffix", () => {
    expect(push({ sourceMetadata: issueWorkBranch({ taken: true }) })).toBe(
      "feat/ACME-123-add-request-logging-abcdef12",
    );
  });
  it("a follow-up run after the PR opened keeps the stored branch", () => {
    expect(
      push({
        prNumber: 5,
        branch: "feat/ACME-123-add-request-logging",
        sourceMetadata: issueWorkBranch(),
      }),
    ).toBe("feat/ACME-123-add-request-logging");
  });
  it("a work branch never overrides a non-base branch", () => {
    expect(
      push({ branch: "feat/other", sourceMetadata: issueWorkBranch() }),
    ).toBe("feat/other");
  });
  it("the base branch with a PR stays null for an issue mention", () => {
    expect(push({ prNumber: 5, sourceMetadata: issueWorkBranch() })).toBeNull();
  });
  it("a PR mention carrying a forged workBranch still pushes the PR head", () => {
    expect(
      push({
        prNumber: 7,
        branch: "feat/pr-head",
        baseBranch: "feat/pr-head",
        sourceMetadata: prWorkBranch,
      }),
    ).toBe("feat/pr-head");
  });
  it("the base branch with a PR, or a blank branch, is null", () => {
    expect(push({ prNumber: 7 })).toBeNull();
    expect(push({ branch: null })).toBeNull();
    expect(push({ branch: "  " })).toBeNull();
  });
});

describe("isMentionPullRequestThread", () => {
  it("matches only a mention stamp on a pull request", () => {
    const noMention = {
      type: "automation-skill",
      skillName: "github-mention",
      contentSha: "sha",
      source: "org",
    } as ThreadSourceMetadata;
    expect(isMentionPullRequestThread(prMention)).toBe(true);
    expect(isMentionPullRequestThread(issueMention)).toBe(false);
    expect(isMentionPullRequestThread(noMention)).toBe(false);
    expect(isMentionPullRequestThread(null)).toBe(false);
    expect(isMentionPullRequestThread(undefined)).toBe(false);
    expect(isMentionPullRequestThread({ type: "manual" } as never)).toBe(false);
  });
});

describe("mentionPullRequestPolicy", () => {
  it("names the issue for an issue mention only", () => {
    const issue = mentionSourceMetadata(
      mentionStamp({ isPullRequest: false, issueOrPrNumber: 9 }),
    );
    expect(mentionPullRequestPolicy(issue)).toEqual({ issueNumber: 9 });
    expect(mentionPullRequestPolicy(prMention)).toBeNull();
    expect(mentionPullRequestPolicy(null)).toBeNull();
    expect(mentionPullRequestPolicy({ type: "manual" } as never)).toBeNull();
  });
});

describe("withIssueReference", () => {
  it("appends Refs #N when the body has none", () => {
    expect(withIssueReference("Body.", 5)).toBe("Body.\n\nRefs #5");
  });

  it("keeps an existing Refs #N and does not repeat it", () => {
    expect(withIssueReference("Body.\n\nRefs #5", 5)).toBe("Body.\n\nRefs #5");
  });

  it.each(["refs #12", "Refs: #12", "Closes #12", "REFS:  #12"])(
    "does not append a second reference when %s is already there",
    (text) => {
      const out = withIssueReference(`Body.\n\n${text}`, 12);
      expect(out.match(/#12\b/g)).toHaveLength(1);
      expect(withIssueReference(out, 12)).toBe(out);
    },
  );

  it("does not take Refs #120 for #12", () => {
    expect(withIssueReference("Refs #120", 12)).toBe("Refs #120\n\nRefs #12");
  });

  it.each([
    "Closes #5",
    "closed #5",
    "FIXES: #5",
    "Resolves #5",
    "fix #5",
    "Closes acme/widgets#5",
    "Fixes https://github.com/acme/widgets/issues/5",
  ])("rewrites %s to a Refs line", (text) => {
    const out = withIssueReference(text, 5);
    expect(out.startsWith("Refs ")).toBe(true);
    expect(out).not.toMatch(/\b(close|fix|resolve)/i);
  });

  it("rewrites the full-URL form to Refs <url>", () => {
    expect(
      withIssueReference("Closes https://github.com/acme/widgets/issues/7", 5),
    ).toBe("Refs https://github.com/acme/widgets/issues/7\n\nRefs #5");
  });

  it("leaves fenced code and inline code untouched", () => {
    const body = [
      "Real: Fixes #5",
      "```text",
      "Closes #5",
      "```",
      "Inline `Resolves #5` stays.",
      "~~~",
      "fixes #5",
      "~~~",
    ].join("\n");
    const out = withIssueReference(body, 5);
    expect(out).toContain("Real: Refs #5");
    expect(out).toContain("```text\nCloses #5\n```");
    expect(out).toContain("`Resolves #5`");
    expect(out).toContain("~~~\nfixes #5\n~~~");
  });

  it("does not count a Refs line inside a fence", () => {
    const out = withIssueReference("```\nRefs #5\n```", 5);
    expect(out.endsWith("\n\nRefs #5")).toBe(true);
  });

  it("an unpaired backtick never hides a closing keyword in a later paragraph", () => {
    // A code span ends at its paragraph: the stray ` in the first paragraph
    // must not pair with the one in the last and swallow "Closes #5".
    const body = "Use the ` key.\n\nCloses #5\n\nRun `pnpm test`.";
    const out = withIssueReference(body, 5);
    expect(out).toContain("\n\nRefs #5\n\n");
    expect(out).not.toMatch(/closes/i);
    expect(out).toContain("`pnpm test`");
  });

  it("an inline code span may still wrap a single line break", () => {
    const out = withIssueReference("See `Closes\n#5` here.", 5);
    expect(out).toContain("`Closes\n#5`");
  });

  it("rewrites a keyword with a colon and no space before the reference", () => {
    const out = withIssueReference("Closes:#5", 5);
    expect(out).toBe("Refs #5");
  });

  it("does not touch words that merely contain a keyword", () => {
    expect(withIssueReference("Prefixes #5 are fine.", 5)).toContain(
      "Prefixes #5 are fine.",
    );
  });
});
