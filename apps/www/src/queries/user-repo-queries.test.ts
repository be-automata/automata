import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { resolveSelectedRepo } from "@/lib/resolve-selected-repo";
import type { MyOrganizations } from "@/server-actions/organizations";
import type { UserReposResult } from "@/server-actions/user-repos";
import {
  MY_ORGANIZATIONS_QUERY_KEY,
  markActiveOrganizationSwitched,
} from "./organization-queries";
import { userReposQueryKey, useUserReposQuery } from "./user-repo-queries";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server-actions/organizations", () => ({
  getMyOrganizations: vi.fn(),
  switchActiveOrganization: vi.fn(),
}));
vi.mock("@/server-actions/user-repos", () => ({
  getUserRepoBranches: vi.fn(),
}));

const ORG_A = "org_a";
const ORG_B = "org_b";

function orgs(activeOrganizationId: string | null): MyOrganizations {
  return {
    organizations: [ORG_A, ORG_B].map((id) => ({
      id,
      name: id,
      slug: id,
      logo: null,
      isPersonal: false,
    })),
    activeOrganizationId,
  };
}

function repos(...fullNames: string[]): UserReposResult {
  return {
    repos: fullNames.map(
      (full_name) =>
        ({ full_name, default_branch: "main" }) as UserReposResult["repos"][0],
    ),
    scope: "organization",
  };
}

/** Render the hook once (no effects, so nothing is fetched) and resolve. */
function renderDashboardRepo(client: QueryClient, storedRepo: string) {
  let snapshot:
    | (ReturnType<typeof resolveSelectedRepo> & { isLoading: boolean })
    | undefined;
  function Harness() {
    const { data, isLoading } = useUserReposQuery();
    snapshot = {
      ...resolveSelectedRepo({
        selectedRepoFullName: storedRepo,
        selectedBranch: "main",
        repos: data?.repos,
        isLoading,
      }),
      isLoading,
    };
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(Harness)),
  );
  if (!snapshot) throw new Error("harness did not render");
  return snapshot;
}

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

describe("userReposQueryKey", () => {
  it("includes the organization", () => {
    expect(userReposQueryKey(ORG_A)).toEqual(["user-repos", ORG_A]);
    expect(userReposQueryKey(null)).toEqual(["user-repos", null]);
  });
});

describe("useUserReposQuery across an org switch", () => {
  it("holds the stored repo for org B while only org A's list is cached", () => {
    const client = newClient();
    client.setQueryData(MY_ORGANIZATIONS_QUERY_KEY, orgs(ORG_A));
    client.setQueryData(userReposQueryKey(ORG_A), repos("a/web"));

    expect(renderDashboardRepo(client, "a/web")).toMatchObject({
      repoFullName: "a/web",
      pending: false,
    });

    markActiveOrganizationSwitched(client, ORG_B);

    // Org A's list is still cached, but it is not org B's: no repo, pending.
    expect(renderDashboardRepo(client, "a/web")).toMatchObject({
      repoFullName: null,
      pending: true,
      isLoading: true,
    });

    client.setQueryData(userReposQueryKey(ORG_B), repos("b/api"));
    expect(renderDashboardRepo(client, "a/web")).toMatchObject({
      repoFullName: "b/api",
      pending: false,
    });
  });

  it("shows org A's cached list at once when switching back", () => {
    const client = newClient();
    client.setQueryData(MY_ORGANIZATIONS_QUERY_KEY, orgs(ORG_B));
    client.setQueryData(userReposQueryKey(ORG_A), repos("a/web"));

    markActiveOrganizationSwitched(client, ORG_A);

    expect(renderDashboardRepo(client, "a/web")).toMatchObject({
      repoFullName: "a/web",
      pending: false,
    });
  });

  it("is pending while the active org is not known yet", () => {
    const client = newClient();
    client.setQueryData(userReposQueryKey(null), repos("x/y"));
    expect(renderDashboardRepo(client, "a/web")).toMatchObject({
      repoFullName: null,
      pending: true,
    });
  });

  it("keeps the stored repo when the list failed to load", async () => {
    // An observer that already saw the failure (no retry on this render).
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, retryOnMount: false, staleTime: Infinity },
      },
    });
    client.setQueryData(MY_ORGANIZATIONS_QUERY_KEY, orgs(ORG_A));
    await client
      .fetchQuery({
        queryKey: userReposQueryKey(ORG_A),
        queryFn: async () => {
          throw new Error("502");
        },
      })
      .catch(() => undefined);
    expect(renderDashboardRepo(client, "a/web")).toMatchObject({
      repoFullName: "a/web",
      pending: false,
      isLoading: false,
    });
  });
});
