import { describe, it, vi, beforeEach, expect } from "vitest";
import {
  handlePullRequestMirror,
  handlePullRequestReviewMirror,
  handleWorkflowRunEvent,
  handleIssueLabeledMirror,
} from "./handlers";
import { createMirrorTask } from "./mirror-intake";

vi.mock("./mirror-intake", () => ({
  createMirrorTask: vi.fn(() => Promise.resolve()),
}));

const repo = {
  full_name: "be-automata/automata",
  owner: { login: "be-automata" },
};
const installation = { id: 12345678 };
const pr = (over: Record<string, unknown> = {}) => ({
  number: 42,
  merged: false,
  head: { ref: "feature" },
  base: { ref: "main" },
  ...over,
});

function intentKind() {
  return vi.mocked(createMirrorTask).mock.calls[0]?.[0]?.intent.kind;
}

describe("mirror handlers — routing + filtering", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("handlePullRequestMirror", () => {
    it("review_requested → pr-review-requested", async () => {
      await handlePullRequestMirror({
        action: "review_requested",
        repository: repo,
        installation,
        pull_request: pr(),
      } as any);
      expect(createMirrorTask).toHaveBeenCalledTimes(1);
      expect(intentKind()).toBe("pr-review-requested");
    });

    it("closed + merged=true → pr-merged", async () => {
      await handlePullRequestMirror({
        action: "closed",
        repository: repo,
        installation,
        pull_request: pr({ merged: true }),
      } as any);
      expect(intentKind()).toBe("pr-merged");
    });

    it("closed + merged=true carries the PR fields the post-merge audit reads", async () => {
      await handlePullRequestMirror({
        action: "closed",
        repository: repo,
        installation,
        pull_request: pr({
          merged: true,
          number: 7,
          title: "feat(ACME-812): void predictions",
          body: "Closes ACME-812",
          html_url: "https://github.com/be-automata/automata/pull/7",
          merged_by: { login: "octocat" },
          merge_commit_sha: "abc123",
          head: { ref: "ACME-812-void" },
          base: { ref: "develop" },
        }),
      } as any);
      expect(vi.mocked(createMirrorTask).mock.calls[0]![0].intent).toEqual({
        kind: "pr-merged",
        prNumber: 7,
        baseBranch: "develop",
        headBranch: "ACME-812-void",
        title: "feat(ACME-812): void predictions",
        body: "Closes ACME-812",
        htmlUrl: "https://github.com/be-automata/automata/pull/7",
        mergedBy: "octocat",
        mergeCommitSha: "abc123",
      });
    });

    it("closed + merged=false → no task", async () => {
      await handlePullRequestMirror({
        action: "closed",
        repository: repo,
        installation,
        pull_request: pr({ merged: false }),
      } as any);
      expect(createMirrorTask).not.toHaveBeenCalled();
    });
  });

  describe("handlePullRequestReviewMirror", () => {
    it("submitted + changes_requested → pr-changes-requested", async () => {
      await handlePullRequestReviewMirror({
        action: "submitted",
        repository: repo,
        installation,
        review: { state: "changes_requested" },
        pull_request: pr(),
      } as any);
      expect(intentKind()).toBe("pr-changes-requested");
    });

    it("submitted + approved → no task", async () => {
      await handlePullRequestReviewMirror({
        action: "submitted",
        repository: repo,
        installation,
        review: { state: "approved" },
        pull_request: pr(),
      } as any);
      expect(createMirrorTask).not.toHaveBeenCalled();
    });
  });

  describe("handleWorkflowRunEvent", () => {
    it("completed + failure → ci-failure", async () => {
      await handleWorkflowRunEvent({
        action: "completed",
        repository: repo,
        installation,
        workflow_run: {
          conclusion: "failure",
          name: "CI",
          id: 5,
          head_branch: "main",
        },
      } as any);
      expect(intentKind()).toBe("ci-failure");
    });

    it("completed + failure on a self-heal fix branch → no task (GATE-01)", async () => {
      await handleWorkflowRunEvent({
        action: "completed",
        repository: repo,
        installation,
        workflow_run: {
          conclusion: "failure",
          name: "CI",
          id: 7,
          head_branch: "automata/fix-12-abcdef01-a1",
        },
      } as any);
      expect(createMirrorTask).not.toHaveBeenCalled();
    });

    it("completed + success → no task", async () => {
      await handleWorkflowRunEvent({
        action: "completed",
        repository: repo,
        installation,
        workflow_run: { conclusion: "success", name: "CI", id: 6 },
      } as any);
      expect(createMirrorTask).not.toHaveBeenCalled();
    });
  });

  describe("handleIssueLabeledMirror", () => {
    it("labeled bug → issue-labeled", async () => {
      await handleIssueLabeledMirror({
        action: "labeled",
        repository: repo,
        installation,
        issue: { number: 99 },
        label: { name: "bug" },
      } as any);
      expect(intentKind()).toBe("issue-labeled");
    });

    it("labeled with a non-mirrored label → no task", async () => {
      await handleIssueLabeledMirror({
        action: "labeled",
        repository: repo,
        installation,
        issue: { number: 99 },
        label: { name: "question" },
      } as any);
      expect(createMirrorTask).not.toHaveBeenCalled();
    });
  });
});
