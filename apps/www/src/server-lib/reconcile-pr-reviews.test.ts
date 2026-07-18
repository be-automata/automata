import { describe, it, vi, beforeEach, expect } from "vitest";
import { reconcilePrReviews } from "./reconcile-pr-reviews";
import { getOctokitForApp } from "@/lib/github";

// Keep parseRepoFullName real; mock only the App-octokit factory (the GitHub seam).
vi.mock("@/lib/github", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, getOctokitForApp: vi.fn() };
});

const BOT = "test-app[bot]"; // NEXT_PUBLIC_GITHUB_APP_NAME=test-app → `${name}[bot]`

function review(
  id: number,
  state: string,
  submitted_at: string,
  commit_id = "sha1",
  login = BOT,
) {
  return { id, state, submitted_at, commit_id, user: { login } };
}

function mockOctokit(reviews: unknown[]) {
  const dismissReview = vi.fn().mockResolvedValue({});
  const listReviews = { __ref: "listReviews" };
  const octokit = {
    paginate: vi.fn(async () => reviews),
    rest: { pulls: { listReviews, dismissReview } },
  };
  vi.mocked(getOctokitForApp).mockResolvedValue(octokit as never);
  return { octokit, dismissReview };
}

describe("reconcilePrReviews (ADR-036 interim, London-style on the GitHub seam)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("S1: dismisses the later duplicate CR, keeps the earliest, reports dup_reconciled=1", async () => {
    const { dismissReview } = mockOctokit([
      review(823, "CHANGES_REQUESTED", "2026-07-18T09:33:58Z"),
      review(904, "CHANGES_REQUESTED", "2026-07-18T09:34:03Z"),
    ]);

    const result = await reconcilePrReviews({
      repoFullName: "be-automata/automata",
      prNumber: 3,
    });

    expect(result).toEqual({ dupReconciled: 1 });
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "be-automata",
        repo: "automata",
        pull_number: 3,
        review_id: 904, // the later dup, not the keeper
        message: expect.stringMatching(/Duplicate of review 823/),
      }),
    );
  });

  it("verdict upgrade: dismisses (supersedes) the APPROVE, keeps the CR", async () => {
    const { dismissReview } = mockOctokit([
      review(1, "APPROVED", "2026-07-18T09:00:00Z"),
      review(2, "CHANGES_REQUESTED", "2026-07-18T09:05:00Z"),
    ]);

    const result = await reconcilePrReviews({
      repoFullName: "o/r",
      prNumber: 5,
    });

    expect(result).toEqual({ dupReconciled: 1 });
    expect(dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({
        review_id: 1,
        message: expect.stringMatching(/Superseded/),
      }),
    );
  });

  it("COMMENTED reviews are never dismissed (would 422)", async () => {
    const { dismissReview } = mockOctokit([
      review(1, "CHANGES_REQUESTED", "2026-07-18T09:00:00Z"),
      review(2, "COMMENTED", "2026-07-18T09:01:00Z"),
    ]);

    const result = await reconcilePrReviews({ repoFullName: "o/r", prNumber: 1 });

    expect(result).toEqual({ dupReconciled: 0 });
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it("zero-dup: a single bot review → no dismissals (no-op)", async () => {
    const { dismissReview } = mockOctokit([
      review(1, "CHANGES_REQUESTED", "2026-07-18T09:00:00Z"),
    ]);
    const result = await reconcilePrReviews({ repoFullName: "o/r", prNumber: 1 });
    expect(result).toEqual({ dupReconciled: 0 });
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it("ignores reviews from other authors (never dismisses a non-bot review)", async () => {
    const { dismissReview } = mockOctokit([
      review(1, "CHANGES_REQUESTED", "2026-07-18T09:00:00Z", "sha1", "a-human"),
      review(2, "CHANGES_REQUESTED", "2026-07-18T09:01:00Z", "sha1", "another-human"),
    ]);
    const result = await reconcilePrReviews({ repoFullName: "o/r", prNumber: 1 });
    expect(result).toEqual({ dupReconciled: 0 });
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it("fail-soft: a dismiss failure is swallowed and the rest continue", async () => {
    const dismissReview = vi
      .fn()
      .mockRejectedValueOnce(new Error("422"))
      .mockResolvedValue({});
    const octokit = {
      paginate: vi.fn(async () => [
        review(1, "CHANGES_REQUESTED", "2026-07-18T09:00:00Z"),
        review(2, "CHANGES_REQUESTED", "2026-07-18T09:01:00Z"),
        review(3, "CHANGES_REQUESTED", "2026-07-18T09:02:00Z"),
      ]),
      rest: { pulls: { listReviews: {}, dismissReview } },
    };
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as never);

    // Keeper = review 1 (earliest). Dismiss 2 (fails) + 3 (succeeds).
    const result = await reconcilePrReviews({ repoFullName: "o/r", prNumber: 1 });
    expect(dismissReview).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ dupReconciled: 1 }); // only the successful one counted
  });

  it("fail-soft: a listReviews failure never throws (returns null)", async () => {
    const octokit = {
      paginate: vi.fn(async () => {
        throw new Error("network");
      }),
      rest: { pulls: { listReviews: {}, dismissReview: vi.fn() } },
    };
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as never);

    const result = await reconcilePrReviews({ repoFullName: "o/r", prNumber: 1 });
    expect(result).toBeNull();
  });
});
