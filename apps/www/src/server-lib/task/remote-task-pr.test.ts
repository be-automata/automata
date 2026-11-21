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

import * as schema from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";

import {
  openRemoteTaskPullRequest,
  RemoteTaskPrRecordError,
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
    const issueStamp = {
      type: "automation-skill",
      skillName: "github-mention",
      contentSha: "sha",
      source: "org",
      mention: {
        repoFullName: REPO,
        issueOrPrNumber: 42,
        isPullRequest: false,
        commentId: 1,
        commentKind: "issue",
        commenterLogin: "octocat",
      },
    } as never;

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

  it("a failure recording the PR still names it: the error carries the opened PR", async () => {
    const gh = fakeGitHub({ compare: { ahead_by: 1 } });
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
    const failure = await run(gh).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RemoteTaskPrRecordError);
    expect((failure as RemoteTaskPrRecordError).recordedOutcome).toEqual({
      status: "opened",
      prNumber: 77,
    });
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

describe("taskRunPushBranch", () => {
  const threadId = "abcdef12-0000-0000-0000-000000000000";
  const push = (patch: {
    prNumber?: number;
    branch?: string | null;
    baseBranch?: string | null;
    isMentionPullRequest?: boolean;
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
        isMentionPullRequest: true,
      }),
    ).toBe("feat/pr-head");
  });
  it("other PR threads (review, companion, delivery fix) keep null", () => {
    expect(
      push({
        prNumber: 7,
        branch: "feat/pr-head",
        baseBranch: "feat/pr-head",
        isMentionPullRequest: false,
      }),
    ).toBeNull();
    expect(
      push({ prNumber: 7, branch: "feat/pr-head", baseBranch: "feat/pr-head" }),
    ).toBeNull();
  });
  it("a mention PR thread never resolves to a blank branch", () => {
    expect(
      push({ prNumber: 7, branch: null, isMentionPullRequest: true }),
    ).toBeNull();
  });
  it("the base branch with a PR, or a blank branch, is null", () => {
    expect(push({ prNumber: 7 })).toBeNull();
    expect(push({ branch: null })).toBeNull();
    expect(push({ branch: "  " })).toBeNull();
  });
});

describe("isMentionPullRequestThread", () => {
  const stamp = (mention: unknown) =>
    ({
      type: "automation-skill",
      skillName: "github-mention",
      contentSha: "sha",
      source: "org",
      ...(mention === undefined ? {} : { mention }),
    }) as never;
  const mention = (isPullRequest: boolean) => ({
    repoFullName: "acme/widgets",
    issueOrPrNumber: 4,
    isPullRequest,
    commentId: 1,
    commentKind: "issue",
    commenterLogin: "octocat",
  });

  it("matches only a mention stamp on a pull request", () => {
    expect(isMentionPullRequestThread(stamp(mention(true)))).toBe(true);
    expect(isMentionPullRequestThread(stamp(mention(false)))).toBe(false);
    expect(isMentionPullRequestThread(stamp(undefined))).toBe(false);
    expect(isMentionPullRequestThread(null)).toBe(false);
    expect(isMentionPullRequestThread(undefined)).toBe(false);
    expect(isMentionPullRequestThread({ type: "manual" } as never)).toBe(false);
  });
});

describe("mentionPullRequestPolicy", () => {
  const stamp = (isPullRequest: boolean) =>
    ({
      type: "automation-skill",
      skillName: "github-mention",
      contentSha: "sha",
      source: "org",
      mention: {
        repoFullName: REPO,
        issueOrPrNumber: 9,
        isPullRequest,
        commentId: 1,
        commentKind: "issue",
        commenterLogin: "octocat",
      },
    }) as never;

  it("names the issue for an issue mention only", () => {
    expect(mentionPullRequestPolicy(stamp(false))).toEqual({ issueNumber: 9 });
    expect(mentionPullRequestPolicy(stamp(true))).toBeNull();
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
