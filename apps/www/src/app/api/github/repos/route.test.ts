import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db } from "@/lib/db";
import { getOctokitForUser } from "@/lib/github";
import { redis } from "@/lib/redis";
import { mockLoggedInUser, mockLoggedOutUser } from "@/test-helpers/mock-next";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import {
  addOrganizationMember,
  createOrganization,
} from "@terragon/shared/model/organizations";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { session as sessionTable } from "@terragon/shared/db/schema";
import type { Session } from "@terragon/shared";
import type { UserReposResult } from "@/server-lib/user-repos";
import { GET } from "./route";

function repo(id: number, fullName: string, pushedAt: string) {
  return {
    id,
    full_name: fullName,
    permissions: { push: true },
    pushed_at: pushedAt,
  };
}

/**
 * An octokit whose installations each list their own repos. `paginate` with
 * no installation_id is the installation listing itself.
 */
function makeOctokit(reposByInstallation: Record<number, unknown[]>) {
  return {
    rest: {
      apps: {
        listInstallationsForAuthenticatedUser: vi.fn(),
        listInstallationReposForAuthenticatedUser: vi.fn(),
      },
    },
    paginate: vi.fn(
      async (_fn: unknown, params: { installation_id?: number }) =>
        params.installation_id === undefined
          ? Object.keys(reposByInstallation).map((id) => ({ id: Number(id) }))
          : (reposByInstallation[params.installation_id] ?? []),
    ),
  };
}

function get(query = ""): Promise<Response> {
  return GET(new Request(`http://localhost/api/github/repos${query}`));
}

async function names(res: Response): Promise<string[]> {
  const body = (await res.json()) as UserReposResult;
  return body.repos.map((r) => r.full_name);
}

describe("GET /api/github/repos", () => {
  let session: Session;
  let userId: string;
  let orgId: string;
  let mine: number;
  let theirs: number;
  let octokit: ReturnType<typeof makeOctokit>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const created = await createTestUser({ db });
    session = created.session;
    userId = created.user.id;
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
    mine = Math.floor(Math.random() * 1_000_000_000);
    theirs = mine + 1;
    octokit = makeOctokit({
      [mine]: [repo(1, "acme/api", "2026-01-01T00:00:00Z")],
      [theirs]: [repo(2, "customer-org/app", "2026-02-01T00:00:00Z")],
    });
    vi.mocked(getOctokitForUser).mockResolvedValue(octokit as never);
    await mockLoggedInUser(session);
  });

  it("returns 401 JSON when signed out, without touching GitHub", async () => {
    await mockLoggedOutUser();
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getOctokitForUser).not.toHaveBeenCalled();
  });

  it("scopes the list to the active org's bound installations", async () => {
    await bindGithubInstallationToOrg({
      db,
      installationId: mine,
      organizationId: orgId,
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await names(res)).toEqual(["acme/api"]);
  });

  it("serves a repeat request from the cache, with no GitHub calls", async () => {
    const first = await get();
    expect(first.headers.get("Server-Timing")).toMatch(
      /^github;dur=\d+, cache;desc=miss$/,
    );
    const callsAfterFirst = octokit.paginate.mock.calls.length;
    expect(callsAfterFirst).toBe(3); // installations + 2 repo lists

    const second = await get();
    expect(second.headers.get("Server-Timing")).toBe(
      "github;dur=0, cache;desc=hit",
    );
    expect(await names(second)).toEqual(["customer-org/app", "acme/api"]);
    expect(octokit.paginate.mock.calls.length).toBe(callsAfterFirst);
  });

  it("applies the org scoping on every request, even on a cache hit", async () => {
    expect(await names(await get())).toEqual(["customer-org/app", "acme/api"]);
    await bindGithubInstallationToOrg({
      db,
      installationId: mine,
      organizationId: orgId,
    });
    const res = await get();
    expect(res.headers.get("Server-Timing")).toContain("cache;desc=hit");
    expect(await names(res)).toEqual(["acme/api"]);
  });

  it("never serves one user's cached listing to another user", async () => {
    await get();
    const other = await createTestUser({ db });
    const otherOctokit = makeOctokit({
      [mine + 2]: [repo(3, "other/repo", "2026-03-01T00:00:00Z")],
    });
    vi.mocked(getOctokitForUser).mockResolvedValue(otherOctokit as never);
    await mockLoggedInUser(other.session);
    const res = await get();
    expect(res.headers.get("Server-Timing")).toContain("cache;desc=miss");
    expect(await names(res)).toEqual(["other/repo"]);
  });

  it("bypasses the cache with ?refresh=1", async () => {
    await get();
    const callsAfterFirst = octokit.paginate.mock.calls.length;
    const res = await get("?refresh=1");
    expect(res.headers.get("Server-Timing")).toContain("cache;desc=bypass");
    expect(octokit.paginate.mock.calls.length).toBe(callsAfterFirst * 2);
  });

  it("falls through to GitHub when Redis fails", async () => {
    const getSpy = vi
      .spyOn(redis, "get")
      .mockRejectedValue(new Error("redis down"));
    const setSpy = vi
      .spyOn(redis, "set")
      .mockRejectedValue(new Error("redis down"));
    try {
      const res = await get();
      expect(res.status).toBe(200);
      expect(await names(res)).toEqual(["customer-org/app", "acme/api"]);
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
    }
  });

  it("reports a GitHub failure as a 502, not an empty list", async () => {
    octokit.paginate.mockRejectedValue(new Error("502 Bad Gateway"));
    const res = await get();
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/GitHub/);
  });

  it("reports a missing GitHub token as githubTokenMissing", async () => {
    vi.mocked(getOctokitForUser).mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repos: [], githubTokenMissing: true });
  });
});
