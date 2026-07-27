import { describe, it, vi, beforeEach, expect } from "vitest";
import { getUserRepos } from "./user-repos";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import {
  mockLoggedInUser,
  mockLoggedOutUser,
} from "@/test-helpers/mock-next";
import { getOctokitForUser } from "@/lib/github";
import { unwrapResult } from "@/lib/server-actions";
import { Session } from "@terragon/shared";

function makeRepo({
  id,
  fullName,
  push,
  pushedAt,
}: {
  id: number;
  fullName: string;
  push: boolean;
  pushedAt: string | null;
}) {
  return {
    id,
    full_name: fullName,
    permissions: { push },
    pushed_at: pushedAt,
  };
}

function makeOctokit({
  installations,
  repos,
}: {
  installations: Array<{ id: number }>;
  repos: unknown[];
}) {
  return {
    rest: {
      apps: {
        listInstallationsForAuthenticatedUser: vi
          .fn()
          .mockResolvedValue({ data: { installations } }),
        listInstallationReposForAuthenticatedUser: vi.fn(),
      },
    },
    paginate: vi.fn().mockResolvedValue(repos),
  };
}

describe("getUserRepos", () => {
  let session: Session;

  beforeEach(async () => {
    vi.clearAllMocks();
    const testUserResult = await createTestUser({ db });
    session = testUserResult.session;
    await mockLoggedInUser(session);
  });

  it("returns githubTokenMissing when the user has no usable GitHub token", async () => {
    // getOctokitForUser returns null for: no github account row, a row with a
    // NULL access_token (e.g. linked in backstage without completing OAuth),
    // or a token that fails to decrypt.
    vi.mocked(getOctokitForUser).mockResolvedValue(null);

    const result = unwrapResult(await getUserRepos());

    expect(result.repos).toEqual([]);
    expect(result.githubTokenMissing).toBe(true);
  });

  it("returns pushable repos sorted by most recent push when token works", async () => {
    const octokit = makeOctokit({
      installations: [{ id: 1 }],
      repos: [
        makeRepo({
          id: 1,
          fullName: "org/older",
          push: true,
          pushedAt: "2026-01-01T00:00:00Z",
        }),
        makeRepo({
          id: 2,
          fullName: "org/read-only",
          push: false,
          pushedAt: "2026-03-01T00:00:00Z",
        }),
        makeRepo({
          id: 3,
          fullName: "org/newer",
          push: true,
          pushedAt: "2026-02-01T00:00:00Z",
        }),
      ],
    });
    vi.mocked(getOctokitForUser).mockResolvedValue(octokit as any);

    const result = unwrapResult(await getUserRepos());

    expect(result.repos.map((r) => r.full_name)).toEqual([
      "org/newer",
      "org/older",
    ]);
    expect(result.githubTokenMissing).toBeUndefined();
  });

  it("returns empty repos WITHOUT githubTokenMissing when the GitHub API fails", async () => {
    const octokit = makeOctokit({ installations: [{ id: 1 }], repos: [] });
    octokit.rest.apps.listInstallationsForAuthenticatedUser.mockRejectedValue(
      new Error("401 Bad credentials"),
    );
    vi.mocked(getOctokitForUser).mockResolvedValue(octokit as any);

    const result = unwrapResult(await getUserRepos());

    expect(result.repos).toEqual([]);
    expect(result.githubTokenMissing).toBeUndefined();
  });

  it("returns empty repos when the token works but no installations exist", async () => {
    const octokit = makeOctokit({ installations: [], repos: [] });
    vi.mocked(getOctokitForUser).mockResolvedValue(octokit as any);

    const result = unwrapResult(await getUserRepos());

    expect(result.repos).toEqual([]);
    expect(result.githubTokenMissing).toBeUndefined();
  });

  it("rejects logged-out callers", async () => {
    await mockLoggedOutUser();
    const result = await getUserRepos();
    expect(result.success).toBe(false);
  });
});
