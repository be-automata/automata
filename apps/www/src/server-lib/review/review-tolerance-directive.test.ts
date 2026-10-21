import { describe, it, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
  createTestAutomation,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { setRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";
import { upsertOrganizationReviewSetting } from "@terragon/shared/model/organization-review-settings";
import { nanoid } from "nanoid";
import { computeReviewToleranceDirective } from "./review-tolerance-directive";

/**
 * The directive is injected MODE-AGNOSTICALLY: computeReviewToleranceDirective
 * never reads REVIEW_SINGLE_WRITER, so the same directive is produced whether the
 * flag is on or off. These tests pin that structural guarantee — a regression
 * that re-gates the tolerance on the flag would fail here.
 */
describe("computeReviewToleranceDirective (mode-agnostic)", () => {
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    const org = await createOrganization({
      db,
      name: "acme",
      slug: `acme-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
  });

  async function makeReviewThread(repoFullName: string): Promise<string> {
    const automation = await createTestAutomation({
      db,
      userId,
      values: {
        organizationId: orgId,
        repoFullName,
        triggerType: "pull_request",
        triggerConfig: {
          on: { open: true, update: true },
          filter: { includeAllAuthors: true },
        },
      },
    });
    const { threadId } = await createTestThread({
      db,
      userId,
      overrides: {
        organizationId: orgId,
        automationId: automation.id,
        githubRepoFullName: repoFullName,
        githubPRNumber: 1,
      },
    });
    return threadId;
  }

  it("emits the directive for a review thread (default warning floor, no override)", async () => {
    const threadId = await makeReviewThread("acme/widgets");
    const { directive, isReview } = await computeReviewToleranceDirective({
      db,
      userId,
      threadId,
    });
    expect(isReview).toBe(true);
    expect(directive).toContain("Repository review tolerance: `warning`");
    expect(directive).toContain(
      "at `warning` or higher force `request_changes`",
    );
  });

  it("reflects the stored per-repo floor: error → warnings are surfaced as comment", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      blockTolerance: "error",
    });
    const threadId = await makeReviewThread("acme/widgets");
    const { directive } = await computeReviewToleranceDirective({
      db,
      userId,
      threadId,
    });
    expect(directive).toContain("Repository review tolerance: `error`");
    expect(directive).toContain("SURFACED as a `comment`");
    expect(directive).toContain("MUST NOT block");
  });

  it("info floor → the directive forces request_changes on every finding", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      blockTolerance: "info",
    });
    const threadId = await makeReviewThread("acme/widgets");
    const { directive } = await computeReviewToleranceDirective({
      db,
      userId,
      threadId,
    });
    expect(directive).toContain("Repository review tolerance: `info`");
    expect(directive).toContain("EVERY finding — including `info`");
  });

  it("org floor tightens the rendered directive: org warning + repo error → directive reflects warning", async () => {
    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgId,
      patch: { blockTolerance: "warning" },
    });
    await setRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      blockTolerance: "error",
    });
    const threadId = await makeReviewThread("acme/widgets");
    const { directive } = await computeReviewToleranceDirective({
      db,
      userId,
      threadId,
    });
    expect(directive).toContain("Repository review tolerance: `warning`");
    expect(directive).toContain(
      "at `warning` or higher force `request_changes`",
    );
  });

  it("emits NO directive for a non-review (non-pull_request) thread", async () => {
    const { threadId } = await createTestThread({
      db,
      userId,
      overrides: { organizationId: orgId, githubRepoFullName: "acme/widgets" },
    });
    const { directive, isReview } = await computeReviewToleranceDirective({
      db,
      userId,
      threadId,
    });
    expect(isReview).toBe(false);
    expect(directive).toBe("");
  });

  async function makeMentionThread(
    repoFullName: string,
    githubPRNumber: number | null,
  ): Promise<string> {
    const automation = await createTestAutomation({
      db,
      userId,
      values: {
        organizationId: orgId,
        repoFullName,
        triggerType: "github_mention",
        triggerConfig: { filter: { orgLane: true } },
      },
    });
    const { threadId } = await createTestThread({
      db,
      userId,
      overrides: {
        organizationId: orgId,
        automationId: automation.id,
        githubRepoFullName: repoFullName,
        githubPRNumber,
      },
    });
    return threadId;
  }

  it("a mention on a PR gets the repo's directive but is not a review thread (no review permission cap)", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      blockTolerance: "info",
    });
    const threadId = await makeMentionThread("acme/widgets", 7);
    const { directive, isReview } = await computeReviewToleranceDirective({
      db,
      userId,
      threadId,
    });
    expect(isReview).toBe(false);
    expect(directive).toContain("Repository review tolerance: `info`");
    expect(directive).toContain("EVERY finding — including `info`");
  });

  it("a mention on an issue gets no directive", async () => {
    const threadId = await makeMentionThread("acme/widgets", null);
    const { directive, isReview } = await computeReviewToleranceDirective({
      db,
      userId,
      threadId,
    });
    expect(isReview).toBe(false);
    expect(directive).toBe("");
  });
});
