import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "@terragon/shared/db";
import { nanoid } from "nanoid";
import { createOrganization } from "@terragon/shared/model/organizations";
import { upsertRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";
import type {
  GitHubReview,
  ReviewGitHubClient,
} from "@terragon/review/state/review-github-client";
import { resolveApproveFloor } from "./resolve-approve-floor";
import { resolveReviewDraftPolicy } from "./resolve-review-draft-policy";
import { executeReviewFromIntent } from "./execute-review-from-intent";

/**
 * BOOTED-STACK integration UAT (real Neon container). Drives the exact chain the
 * production finish hook runs — resolveApproveFloor (real DB read) →
 * executeReviewFromIntent (real server-side floor) — plus the intake draft gate's
 * resolver, end-to-end. The ONLY stubbed seam is the external GitHub API
 * (ReviewGitHubClient); everything else is the real code path against a real
 * database. Proves that a tolerance STORED via the model changes the verdict a
 * real PR review would post, live, with no restart.
 *
 * Mirrors docs/uat/review-tolerance-and-drafts.md cases TOL-1/2/3 + DRAFT-1/2 at
 * the integration layer; the live-GitHub smoke is the remaining tier.
 */

const db = createDb(env.DATABASE_URL!);
const BOT = "automata-ai-bot[bot]";
const REPO = "acme/widgets";
const PR = 42;
const HEAD = "head-sha-42";

function makeGithub(reviews: GitHubReview[] = []) {
  return {
    listReviews: vi.fn(async (_repo: string, _pr: number) => reviews),
    submitReview: vi.fn(
      async (
        _repo: string,
        _pr: number,
        _verdict: "APPROVE" | "REQUEST_CHANGES",
        _body: string,
      ) => {},
    ),
    submitReviewWithComments: vi.fn(
      async (
        _repo: string,
        _pr: number,
        _sha: string,
        _verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
        _body: string,
        _comments: Array<{ path: string; line: number; body: string }>,
      ) => {},
    ),
    dismissReview: vi.fn(
      async (_repo: string, _pr: number, _id: number, _msg: string) => {},
    ),
    postInlineComment: vi.fn(
      async (
        _repo: string,
        _pr: number,
        _path: string,
        _line: number,
        _body: string,
        _sha: string,
      ) => {},
    ),
  } satisfies ReviewGitHubClient;
}

/** An emit-only agent output: `approve` verdict carrying one finding. */
function emittedApproveWith(severity: string): string {
  return `Reviewed.\n\n\`\`\`json\n${JSON.stringify({
    verdict: "approve",
    commit: HEAD,
    summary: "Overall fine.",
    findings: [{ severity, path: "a.ts", line: 3, body: "concern" }],
  })}\n\`\`\`\n`;
}

/** The production finish-handler chain, minus the thread/octokit lookup. */
async function reviewWithStoredPolicy(args: {
  organizationId: string;
  terminalText: string;
  isDraft?: boolean;
}) {
  const github = makeGithub([]);
  const approveFloorPolicy = await resolveApproveFloor({
    db,
    organizationId: args.organizationId,
    repoFullName: REPO,
  });
  const outcome = await executeReviewFromIntent({
    github,
    repoFullName: REPO,
    prNumber: PR,
    botLogin: BOT,
    currentHeadSha: HEAD,
    terminalText: args.terminalText,
    approveFloorPolicy,
    isDraft: args.isDraft,
  });
  return { github, outcome };
}

describe("review-tolerance booted-stack integration (real DB → resolve → execute)", () => {
  let orgId: string;
  beforeEach(async () => {
    const org = await createOrganization({
      db,
      name: "acme",
      slug: `acme-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
  });

  it("TOL-1: default floor (no row) → a warning finding BLOCKS (request_changes)", async () => {
    const { github, outcome } = await reviewWithStoredPolicy({
      organizationId: orgId,
      terminalText: emittedApproveWith("warning"),
    });
    expect(outcome).toMatchObject({
      outcome: "posted",
      verdict: "request_changes",
    });
    expect(github.submitReview.mock.calls[0]![2]).toBe("REQUEST_CHANGES");
  });

  it("TOL-2: store tolerance=error → the SAME warning finding no longer blocks (COMMENT), live, no restart", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { blockTolerance: "error" },
    });
    const { github, outcome } = await reviewWithStoredPolicy({
      organizationId: orgId,
      terminalText: emittedApproveWith("warning"),
    });
    expect(outcome).toMatchObject({ outcome: "posted", verdict: "comment" });
    expect(github.submitReviewWithComments.mock.calls[0]![3]).toBe("COMMENT");
    expect(github.submitReview).not.toHaveBeenCalled();
  });

  it("TOL-3: store tolerance=info → an info-only nit BLOCKS (request_changes)", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { blockTolerance: "info" },
    });
    const { github, outcome } = await reviewWithStoredPolicy({
      organizationId: orgId,
      terminalText: emittedApproveWith("info"),
    });
    expect(outcome).toMatchObject({
      outcome: "posted",
      verdict: "request_changes",
    });
    expect(github.submitReview.mock.calls[0]![2]).toBe("REQUEST_CHANGES");
  });

  it("draft cap: even with a blocking floor, a DRAFT PR caps at COMMENT", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { blockTolerance: "info" },
    });
    const { github, outcome } = await reviewWithStoredPolicy({
      organizationId: orgId,
      terminalText: emittedApproveWith("error"),
      isDraft: true,
    });
    expect(outcome).toMatchObject({ outcome: "posted", verdict: "comment" });
    expect(github.submitReview).not.toHaveBeenCalled();
  });

  it("DRAFT-1: default (no row) → intake engages drafts (policy true)", async () => {
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
      }),
    ).toBe(true);
  });

  it("DRAFT-2: store reviewDraftPrs=false → intake gate ignores drafts; re-enable brings it back, live", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { reviewDraftPrs: false },
    });
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
        automationIncludeDraftPrs: true, // even an opt-in automation is overridden
      }),
    ).toBe(false);

    // A tolerance change must NOT disturb the draft policy (partial upsert).
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { blockTolerance: "error" },
    });
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
      }),
    ).toBe(false);

    // Re-enable → engages again on the next webhook.
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { reviewDraftPrs: true },
    });
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
      }),
    ).toBe(true);
  });
});
