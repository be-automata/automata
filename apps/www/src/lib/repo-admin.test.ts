import { describe, it, vi, beforeEach, expect } from "vitest";
import { checkRepoAdmin, clearRepoAdminCacheForTest } from "./repo-admin";
import { getOctokitForUser } from "@/lib/github";

vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOctokitForUser: vi.fn(),
}));

function octokit(adminOrError: boolean | Error) {
  return {
    rest: {
      repos: {
        get:
          adminOrError instanceof Error
            ? vi.fn().mockRejectedValue(adminOrError)
            : vi.fn().mockResolvedValue({
                data: { permissions: { admin: adminOrError } },
              }),
      },
    },
  } as never;
}

describe("checkRepoAdmin (#125 C6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRepoAdminCacheForTest();
  });

  it("admin / write map to admin / not-admin; the answer is cached 5 min per (user, repo)", async () => {
    vi.mocked(getOctokitForUser).mockResolvedValue(octokit(true));
    let t = 0;
    const now = () => t;
    expect(
      await checkRepoAdmin({ userId: "u1", repoFullName: "a/R", now }),
    ).toBe("admin");
    // Same user+repo (case-insensitive) within TTL: no second lookup.
    expect(
      await checkRepoAdmin({ userId: "u1", repoFullName: "a/r", now }),
    ).toBe("admin");
    expect(getOctokitForUser).toHaveBeenCalledTimes(1);
    // TTL expiry re-checks.
    t = 5 * 60 * 1000 + 1;
    vi.mocked(getOctokitForUser).mockResolvedValue(octokit(false));
    expect(
      await checkRepoAdmin({ userId: "u1", repoFullName: "a/r", now }),
    ).toBe("not-admin");
  });

  it("no GitHub identity or a thrown lookup → lookup-failed, and failures are never cached", async () => {
    vi.mocked(getOctokitForUser).mockResolvedValue(null);
    expect(await checkRepoAdmin({ userId: "u2", repoFullName: "a/r" })).toBe(
      "lookup-failed",
    );
    vi.mocked(getOctokitForUser).mockResolvedValue(octokit(new Error("boom")));
    expect(await checkRepoAdmin({ userId: "u2", repoFullName: "a/r" })).toBe(
      "lookup-failed",
    );
    vi.mocked(getOctokitForUser).mockResolvedValue(octokit(true));
    expect(await checkRepoAdmin({ userId: "u2", repoFullName: "a/r" })).toBe(
      "admin",
    );
  });
});
