import { describe, it, vi, beforeEach, expect } from "vitest";
import { getUserRepos } from "./user-repos";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { mockLoggedInUser, mockLoggedOutUser } from "@/test-helpers/mock-next";
import { getOctokitForUser } from "@/lib/github";
import { unwrapResult } from "@/lib/server-actions";
import { Session } from "@terragon/shared";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  addOrganizationMember,
  createOrganization,
} from "@terragon/shared/model/organizations";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { session as sessionTable } from "@terragon/shared/db/schema";

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

/** An octokit whose installations each list their own repos. */
function makeScopedOctokit(reposByInstallation: Record<number, unknown[]>) {
  return {
    rest: {
      apps: {
        listInstallationsForAuthenticatedUser: vi.fn().mockResolvedValue({
          data: {
            installations: Object.keys(reposByInstallation).map((id) => ({
              id: Number(id),
            })),
          },
        }),
        listInstallationReposForAuthenticatedUser: vi.fn(),
      },
    },
    paginate: vi.fn(
      async (_fn: unknown, params: { installation_id: number }) =>
        reposByInstallation[params.installation_id] ?? [],
    ),
  };
}

describe("getUserRepos", () => {
  let session: Session;
  let userId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const testUserResult = await createTestUser({ db });
    session = testUserResult.session;
    userId = testUserResult.user.id;
    await mockLoggedInUser(session);
  });

  describe("scoped to the active org", () => {
    let orgId: string;
    let boundInstallation: number;
    let otherInstallation: number;

    beforeEach(async () => {
      const org = await createOrganization({
        db,
        name: "Acme",
        slug: `acme-${nanoid(8).toLowerCase()}`,
      });
      orgId = org.id;
      await addOrganizationMember({ db, organizationId: orgId, userId });
      await db
        .update(sessionTable)
        .set({ activeOrganizationId: orgId })
        .where(eq(sessionTable.id, session.id));
      boundInstallation = Math.floor(Math.random() * 1_000_000_000);
      otherInstallation = boundInstallation + 1;
      vi.mocked(getOctokitForUser).mockResolvedValue(
        makeScopedOctokit({
          [boundInstallation]: [
            makeRepo({
              id: 1,
              fullName: "acme/api",
              push: true,
              pushedAt: "2026-01-01T00:00:00Z",
            }),
          ],
          [otherInstallation]: [
            makeRepo({
              id: 2,
              fullName: "customer-org/app",
              push: true,
              pushedAt: "2026-02-01T00:00:00Z",
            }),
          ],
        }) as any,
      );
    });

    it("lists only repos of installations bound to the active org", async () => {
      await bindGithubInstallationToOrg({
        db,
        installationId: boundInstallation,
        organizationId: orgId,
      });
      const otherOrg = await createOrganization({
        db,
        name: "Customer",
        slug: `customer-${nanoid(8).toLowerCase()}`,
      });
      await bindGithubInstallationToOrg({
        db,
        installationId: otherInstallation,
        organizationId: otherOrg.id,
      });

      const result = unwrapResult(await getUserRepos());

      expect(result.scope).toBe("organization");
      expect(result.repos.map((r) => r.full_name)).toEqual(["acme/api"]);
    });

    it("lists every repo, marked unassigned, when the org has nothing bound", async () => {
      const result = unwrapResult(await getUserRepos());

      expect(result.scope).toBe("unassigned");
      expect(result.repos.map((r) => r.full_name)).toEqual([
        "customer-org/app",
        "acme/api",
      ]);
    });

    it("lists nothing when the org's bound installations are not the user's", async () => {
      await bindGithubInstallationToOrg({
        db,
        installationId: `${boundInstallation}0`,
        organizationId: orgId,
      });

      const result = unwrapResult(await getUserRepos());

      expect(result.scope).toBe("organization");
      expect(result.repos).toEqual([]);
    });
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
    // No active org: no scoping at all.
    expect(result.scope).toBeUndefined();
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
