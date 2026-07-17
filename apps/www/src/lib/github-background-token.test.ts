import { describe, it, vi, beforeEach, expect } from "vitest";
import { Octokit } from "octokit";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { account as accountTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { getInstallationToken } from "@terragon/shared/github-app";

// Use the REAL getOctokitForBackground (bypassing the test-setup @/lib/github
// mock) so its user-token→App-installation-token fallback is exercised for real.
const { getOctokitForBackground } = (await vi.importActual(
  "@/lib/github",
)) as typeof import("@/lib/github");

describe("getOctokitForBackground — App installation token fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getInstallationToken).mockResolvedValue("mock-github-token");
  });

  it("owner WITH a GitHub token: returns an Octokit without minting an App token", async () => {
    // createTestUser stores a GitHub account access token.
    const { user } = await createTestUser({ db });
    const octokit = await getOctokitForBackground({
      userId: user.id,
      repoFullName: "be-automata/automata",
    });
    expect(octokit).toBeInstanceOf(Octokit);
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it("owner WITHOUT a GitHub identity (email/password founder): falls back to the App installation token", async () => {
    const { user } = await createTestUser({ db });
    // Simulate no GitHub identity: drop the account row (and its token).
    await db.delete(accountTable).where(eq(accountTable.userId, user.id));

    const octokit = await getOctokitForBackground({
      userId: user.id,
      repoFullName: "be-automata/automata",
    });

    // Fallback succeeded — an Octokit is returned (no "No github access token" throw)…
    expect(octokit).toBeInstanceOf(Octokit);
    // …minted via the App installation token for the repo's owner.
    expect(getInstallationToken).toHaveBeenCalledWith("be-automata", "automata");
  });
});
