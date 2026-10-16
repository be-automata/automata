import { beforeEach, describe, expect, it, vi } from "vitest";

const reposGet = vi.fn();
vi.mock("@/lib/github", () => ({
  getOctokitForUser: vi.fn(async () => ({
    rest: { repos: { get: reposGet } },
  })),
  parseRepoFullName: (name: string) => name.split("/"),
}));

import { getOctokitForUser } from "@/lib/github";
import { createRepoAccessChecker, userHasRepoAccess } from "./repo-access";

describe("repo access", () => {
  beforeEach(() => {
    reposGet.mockReset();
    vi.mocked(getOctokitForUser).mockClear();
  });

  it("reads access from the repository permissions GitHub returns", async () => {
    reposGet.mockResolvedValueOnce({ data: { permissions: { pull: true } } });
    reposGet.mockResolvedValueOnce({ data: {} });
    const check = createRepoAccessChecker("u-read", { cache: false });
    expect(await check("acme/api")).toBe(true);
    expect(await check("acme/web")).toBe(false);
    // One GitHub client per checker, however many repos it checks.
    expect(getOctokitForUser).toHaveBeenCalledTimes(1);
  });

  it("treats a GitHub error as no access", async () => {
    reposGet.mockRejectedValueOnce(new Error("Not Found"));
    expect(
      await userHasRepoAccess({ userId: "u-404", repoFullName: "acme/gone" }),
    ).toBe(false);
  });

  it("caches answers only when asked, so opening a thread always re-checks", async () => {
    reposGet.mockResolvedValue({ data: { permissions: { pull: true } } });
    const listing = createRepoAccessChecker("u-cache", { cache: true });
    await listing("acme/api");
    await createRepoAccessChecker("u-cache", { cache: true })("acme/api");
    expect(reposGet).toHaveBeenCalledTimes(1);
    await userHasRepoAccess({ userId: "u-cache", repoFullName: "acme/api" });
    expect(reposGet).toHaveBeenCalledTimes(2);
  });

  it("caches a GitHub 404 but not a transient failure", async () => {
    const transient = Object.assign(new Error("rate limited"), { status: 429 });
    reposGet.mockRejectedValueOnce(transient);
    reposGet.mockResolvedValueOnce({ data: { permissions: { pull: true } } });
    const first = createRepoAccessChecker("u-blip", { cache: true });
    expect(await first("acme/api")).toBe(false);
    // Not cached: the next poll asks GitHub again and sees the recovery.
    expect(
      await createRepoAccessChecker("u-blip", { cache: true })("acme/api"),
    ).toBe(true);

    const notFound = Object.assign(new Error("Not Found"), { status: 404 });
    reposGet.mockRejectedValueOnce(notFound);
    const checker = createRepoAccessChecker("u-404c", { cache: true });
    expect(await checker("acme/gone")).toBe(false);
    expect(
      await createRepoAccessChecker("u-404c", { cache: true })("acme/gone"),
    ).toBe(false);
    expect(reposGet).toHaveBeenCalledTimes(3);
  });
});
