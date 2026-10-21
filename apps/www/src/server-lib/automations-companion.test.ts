import { readFileSync } from "node:fs";
import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestAutomation,
  createTestThread,
  createTestOrg,
} from "@terragon/shared/model/test-helpers";
import { createRepoSkillVersion } from "@terragon/shared/model/repo-skills";
import { getThreadMinimal } from "@terragon/shared/model/threads";
import type { User } from "@terragon/shared";
import type {
  AutomationAction,
  PullRequestTriggerConfig,
} from "@terragon/shared/automations";
import { createNewThread } from "./new-thread-shared";
import { getOctokitForBackground, getIsPRAuthor } from "@/lib/github";
import {
  runPullRequestAutomation,
  validateAutomationCreationOrUpdate,
} from "./automations";
import { archiveAndStopThread } from "./archive-thread";
import {
  getPrAutomationLane,
  isReviewThread,
} from "./review/review-single-writer-finish";
import { FLUTTER_COMPANION_SKILL_NAME } from "./review/review-skill";
import { reviewsBotPullRequests } from "./audit/self-heal-dispatcher";

/**
 * The PR companion lane at intake: a `pull_request` automation with
 * `filter.companion: true` is dispatched as an advisory run stamped with the
 * PR + head it reports on, never as a review, and it touches no other thread.
 *
 * protects: the companion stamp (what the finish writer keys on), git
 *   checkpointing off (no commit / PR from a companion), no archive or stop
 *   of the review lane's threads, the review/companion lane predicate, the
 *   write-boundary validation.
 * fails_when: a companion thread lacks the stamp, a companion run archives a
 *   review thread, a companion counts as a review thread, an invalid
 *   companion config is accepted.
 * no_claim: the dispatch (dispatch.test.ts) and the writer
 *   (companion-report-finish.test.ts).
 */

vi.mock("./new-thread-shared", () => ({
  createNewThread: vi
    .fn()
    .mockResolvedValue({ threadId: "t1", threadChatId: "tc1" }),
}));
vi.mock("@/app/api/webhooks/github/utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/api/webhooks/github/utils")>();
  return { ...actual, addEyesReactionToPullRequest: vi.fn() };
});
vi.mock("./archive-thread", () => ({
  archiveAndStopThread: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./review/prefetch-review-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./review/prefetch-review-context")>();
  return {
    ...actual,
    prefetchReviewContextForPr: vi.fn(async () => "PREFETCHED-CONTEXT"),
  };
});

const HEAD_SHA = "c".repeat(40);
const octokit = {
  rest: {
    pulls: {
      get: vi.fn().mockResolvedValue({
        data: {
          head: {
            ref: "feature",
            repo: { fork: false, full_name: "acme/widgets" },
            sha: HEAD_SHA,
          },
          base: { ref: "main", repo: { full_name: "acme/widgets" } },
          author_association: "MEMBER",
        },
      }),
    },
  },
};

const COMPANION_CONFIG: PullRequestTriggerConfig = {
  filter: { includeAllAuthors: true, excludeBotSenders: true, companion: true },
  on: { open: true, update: true },
  permissionMode: "review",
};
const COMPANION_ACTION: AutomationAction = {
  type: "skill_message",
  config: { skillName: FLUTTER_COMPANION_SKILL_NAME, version: "latest" },
};

const SKILL_BODY = readFileSync(
  new URL(
    "../../../../deploy/skills/flutter-pr-companion/SKILL.md",
    import.meta.url,
  ),
  "utf8",
);

describe("runPullRequestAutomation — PR companion", () => {
  let user: User;
  let orgId: string;
  const REPO = "acme/widgets";

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(createNewThread).mockResolvedValue({
      threadId: "t1",
      threadChatId: "tc1",
    });
    user = (await createTestUser({ db })).user;
    orgId = await createTestOrg({ db });
    vi.mocked(getIsPRAuthor).mockResolvedValue(false);
    vi.mocked(getOctokitForBackground).mockResolvedValue(octokit as never);
    await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: FLUTTER_COMPANION_SKILL_NAME,
      body: SKILL_BODY,
      source: "seed",
    });
  });

  const makeCompanion = () =>
    createTestAutomation({
      db,
      userId: user.id,
      values: {
        organizationId: orgId,
        triggerType: "pull_request",
        triggerConfig: COMPANION_CONFIG,
        repoFullName: REPO,
        action: COMPANION_ACTION,
      },
    });
  const makeReview = () =>
    createTestAutomation({
      db,
      userId: user.id,
      values: {
        organizationId: orgId,
        triggerType: "pull_request",
        repoFullName: REPO,
      },
    });

  it("stamps the companion (PR, head, skill), turns checkpointing off and renders the untrusted context", async () => {
    const automation = await makeCompanion();
    const ok = await runPullRequestAutomation({
      userId: user.id,
      automationId: automation.id,
      repoFullName: REPO,
      prEventAction: "synchronize",
      prNumber: 7,
      source: "automated",
    });
    expect(ok).toBe(true);
    expect(createNewThread).toHaveBeenCalledTimes(1);
    const args = vi.mocked(createNewThread).mock.calls[0]![0];
    expect(args.sourceMetadata).toMatchObject({
      type: "automation-skill",
      skillName: FLUTTER_COMPANION_SKILL_NAME,
      companion: {
        repoFullName: REPO,
        prNumber: 7,
        headSha: HEAD_SHA,
        skillName: FLUTTER_COMPANION_SKILL_NAME,
      },
    });
    expect(args.disableGitCheckpointing).toBe(true);
    expect(args.githubPRNumber).toBe(7);
    expect(args.reviewedSha).toBe(HEAD_SHA);
    const text = args.message.parts
      .map((part) => ("text" in part ? part.text : ""))
      .join("\n");
    expect(text).toContain("PREFETCHED-CONTEXT");
    expect(text).not.toContain("<!-- automata:context");
    // {{baseBranch}} renders to the PR's BASE ref, never its head.
    expect(text).toContain("git diff origin/main...HEAD");
    expect(text).not.toContain("{{baseBranch}}");
  });

  it("a review automation's thread carries no companion stamp", async () => {
    const automation = await makeReview();
    await runPullRequestAutomation({
      userId: user.id,
      automationId: automation.id,
      repoFullName: REPO,
      prEventAction: "synchronize",
      prNumber: 7,
      source: "automated",
    });
    const args = vi.mocked(createNewThread).mock.calls[0]![0];
    expect(
      (args.sourceMetadata as { companion?: unknown } | undefined)?.companion,
    ).toBeUndefined();
  });

  it("neither archives nor stops the review lane's live thread on the same PR (and vice versa)", async () => {
    const review = await makeReview();
    const companion = await makeCompanion();
    const live = (automationId: string) =>
      createTestThread({
        db,
        userId: user.id,
        overrides: {
          organizationId: orgId,
          automationId,
          githubRepoFullName: REPO,
          githubPRNumber: 7,
        },
        chatOverrides: { status: "working" },
      });
    const reviewThread = await live(review.id);
    const companionThread = await live(companion.id);

    for (const automationId of [companion.id, review.id]) {
      await runPullRequestAutomation({
        userId: user.id,
        automationId,
        repoFullName: REPO,
        prEventAction: "synchronize",
        prNumber: 7,
        source: "automated",
      });
    }
    expect(createNewThread).toHaveBeenCalledTimes(2);
    expect(archiveAndStopThread).not.toHaveBeenCalled();
    for (const { threadId } of [reviewThread, companionThread]) {
      const row = await getThreadMinimal({ db, userId: user.id, threadId });
      expect(row?.archived).toBe(false);
    }
  });

  it("the lane predicate: a companion is never a review thread", async () => {
    const review = await makeReview();
    const companion = await makeCompanion();
    const lane = (automationId: string | null) =>
      getPrAutomationLane({
        db,
        userId: user.id,
        automationId,
        organizationId: orgId,
      });
    expect(await lane(review.id)).toBe("review");
    expect(await lane(companion.id)).toBe("companion");
    expect(await lane(null)).toBeNull();
    expect(
      await isReviewThread({
        db,
        userId: user.id,
        automationId: companion.id,
        organizationId: orgId,
      }),
    ).toBe(false);
    expect(
      await isReviewThread({
        db,
        userId: user.id,
        automationId: review.id,
        organizationId: orgId,
      }),
    ).toBe(true);
  });
});

