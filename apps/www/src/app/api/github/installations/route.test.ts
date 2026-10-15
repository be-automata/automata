import { beforeEach, describe, expect, it, vi } from "vitest";
import { nanoid } from "nanoid";

import { db } from "@/lib/db";
import { getOctokitForUser } from "@/lib/github";
import { mockLoggedInUser, mockLoggedOutUser } from "@/test-helpers/mock-next";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import {
  addOrganizationMember,
  createOrganization,
} from "@terragon/shared/model/organizations";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import type { GithubInstallationsResult } from "@/server-lib/github-installation-rows";
import { GET } from "./route";

function makeOctokit(installations: Array<{ id: number; login: string }>) {
  return {
    rest: {
      apps: { listInstallationsForAuthenticatedUser: vi.fn() },
    },
    paginate: vi.fn(async () =>
      installations.map(({ id, login }) => ({
        id,
        account: { login, type: "Organization" },
      })),
    ),
  };
}

function get(query = ""): Promise<Response> {
  return GET(new Request(`http://localhost/api/github/installations${query}`));
}

describe("GET /api/github/installations", () => {
  let userId: string;
  let installationId: number;
  let octokit: ReturnType<typeof makeOctokit>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const created = await createTestUser({ db });
    userId = created.user.id;
    installationId = Math.floor(Math.random() * 1_000_000_000);
    octokit = makeOctokit([{ id: installationId, login: "acme" }]);
    vi.mocked(getOctokitForUser).mockResolvedValue(octokit as never);
    await mockLoggedInUser(created.session);
  });

  it("returns 401 JSON when signed out", async () => {
    await mockLoggedOutUser();
    const res = await get();
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(getOctokitForUser).not.toHaveBeenCalled();
  });

  it("serves the GitHub listing from the cache but reads bindings fresh", async () => {
    const first = await get();
    expect(first.status).toBe(200);
    expect(first.headers.get("Server-Timing")).toContain("cache;desc=miss");
    const firstBody = (await first.json()) as GithubInstallationsResult;
    expect(firstBody.installations[0]?.binding).toEqual({ kind: "unbound" });

    const org = await createOrganization({
      db,
      name: "Acme",
      slug: `acme-${nanoid(8).toLowerCase()}`,
    });
    await addOrganizationMember({ db, organizationId: org.id, userId });
    await bindGithubInstallationToOrg({
      db,
      installationId,
      organizationId: org.id,
    });

    const second = await get();
    expect(second.headers.get("Server-Timing")).toBe(
      "github;dur=0, cache;desc=hit",
    );
    expect(octokit.paginate).toHaveBeenCalledTimes(1);
    const body = (await second.json()) as GithubInstallationsResult;
    expect(body.installations[0]?.binding).toEqual({
      kind: "organization",
      organization: { id: org.id, name: "Acme", logo: null },
    });
  });

  it("bypasses the cache with ?refresh=1", async () => {
    await get();
    const res = await get("?refresh=1");
    expect(res.headers.get("Server-Timing")).toContain("cache;desc=bypass");
    expect(octokit.paginate).toHaveBeenCalledTimes(2);
  });

  it("reports a GitHub failure as a 502", async () => {
    octokit.paginate.mockRejectedValue(new Error("502 Bad Gateway"));
    const res = await get();
    expect(res.status).toBe(502);
  });
});
