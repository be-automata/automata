import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  READ_ONLY_TOKEN_PERMISSIONS,
  WORKFLOWS_WRITE_PERMISSION,
  WRITE_TOKEN_PERMISSIONS,
  getWriteInstallationToken,
  getGitHubApp,
  getInstallationToken,
  getRepoInstallationPermissions,
  getReadOnlyInstallationToken,
  isAppInstalledOnRepo,
  lookupInstallationId,
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

  describe("installation tokens (#606: remote-cell write variant)", () => {
    type Call = { route: string; params: Record<string, unknown> };

    function mockRequests(
      tokenResponse: Record<string, unknown>,
      installation: Record<string, unknown> = { id: 42 },
      failFirstInstallationRead = false,
    ): Call[] {
      process.env.GITHUB_APP_ID = "123456";
      process.env.GITHUB_APP_PRIVATE_KEY = "fake-private-key";
      const calls: Call[] = [];
      let installationReads = 0;
      vi.spyOn(getGitHubApp().octokit, "request").mockImplementation((async (
        route: string,
        params: Record<string, unknown>,
      ) => {
        calls.push({ route, params });
        if (route === "GET /repos/{owner}/{repo}/installation") {
          if (failFirstInstallationRead && installationReads++ === 0) {
            throw new Error("permissions read failed");
          }
          return { data: installation };
        }
        return { data: tokenResponse };
      }) as never);
      return calls;
    }

    it("pins exactly contents:write and metadata:read as the base write permissions", () => {
      expect(WRITE_TOKEN_PERMISSIONS).toEqual({
        contents: "write",
        metadata: "read",
      });
      expect(WORKFLOWS_WRITE_PERMISSION).toEqual({ workflows: "write" });
    });

    it("requests a single-repo token with exactly the write permissions and returns token + expiresAt", async () => {
      const calls = mockRequests({
        token: "ghs_write_test_token",
        expires_at: "2026-10-04T03:00:00Z",
      });
      await expect(getWriteInstallationToken("o", "r")).resolves.toEqual({
        token: "ghs_write_test_token",
        expiresAt: "2026-10-04T03:00:00Z",
      });
      const body = calls[1]!.params;
      expect(body).toEqual({
        installation_id: 42,
        repositories: ["r"],
        permissions: { contents: "write", metadata: "read" },
      });
      expect("expires_at" in body).toBe(false);
    });

    const MINTED = { token: "ghs_x", expires_at: "2026-10-04T03:00:00Z" };

    it("adds workflows:write when the installation grants it", async () => {
      const calls = mockRequests(MINTED, {
        id: 42,
        permissions: { contents: "write", workflows: "write" },
      });
      await getWriteInstallationToken("o", "r");
      expect(calls[1]!.params.permissions).toEqual({
        contents: "write",
        metadata: "read",
        workflows: "write",
      });
    });

    it("stays at contents:write + metadata:read when workflows is read-only or not granted", async () => {
      for (const permissions of [{ workflows: "read" }, {}, undefined]) {
        vi.restoreAllMocks();
        resetAppInstance();
        const calls = mockRequests(MINTED, { id: 42, permissions });
        await getWriteInstallationToken("o", "r");
        expect(calls[1]!.params.permissions).toEqual({
          contents: "write",
          metadata: "read",
        });
      }
    });

    it("mints without workflows when reading the granted permissions fails", async () => {
      const calls = mockRequests(MINTED, { id: 42 }, true);
      await expect(getWriteInstallationToken("o", "r")).resolves.toEqual({
        token: "ghs_x",
        expiresAt: "2026-10-04T03:00:00Z",
      });
      const post = calls.find((c) => c.route.startsWith("POST"));
      expect(post!.params.permissions).toEqual({
        contents: "write",
        metadata: "read",
      });
    });

    it("a known installation id skips the lookup", async () => {
      const calls = mockRequests({
        token: "ghs_x",
        expires_at: "2026-10-04T03:00:00Z",
      });
      await getWriteInstallationToken("o", "r", 7);
      // One read of the granted permissions, then the mint for installation 7.
      expect(calls.map((c) => c.route)).toEqual([
        "GET /repos/{owner}/{repo}/installation",
        "POST /app/installations/{installation_id}/access_tokens",
      ]);
      expect(calls[1]!.params).toMatchObject({ installation_id: 7 });
    });

    it("404 -> the same 'not installed' error as the other token minters", async () => {
      process.env.GITHUB_APP_ID = "123456";
      process.env.GITHUB_APP_PRIVATE_KEY = "fake-private-key";
      vi.spyOn(getGitHubApp().octokit, "request").mockRejectedValue(
        Object.assign(new Error("Not Found"), { status: 404 }),
      );
      await expect(getWriteInstallationToken("o", "r")).rejects.toThrow(
        "GitHub App is not installed on repository o/r",
      );
    });

    it("rejects a response without a token or an expiry", async () => {
      mockRequests({ token: "ghs_x" });
      await expect(getWriteInstallationToken("o", "r")).rejects.toThrow(
        /token response/,
      );
      mockRequests({ expires_at: "2026-10-04T03:00:00Z" });
      await expect(getWriteInstallationToken("o", "r")).rejects.toThrow(
        /token response/,
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

    it("a known installation id skips the lookup; both bodies keep their exact scope", async () => {
      const calls = mockRequests();
      await expect(lookupInstallationId("o", "r")).resolves.toBe(42);
      await getInstallationToken("o", "r", 7);
      await getReadOnlyInstallationToken("o", "r", 7);
      expect(calls.map((c) => c.route)).toEqual([
        "GET /repos/{owner}/{repo}/installation",
        "POST /app/installations/{installation_id}/access_tokens",
        "POST /app/installations/{installation_id}/access_tokens",
      ]);
      expect(Object.keys(calls[1]!.params).sort()).toEqual([
        "expires_at",
        "installation_id",
        "repositories",
      ]);
      expect(calls[1]!.params).toMatchObject({
        installation_id: 7,
        repositories: ["r"],
      });
      expect(calls[2]!.params).toEqual({
        installation_id: 7,
        repositories: ["r"],
        permissions: READ_ONLY_TOKEN_PERMISSIONS,
      });
    });

    it("lookupInstallationId maps a 404 to the 'not installed' error", async () => {
      process.env.GITHUB_APP_ID = "123456";
      process.env.GITHUB_APP_PRIVATE_KEY = "fake-private-key";
      vi.spyOn(getGitHubApp().octokit, "request").mockRejectedValue(
        Object.assign(new Error("Not Found"), { status: 404 }),
      );
      await expect(lookupInstallationId("o", "r")).rejects.toThrow(
        "GitHub App is not installed on repository o/r",
      );
    });

    it("forwards a provided signal as request.signal on the lookup and the mint", async () => {
      const calls = mockRequests();
      const signal = new AbortController().signal;
      await getInstallationToken("o", "r", undefined, { signal });
      expect(calls[0]!.params).toEqual({
        owner: "o",
        repo: "r",
        request: { signal },
      });
      expect(calls[1]!.params.request).toEqual({ signal });
    });

    it("getRepoInstallationPermissions returns the id and granted permissions", async () => {
      process.env.GITHUB_APP_ID = "123456";
      process.env.GITHUB_APP_PRIVATE_KEY = "fake-private-key";
      const spy = vi
        .spyOn(getGitHubApp().octokit, "request")
        .mockResolvedValue({
          data: { id: 9, permissions: { issues: "write", contents: "read" } },
        } as never);
      const signal = new AbortController().signal;
      await expect(
        getRepoInstallationPermissions("o", "r", { signal }),
      ).resolves.toEqual({
        installationId: 9,
        permissions: { issues: "write", contents: "read" },
      });
      expect(spy.mock.calls[0]![1]).toMatchObject({ request: { signal } });
    });
  });
});
