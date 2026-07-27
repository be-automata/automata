import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";

// getOctokitForUser is globally mocked in test-setup.ts; exercise the real module.
vi.unmock("@/lib/github");
const { getOctokitForUser } = await import("@/lib/github");

describe("getOctokitForUser token freshness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Regression: GitHub App user tokens expire (8h). Before the refresh-first
  // change, an expired stored token was handed to Octokit verbatim — every call
  // failed with "Bad credentials", and getOctokitForBackground preferred it over
  // the App installation fallback, breaking PR automations. Now the token is
  // refreshed through better-auth first, and an unusable identity yields null so
  // background callers fall back to the installation token.
  it("still yields a client for a user whose stored token is usable", async () => {
    const { user } = await createTestUser({ db });
    // createTestUser writes a github account row with a stored token and no
    // refresh grant: better-auth refresh fails, so the stored-column fallback
    // must still produce a client (no regression for non-expiring setups).
    expect(await getOctokitForUser({ userId: user.id })).not.toBeNull();
  });

  it("returns null for a user with no github account at all", async () => {
    expect(await getOctokitForUser({ userId: "nonexistent-user" })).toBeNull();
  });
});
