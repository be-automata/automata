import { describe, it, vi, beforeEach, afterEach, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import * as schema from "@terragon/shared/db/schema";
import { getInstallationToken } from "@terragon/shared/github-app";
import { encryptToken } from "@terragon/utils/encryption";
import { env } from "@terragon/env/apps-www";

// Use the REAL helpers (bypassing the test-setup @/lib/github mock).
const { refreshGitHubUserTokenViaOAuth, getGitHubTokenForBackground } =
  (await vi.importActual("@/lib/github")) as typeof import("@/lib/github");

function mockGitHubTokenResponse(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("refreshGitHubUserTokenViaOAuth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges the refresh token and converts expires_in to absolute dates", async () => {
    const fetchMock = mockGitHubTokenResponse({
      access_token: "ghu_fresh",
      expires_in: 28800,
      refresh_token: "ghr_new",
      refresh_token_expires_in: 15811200,
    });
    const before = Date.now();
    const result = await refreshGitHubUserTokenViaOAuth("ghr_old");

    expect(result.accessToken).toBe("ghu_fresh");
    expect(result.refreshToken).toBe("ghr_new");
    expect(result.accessTokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      before + 28800 * 1000,
    );
    expect(result.refreshTokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      before + 15811200 * 1000,
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://github.com/login/oauth/access_token");
    const body = new URLSearchParams(init.body as URLSearchParams);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("ghr_old");
  });

  // GitHub reports a dead refresh token as HTTP 200 + { error }.
  it("throws on a 200 response that carries an error instead of a token", async () => {
    mockGitHubTokenResponse({
      error: "bad_refresh_token",
      error_description: "The refresh token passed is incorrect or expired.",
    });
    await expect(refreshGitHubUserTokenViaOAuth("ghr_dead")).rejects.toThrow(
      /bad_refresh_token/,
    );
  });

  it("throws on a non-2xx response", async () => {
    mockGitHubTokenResponse({}, 502);
    await expect(refreshGitHubUserTokenViaOAuth("ghr_old")).rejects.toThrow(
      /HTTP 502/,
    );
  });
});

describe("expired GitHub user token in the token helpers", () => {
  let userId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getInstallationToken).mockResolvedValue("mock-install-token");
    userId = (await createTestUser({ db })).user.id;
    await db
      .update(schema.account)
      .set({
        accessToken: encryptToken("ghu_dead", env.ENCRYPTION_MASTER_KEY),
        accessTokenExpiresAt: new Date(Date.now() - 1000),
        refreshToken: encryptToken("ghr_old", env.ENCRYPTION_MASTER_KEY),
        refreshTokenExpiresAt: null,
      })
      .where(
        and(
          eq(schema.account.userId, userId),
          eq(schema.account.providerId, "github"),
        ),
      );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes and uses the user token instead of falling back to the App", async () => {
    mockGitHubTokenResponse({
      access_token: "ghu_fresh",
      expires_in: 28800,
      refresh_token: "ghr_new",
      refresh_token_expires_in: 15811200,
    });
    await expect(
      getGitHubTokenForBackground({
        userId,
        repoFullName: "be-automata/automata",
      }),
    ).resolves.toBe("ghu_fresh");
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it("still falls back to the App installation token when the refresh fails, and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGitHubTokenResponse({ error: "bad_refresh_token" });
    await expect(
      getGitHubTokenForBackground({
        userId,
        repoFullName: "be-automata/automata",
      }),
    ).resolves.toBe("mock-install-token");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("GitHub token refresh failed"),
      expect.stringContaining("bad_refresh_token"),
    );
    warn.mockRestore();
  });

  // Review finding: email/password users have no GitHub account, and every repo
  // lookup for them used to log a warning, burying real refresh failures.
  it("does not log for a user with no GitHub account", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await db.delete(schema.account).where(eq(schema.account.userId, userId));
    await expect(
      getGitHubTokenForBackground({
        userId,
        repoFullName: "be-automata/automata",
      }),
    ).resolves.toBe("mock-install-token");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
