import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  READ_ONLY_TOKEN_PERMISSIONS,
  getGitHubApp,
  getInstallationToken,
  getReadOnlyInstallationToken,
  isAppInstalledOnRepo,
  resetAppInstance,
} from "./github-app.js";

describe("GitHub App", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetAppInstance();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    resetAppInstance();
  });

  describe("getGitHubApp", () => {
    it("should throw error when GITHUB_APP_ID is missing", () => {
      delete process.env.GITHUB_APP_ID;
      process.env.GITHUB_APP_PRIVATE_KEY = "fake-key";

      expect(() => getGitHubApp()).toThrow("GitHub App configuration missing");
    });

    it("should throw error when GITHUB_APP_PRIVATE_KEY is missing", () => {
      process.env.GITHUB_APP_ID = "123456";
      delete process.env.GITHUB_APP_PRIVATE_KEY;

      expect(() => getGitHubApp()).toThrow("GitHub App configuration missing");
    });

    it("should create App instance when both env vars are present", () => {
      process.env.GITHUB_APP_ID = "123456";
      process.env.GITHUB_APP_PRIVATE_KEY = "fake-private-key";

      // The App constructor doesn't validate the private key format immediately
      // It only validates when trying to use it for signing JWTs
      // So we should test that it creates an App instance successfully
      const app = getGitHubApp();
      expect(app).toBeDefined();
      expect(app).toHaveProperty("octokit");
    });
  });

  describe("isAppInstalledOnRepo", () => {
    it("should handle missing app configuration gracefully", async () => {
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;

      await expect(isAppInstalledOnRepo("owner", "repo")).rejects.toThrow(
        "GitHub App configuration missing",
      );
    });
  });

  describe("installation tokens (phase 7: read-only variant)", () => {
    type Call = { route: string; params: Record<string, unknown> };

    function mockRequests(
      tokenResponse: Record<string, unknown> = {
        token: "ghs_readonly_test_token",
        expires_at: "2026-10-04T03:00:00Z",
      },
    ): Call[] {
      process.env.GITHUB_APP_ID = "123456";
      process.env.GITHUB_APP_PRIVATE_KEY = "fake-private-key";
      const calls: Call[] = [];
      const app = getGitHubApp();
      vi.spyOn(app.octokit, "request").mockImplementation((async (
        route: string,
        params: Record<string, unknown>,
      ) => {
        calls.push({ route, params });
        if (route === "GET /repos/{owner}/{repo}/installation") {
          return { data: { id: 42 } };
        }
        return { data: tokenResponse };
      }) as never);
      return calls;
    }

    it("pins exactly four read permissions", () => {
      expect(READ_ONLY_TOKEN_PERMISSIONS).toEqual({
        contents: "read",
        metadata: "read",
        pull_requests: "read",
        issues: "read",
      });
    });

    it("requests a single-repo token with exactly the read permissions and returns token + expiresAt", async () => {
      const calls = mockRequests();
      await expect(getReadOnlyInstallationToken("o", "r")).resolves.toEqual({
        token: "ghs_readonly_test_token",
        expiresAt: "2026-10-04T03:00:00Z",
      });
      expect(calls.map((c) => c.route)).toEqual([
        "GET /repos/{owner}/{repo}/installation",
        "POST /app/installations/{installation_id}/access_tokens",
      ]);
      expect(calls[0]!.params).toEqual({ owner: "o", repo: "r" });
      const body = calls[1]!.params;
      expect(body).toEqual({
        installation_id: 42,
        repositories: ["r"],
        permissions: {
          contents: "read",
          metadata: "read",
          pull_requests: "read",
          issues: "read",
        },
      });
      // A write- or admin-scoped token can never be requested by this function.
      expect(JSON.stringify(body)).not.toMatch(/write|admin/);
      expect("expires_at" in body).toBe(false);
    });

    it("404 → the same 'not installed' error as getInstallationToken", async () => {
      process.env.GITHUB_APP_ID = "123456";
      process.env.GITHUB_APP_PRIVATE_KEY = "fake-private-key";
      vi.spyOn(getGitHubApp().octokit, "request").mockRejectedValue(
        Object.assign(new Error("Not Found"), { status: 404 }),
      );
      await expect(getReadOnlyInstallationToken("o", "r")).rejects.toThrow(
        "GitHub App is not installed on repository o/r",
      );
      await expect(getInstallationToken("o", "r")).rejects.toThrow(
        "GitHub App is not installed on repository o/r",
      );
    });

    it("rejects a response without a token or an expiry", async () => {
      mockRequests({ token: "ghs_x" });
      await expect(getReadOnlyInstallationToken("o", "r")).rejects.toThrow(
        /token response/,
      );
    });

    it("getInstallationToken's request is unchanged (repositories + expires_at, no permissions)", async () => {
      const calls = mockRequests({ token: "ghs_write_capable" });
      await expect(getInstallationToken("o", "r")).resolves.toBe(
        "ghs_write_capable",
      );
      const body = calls[1]!.params;
      expect(Object.keys(body).sort()).toEqual([
        "expires_at",
        "installation_id",
        "repositories",
      ]);
      expect(body.repositories).toEqual(["r"]);
    });
  });
});
