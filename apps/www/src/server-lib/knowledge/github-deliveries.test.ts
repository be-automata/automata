import { describe, expect, it, vi } from "vitest";

import {
  GithubDeliveriesError,
  listRepoWebhookDeliveries,
  type GithubDeliveriesDeps,
} from "./github-deliveries";

function item(guid: string, repositoryId: number | null) {
  return {
    guid,
    event: "push",
    action: null,
    status_code: 200,
    delivered_at: "2026-10-01T00:00:00Z",
    redelivery: false,
    repository_id: repositoryId,
  };
}

function deps(
  pages: ReturnType<typeof item>[][],
  repositoryId = 7,
): GithubDeliveriesDeps & { getDeliveriesPage: ReturnType<typeof vi.fn> } {
  let i = 0;
  return {
    getRepositoryId: vi.fn().mockResolvedValue(repositoryId),
    getDeliveriesPage: vi.fn(async () => {
      const items = pages[i] ?? [];
      i++;
      return { items, nextCursor: i < pages.length ? `c${i}` : null };
    }),
  };
}

describe("listRepoWebhookDeliveries", () => {
  it("keeps only the repo's deliveries and only the six metadata fields", async () => {
    const d = deps([[item("a", 7), item("b", 8), item("c", null)]]);
    const out = await listRepoWebhookDeliveries({ repoFullName: "o/r" }, d);
    expect(out).toEqual([
      {
        guid: "a",
        event: "push",
        action: null,
        statusCode: 200,
        deliveredAt: "2026-10-01T00:00:00Z",
        redelivery: false,
      },
    ]);
  });

  it("follows the cursor across pages and stops at the page cap", async () => {
    const pages = Array.from({ length: 9 }, (_, n) => [item(`g${n}`, 7)]);
    const d = deps(pages);
    const out = await listRepoWebhookDeliveries({ repoFullName: "o/r" }, d);
    expect(out).toHaveLength(5);
    expect(d.getDeliveriesPage).toHaveBeenCalledTimes(5);
    expect(d.getDeliveriesPage).toHaveBeenNthCalledWith(2, "c1");
  });

  it("reduces any App failure to GithubDeliveriesError with no cause text", async () => {
    const d = deps([]);
    d.getDeliveriesPage.mockRejectedValue(new Error("Bearer secret-jwt"));
    const err = await listRepoWebhookDeliveries(
      { repoFullName: "o/r" },
      d,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubDeliveriesError);
    expect((err as Error).message).toBe("github_unavailable");
  });
});
