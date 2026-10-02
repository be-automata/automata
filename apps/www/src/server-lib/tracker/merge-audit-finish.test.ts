import { beforeEach, describe, expect, it, vi } from "vitest";

import { getOctokitForApp } from "@/lib/github";

import {
  createAuditCommentClient,
  runMergeAuditAtFinish,
} from "./merge-audit-finish";
import { resolveTrackerConfig } from "./tracker-config";

// `@/lib/github` is already mocked by the global test setup: getOctokitForApp
// is a vi.fn(), parseRepoFullName is the real one.

vi.mock("./tracker-config", () => ({
  resolveTrackerConfig: vi.fn().mockResolvedValue(null),
}));

const MARKER = "<!-- automata:pr-merged-audit:7 -->";
const BOT = "test-app[bot]";

function fakeOctokit(
  existing: Array<{ id: number; login: string | null; body: string }>,
) {
  const listComments = vi.fn();
  const octokit = {
    paginate: vi.fn(async () =>
      existing.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: comment.login === null ? null : { login: comment.login },
      })),
    ),
    rest: {
      issues: {
        listComments,
        createComment: vi.fn(async () => ({})),
        updateComment: vi.fn(async () => ({})),
      },
    },
  };
  return octokit;
}

function client(octokit: ReturnType<typeof fakeOctokit>, since?: string) {
  return createAuditCommentClient({
    // Structural fake: only the three calls the client makes are implemented.
    octokit: octokit as unknown as Parameters<
      typeof createAuditCommentClient
    >[0]["octokit"],
    owner: "acme-inc",
    repo: "acme-core",
    prNumber: 7,
    botLogin: BOT,
    since,
  });
}

describe("createAuditCommentClient.upsertMarkerComment", () => {
  it("creates the comment when the bot has none", async () => {
    const octokit = fakeOctokit([{ id: 1, login: "octocat", body: "LGTM" }]);
    await client(octokit).upsertMarkerComment(
      MARKER,
      `${MARKER}\nbody`,
      "replace",
    );

    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: "acme-inc",
      repo: "acme-core",
      issue_number: 7,
      body: `${MARKER}\nbody`,
    });
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("updates the bot's own marker comment in place", async () => {
    const octokit = fakeOctokit([
      { id: 1, login: "octocat", body: "LGTM" },
      { id: 2, login: BOT, body: `${MARKER}\nold` },
    ]);
    await client(octokit).upsertMarkerComment(
      MARKER,
      `${MARKER}\nnew`,
      "replace",
    );

    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith({
      owner: "acme-inc",
      repo: "acme-core",
      comment_id: 2,
      body: `${MARKER}\nnew`,
    });
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("ignores a marker planted in someone else's comment", async () => {
    // The App cannot edit another user's comment; matching on the marker alone
    // would make every audit fail on a PR where it was pasted.
    const octokit = fakeOctokit([
      { id: 5, login: "mallory", body: `${MARKER}\nfake audit` },
      { id: 6, login: null, body: MARKER },
    ]);
    await client(octokit).upsertMarkerComment(
      MARKER,
      `${MARKER}\nreal`,
      "replace",
    );

    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it("does not treat the bot's other comments as the audit", async () => {
    const octokit = fakeOctokit([
      {
        id: 9,
        login: BOT,
        body: "<!-- automata:pr-merged-audit:70 -->\nother PR marker",
      },
    ]);
    await client(octokit).upsertMarkerComment(
      MARKER,
      `${MARKER}\nbody`,
      "replace",
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it("create-only leaves an existing bot comment untouched and posts nothing", async () => {
    const octokit = fakeOctokit([
      { id: 2, login: BOT, body: `${MARKER}\naudit` },
    ]);
    await client(octokit).upsertMarkerComment(
      MARKER,
      `${MARKER}\nnotice`,
      "create-only",
    );
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("reports what it did, so a kept comment is distinguishable from a new one", async () => {
    const empty = fakeOctokit([]);
    expect(
      await client(empty).upsertMarkerComment(MARKER, MARKER, "create-only"),
    ).toBe("created");

    const existing = [{ id: 2, login: BOT, body: `${MARKER}\naudit` }];
    expect(
      await client(fakeOctokit(existing)).upsertMarkerComment(
        MARKER,
        MARKER,
        "create-only",
      ),
    ).toBe("kept_existing");
    expect(
      await client(fakeOctokit(existing)).upsertMarkerComment(
        MARKER,
        MARKER,
        "replace",
      ),
    ).toBe("updated");
  });

  it("lists only comments since the merge", async () => {
    const octokit = fakeOctokit([]);
    await client(octokit, "2026-10-01T10:00:00Z").upsertMarkerComment(
      MARKER,
      MARKER,
      "replace",
    );
    expect(octokit.paginate).toHaveBeenCalledWith(
      octokit.rest.issues.listComments,
      expect.objectContaining({ since: "2026-10-01T10:00:00Z" }),
    );
  });

  it("create-only still creates the first comment", async () => {
    const octokit = fakeOctokit([]);
    await client(octokit).upsertMarkerComment(
      MARKER,
      `${MARKER}\nnotice`,
      "create-only",
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });
});

describe("runMergeAuditAtFinish", () => {
  beforeEach(() => vi.clearAllMocks());

  const base = {
    db: {} as Parameters<typeof runMergeAuditAtFinish>[0]["db"],
    userId: "u1",
    organizationId: "o1",
    repoFullName: "acme-inc/acme-core",
    prNumber: 7,
    terminalText: "",
    botLogin: BOT,
  };

  function prResponse(merged: boolean) {
    return {
      data: {
        merged,
        title: "feat(ACME-1): x",
        body: "",
        head: { ref: "ACME-1-x" },
        html_url: "https://github.com/acme-inc/acme-core/pull/7",
        merged_by: { login: "octocat" },
      },
    };
  }

  it("never touches a ticket or the PR for a pull request that is not merged", async () => {
    const octokit = fakeOctokit([]);
    const get = vi.fn(async () => prResponse(false));
    vi.mocked(getOctokitForApp).mockResolvedValue({
      ...octokit,
      rest: { ...octokit.rest, pulls: { get } },
    } as unknown as Awaited<ReturnType<typeof getOctokitForApp>>);

    const outcome = await runMergeAuditAtFinish(base);

    expect(outcome).toEqual({ outcome: "skipped_not_merged" });
    expect(resolveTrackerConfig).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("an invalid tracker URL reads as unconfigured and is reported on the PR, not thrown", async () => {
    const octokit = fakeOctokit([]);
    vi.mocked(getOctokitForApp).mockResolvedValue({
      ...octokit,
      rest: {
        ...octokit.rest,
        pulls: { get: vi.fn(async () => prResponse(true)) },
      },
    } as unknown as Awaited<ReturnType<typeof getOctokitForApp>>);
    vi.mocked(resolveTrackerConfig).mockRejectedValueOnce(
      new Error("tracker base URL must use https"),
    );

    const outcome = await runMergeAuditAtFinish(base);

    expect(outcome).toEqual({ outcome: "tracker_unconfigured" });
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });
});