describe("self-heal: a companion never counts as the fix PR's reviewer", () => {
  it("reviewsBotPullRequests is false for a companion, true for the same review config", () => {
    const base = {
      triggerType: "pull_request" as const,
      triggerConfig: {
        filter: { includeAllAuthors: true },
        on: { open: true },
      },
    };
    expect(reviewsBotPullRequests(base as never, "app[bot]")).toBe(true);
    expect(
      reviewsBotPullRequests(
        {
          ...base,
          triggerConfig: {
            ...base.triggerConfig,
            filter: { includeAllAuthors: true, companion: true },
          },
        } as never,
        "app[bot]",
      ),
    ).toBe(false);
  });
});

describe("validateAutomationCreationOrUpdate — PR companion", () => {
  let user: User;

  beforeEach(async () => {
    user = (await createTestUser({ db })).user;
  });

  const validate = (
    triggerConfig: PullRequestTriggerConfig,
    action: AutomationAction = COMPANION_ACTION,
  ) =>
    validateAutomationCreationOrUpdate({
      userId: user.id,
      automationId: null,
      updates: {
        name: "companion",
        repoFullName: "owner/repo",
        branchName: "main",
        triggerType: "pull_request",
        triggerConfig,
        action,
      },
    });

  it("accepts a skill companion pinned to review, or with no mode", async () => {
    await expect(validate(COMPANION_CONFIG)).resolves.toBeDefined();
    const { permissionMode: _mode, ...unpinned } = COMPANION_CONFIG;
    await expect(validate(unpinned)).resolves.toBeDefined();
  });

  it("rejects a companion that is not a skill", async () => {
    await expect(
      validate(COMPANION_CONFIG, {
        type: "user_message",
        config: {
          message: {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "look at it" }],
            timestamp: new Date().toISOString(),
          },
        },
      }),
    ).rejects.toThrow(/must run a skill/);
  });

  it("rejects a companion configured above review", async () => {
    await expect(
      validate({ ...COMPANION_CONFIG, permissionMode: "allowAll" }),
    ).rejects.toThrow(/emit-only/);
    await expect(
      validate({ ...COMPANION_CONFIG, permissionMode: "plan" }),
    ).rejects.toThrow(/emit-only/);
  });

  it("a review automation keeps its configurable mode", async () => {
    await expect(
      validate({
        filter: { includeAllAuthors: true },
        on: { open: true },
        permissionMode: "allowAll",
      }),
    ).resolves.toBeDefined();
  });
});
