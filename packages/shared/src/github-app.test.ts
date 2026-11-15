import { generateKeyPairSync } from "node:crypto";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CELL_READ_OPTIONAL_PERMISSIONS,
  CELL_READ_REQUIRED_PERMISSIONS,
  MissingInstallationPermissionError,
  READ_ONLY_TOKEN_PERMISSIONS,
  WRITE_OPTIONAL_PERMISSIONS,
  WRITE_TOKEN_PERMISSIONS,
  clearInstallationTokenCacheForTests,
  getCellReadInstallationToken,
  getWriteInstallationToken,
  getGitHubApp,
  getInstallationToken,
  getRepoInstallationPermissions,
  getReadOnlyInstallationToken,
  isAppInstalledOnRepo,
  lookupInstallationId,
  resetAppInstance,
} from "./github-app.js";

// A real key: @octokit/auth-app signs a JWT before every token request.
const TEST_PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

type GitHubCall = { route: string; params: Record<string, unknown> };

/**
 * Stub GitHub at the HTTP layer (global fetch). The installation token comes
 * from @octokit/auth-app, which holds its own reference to the Octokit
 * `request`, so spying on `octokit.request` cannot see it; a stubbed fetch
 * sees every call, and auth-app's cache runs for real.
 */
function mockGitHub(
  installation: Record<string, unknown>,
  tokenResponse: Record<string, unknown> | (() => Record<string, unknown>),
  failInstallationReads = 0,
  installationStatus = 200,
): GitHubCall[] {
  process.env.GITHUB_APP_ID = "123456";
  process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
  const calls: GitHubCall[] = [];
  let installationReads = 0;
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const read = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(
        url.pathname,
      );
      if (method === "GET" && read) {
        calls.push({
          route: "GET /repos/{owner}/{repo}/installation",
          params: { owner: read[1], repo: read[2] },
        });
        if (installationStatus !== 200) {
          return json({ message: "Not Found" }, installationStatus);
        }
        if (installationReads++ < failInstallationReads) {
          return json({ message: "permissions read failed" }, 500);
        }
        return json(installation);
      }
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(
        url.pathname,
      );
      if (method === "POST" && mint) {
        calls.push({
          route: "POST /app/installations/{installation_id}/access_tokens",
          params: {
            installation_id: Number(mint[1]),
            ...JSON.parse(String(init?.body ?? "{}")),
          },
        });
        return json(
          typeof tokenResponse === "function" ? tokenResponse() : tokenResponse,
          201,
        );
      }
      return json({ message: `unexpected ${method} ${url.pathname}` }, 500);
    }),
  );
  return calls;
}

describe("GitHub App", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetAppInstance();
    clearInstallationTokenCacheForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetAppInstance();
    clearInstallationTokenCacheForTests();
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

  describe("installation tokens (#606: one mint, with presets)", () => {
    type Call = GitHubCall;
    type Installation = Record<string, unknown>;

    const PUSH_GRANTED = { contents: "write", metadata: "read" };
    const MINTED = { token: "ghs_x", expires_at: "2099-01-01T00:00:00Z" };

    const mockRequests = (
      installation: Installation = { id: 42, permissions: PUSH_GRANTED },
      tokenResponse:
        | Record<string, unknown>
        | (() => Record<string, unknown>) = MINTED,
      failInstallationReads = 0,
    ): Call[] => mockGitHub(installation, tokenResponse, failInstallationReads);

    const posts = (calls: Call[]) =>
      calls.filter((c) => c.route.startsWith("POST"));
    const gets = (calls: Call[]) =>
      calls.filter((c) => c.route.startsWith("GET"));

    it("pins the required and optional permission sets", () => {
      expect(WRITE_TOKEN_PERMISSIONS).toEqual({
        contents: "write",
        metadata: "read",
      });
      expect(WRITE_OPTIONAL_PERMISSIONS).toEqual({ workflows: "write" });
      expect(CELL_READ_REQUIRED_PERMISSIONS).toEqual({
        contents: "read",
        metadata: "read",
      });
      expect(CELL_READ_OPTIONAL_PERMISSIONS).toEqual({
        pull_requests: "read",
        issues: "read",
      });
    });

    it("write: requests a single-repo token with exactly the required permissions and returns token + expiresAt", async () => {
      const calls = mockRequests();
      await expect(getWriteInstallationToken("o", "r")).resolves.toEqual({
        token: "ghs_x",
        expiresAt: "2099-01-01T00:00:00Z",
      });
      expect(calls.map((c) => c.route)).toEqual([
        "GET /repos/{owner}/{repo}/installation",
        "POST /app/installations/{installation_id}/access_tokens",
      ]);
      const body = calls[1]!.params;
      expect(body).toEqual({
        installation_id: 42,
        repositories: ["r"],
        permissions: { contents: "write", metadata: "read" },
      });
      expect("expires_at" in body).toBe(false);
    });

    it("write: by default never requests workflows, even when the installation grants it", async () => {
      for (const opts of [undefined, { allowWorkflows: false }]) {
        vi.restoreAllMocks();
        resetAppInstance();
        clearInstallationTokenCacheForTests();
        const calls = mockRequests({
          id: 42,
          permissions: { ...PUSH_GRANTED, workflows: "write" },
        });
        await getWriteInstallationToken("o", "r", opts);
        expect(posts(calls)[0]!.params.permissions).toEqual({
          contents: "write",
          metadata: "read",
        });
      }
    });

    it("write: allowWorkflows adds workflows:write only when the installation grants it", async () => {
      const granted = mockRequests({
        id: 42,
        permissions: { ...PUSH_GRANTED, workflows: "write" },
      });
      await getWriteInstallationToken("o", "r", { allowWorkflows: true });
      expect(posts(granted)[0]!.params.permissions).toEqual({
        contents: "write",
        metadata: "read",
        workflows: "write",
      });

      for (const extra of [{ workflows: "read" }, {}]) {
        vi.restoreAllMocks();
        resetAppInstance();
        clearInstallationTokenCacheForTests();
        const calls = mockRequests({
          id: 42,
          permissions: { ...PUSH_GRANTED, ...extra },
        });
        await getWriteInstallationToken("o", "r", { allowWorkflows: true });
        expect(posts(calls)[0]!.params.permissions).toEqual({
          contents: "write",
          metadata: "read",
        });
      }
    });

    it("write: a token minted with allowWorkflows is not reused for the same repo without it", async () => {
      let n = 0;
      const calls = mockRequests(
        { id: 42, permissions: { ...PUSH_GRANTED, workflows: "write" } },
        () => ({ token: `ghs_${++n}`, expires_at: "2099-01-01T00:00:00Z" }),
      );
      const withWf = await getWriteInstallationToken("o", "r", {
        allowWorkflows: true,
      });
      const without = await getWriteInstallationToken("o", "r");
      expect(withWf.token).not.toBe(without.token);
      expect(posts(calls)).toHaveLength(2);
      expect(posts(calls)[0]!.params.permissions).toMatchObject({
        workflows: "write",
      });
      expect(posts(calls)[1]!.params.permissions).toEqual({
        contents: "write",
        metadata: "read",
      });
    });

    it("a missing required permission throws MissingInstallationPermissionError naming it, with no POST", async () => {
      const calls = mockRequests({
        id: 42,
        permissions: { metadata: "read" },
      });
      const error = await getWriteInstallationToken("o", "r").catch((e) => e);
      expect(error).toBeInstanceOf(MissingInstallationPermissionError);
      expect(error).toMatchObject({
        permission: "contents",
        needed: "write",
        granted: undefined,
      });
      expect(error.message).toContain("contents");
      expect(posts(calls)).toHaveLength(0);
    });

    it("a permission granted below the requested level counts as missing (contents:read for a push)", async () => {
      const calls = mockRequests({
        id: 42,
        permissions: { contents: "read", metadata: "read" },
      });
      await expect(getWriteInstallationToken("o", "r")).rejects.toMatchObject({
        name: "MissingInstallationPermissionError",
        permission: "contents",
        needed: "write",
        granted: "read",
      });
      expect(posts(calls)).toHaveLength(0);
    });

    it("write covers read: contents:write satisfies a read requirement", async () => {
      const calls = mockRequests({
        id: 42,
        permissions: { contents: "write", metadata: "read" },
      });
      await getCellReadInstallationToken("o", "r");
      expect(posts(calls)[0]!.params.permissions).toEqual({
        contents: "read",
        metadata: "read",
      });
    });

    it("cell read: includes pull_requests and issues when granted, omits them when not", async () => {
      const full = mockRequests({
        id: 42,
        permissions: {
          contents: "read",
          metadata: "read",
          pull_requests: "read",
          issues: "write",
        },
      });
      await getCellReadInstallationToken("o", "r");
      expect(posts(full)[0]!.params.permissions).toEqual({
        contents: "read",
        metadata: "read",
        pull_requests: "read",
        issues: "read",
      });

      vi.restoreAllMocks();
      resetAppInstance();
      clearInstallationTokenCacheForTests();
      const narrow = mockRequests({
        id: 42,
        permissions: { contents: "read", metadata: "read" },
      });
      await getCellReadInstallationToken("o", "r");
      expect(posts(narrow)[0]!.params.permissions).toEqual({
        contents: "read",
        metadata: "read",
      });
    });

    it("read-only preset: all four are required, a missing one throws naming it and nothing optional is added", async () => {
      const calls = mockRequests({
        id: 42,
        permissions: {
          contents: "read",
          metadata: "read",
          pull_requests: "read",
        },
      });
      await expect(
        getReadOnlyInstallationToken("o", "r"),
      ).rejects.toMatchObject({
        name: "MissingInstallationPermissionError",
        permission: "issues",
      });
      expect(posts(calls)).toHaveLength(0);

      vi.restoreAllMocks();
      resetAppInstance();
      clearInstallationTokenCacheForTests();
      const ok = mockRequests({
        id: 42,
        permissions: {
          contents: "read",
          metadata: "read",
          pull_requests: "read",
          issues: "read",
          workflows: "write",
        },
      });
      await getReadOnlyInstallationToken("o", "r");
      expect(posts(ok)[0]!.params.permissions).toEqual(
        READ_ONLY_TOKEN_PERMISSIONS,
      );
    });

    it("a failed permissions read fails a push closed, with no token request", async () => {
      const calls = mockRequests(
        { id: 42, permissions: { ...PUSH_GRANTED, workflows: "write" } },
        MINTED,
        1,
      );
      const error = await getWriteInstallationToken("o", "r").catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(MissingInstallationPermissionError);
      expect(error.message).toContain("permissions read failed");
      expect(posts(calls)).toHaveLength(0);
    });

    it("a failed permissions read falls back to exactly the required permissions for the read presets", async () => {
      const read = mockRequests(
        { id: 42, permissions: { ...READ_ONLY_TOKEN_PERMISSIONS } },
        MINTED,
        1,
      );
      await getReadOnlyInstallationToken("o", "r");
      expect(posts(read)[0]!.params.permissions).toEqual(
        READ_ONLY_TOKEN_PERMISSIONS,
      );

      vi.restoreAllMocks();
      resetAppInstance();
      clearInstallationTokenCacheForTests();
      const cell = mockRequests(
        {
          id: 42,
          permissions: {
            contents: "read",
            metadata: "read",
            pull_requests: "read",
            issues: "read",
          },
        },
        MINTED,
        1,
      );
      await getCellReadInstallationToken("o", "r");
      expect(posts(cell)[0]!.params.permissions).toEqual({
        contents: "read",
        metadata: "read",
      });
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
      mockRequests(undefined, { token: "ghs_x" });
      await expect(getWriteInstallationToken("o", "r")).rejects.toThrow(
        /token response/,
      );
      clearInstallationTokenCacheForTests();
      mockRequests(undefined, { expires_at: "2099-01-01T00:00:00Z" });
      await expect(getWriteInstallationToken("o", "r")).rejects.toThrow(
        /token response/,
      );
    });

    it("a known installation id is the one minted for", async () => {
      const calls = mockRequests();
      await getWriteInstallationToken("o", "r", {
        knownInstallationId: 7,
      });
      expect(calls.map((c) => c.route)).toEqual([
        "GET /repos/{owner}/{repo}/installation",
        "POST /app/installations/{installation_id}/access_tokens",
      ]);
      expect(calls[1]!.params).toMatchObject({ installation_id: 7 });
    });

    describe("caching", () => {
      it("a second call within the TTL makes no new request", async () => {
        const calls = mockRequests();
        const first = await getWriteInstallationToken("o", "r");
        const second = await getWriteInstallationToken("o", "r");
        expect(second).toEqual(first);
        expect(calls).toHaveLength(2);
      });

      it("the read-only preset never reuses a token: two calls are two POSTs with fresh tokens", async () => {
        let n = 0;
        const calls = mockRequests(
          {
            id: 42,
            permissions: { ...READ_ONLY_TOKEN_PERMISSIONS },
          },
          () => ({ token: `ghs_${++n}`, expires_at: "2099-01-01T00:00:00Z" }),
        );
        const first = await getReadOnlyInstallationToken("o", "r");
        const second = await getReadOnlyInstallationToken("o", "r");
        expect([first.token, second.token]).toEqual(["ghs_1", "ghs_2"]);
        expect(posts(calls)).toHaveLength(2);
        // The granted-permissions read is still shared.
        expect(gets(calls)).toHaveLength(1);
      });

      it("the broker presets reuse a token within the TTL: two calls are one POST", async () => {
        const calls = mockRequests();
        await getCellReadInstallationToken("o", "r");
        await getCellReadInstallationToken("o", "r");
        expect(posts(calls)).toHaveLength(1);
        await getWriteInstallationToken("o", "r");
        await getWriteInstallationToken("o", "r");
        expect(posts(calls)).toHaveLength(2);
      });

      it("a token within five minutes of expiry is minted again, and the granted permissions are reused until their TTL", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
        let n = 0;
        const calls = mockRequests(undefined, () => ({
          token: `ghs_${++n}`,
          expires_at: "2026-11-14T01:00:00Z",
        }));
        expect((await getWriteInstallationToken("o", "r")).token).toBe("ghs_1");
        // 3 minutes later: token fresh, permissions still cached.
        vi.setSystemTime(new Date("2026-11-14T00:03:00Z"));
        expect((await getWriteInstallationToken("o", "r")).token).toBe("ghs_1");
        expect(calls).toHaveLength(2);
        // 56 minutes in: under five minutes left, so a new token; the cached
        // permissions are older than their TTL, so they are read again.
        vi.setSystemTime(new Date("2026-11-14T00:56:00Z"));
        expect((await getWriteInstallationToken("o", "r")).token).toBe("ghs_2");
        expect(gets(calls)).toHaveLength(2);
        expect(posts(calls)).toHaveLength(2);
      });

      it("granted permissions are read again after five minutes while a fresh token is kept", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
        const calls = mockRequests(undefined, {
          token: "ghs_x",
          expires_at: "2026-11-14T01:00:00Z",
        });
        await getWriteInstallationToken("o", "r");
        vi.setSystemTime(new Date("2026-11-14T00:06:00Z"));
        await getWriteInstallationToken("o", "r");
        expect(gets(calls)).toHaveLength(2);
        expect(posts(calls)).toHaveLength(1);
      });

      it("different permission sets never share a token", async () => {
        let n = 0;
        const calls = mockRequests(
          {
            id: 42,
            permissions: { contents: "write", metadata: "read" },
          },
          () => ({ token: `ghs_${++n}`, expires_at: "2099-01-01T00:00:00Z" }),
        );
        const write = await getWriteInstallationToken("o", "r");
        const read = await getCellReadInstallationToken("o", "r");
        expect(write.token).not.toBe(read.token);
        expect(posts(calls)).toHaveLength(2);
        expect(gets(calls)).toHaveLength(1);
      });

      it("a fresh request that is handed an old token asks again", async () => {
        mockRequests({
          id: 42,
          permissions: { ...READ_ONLY_TOKEN_PERMISSIONS },
        });
        const auth = vi
          .spyOn(getGitHubApp().octokit, "auth")
          .mockImplementationOnce((async () => ({
            token: "ghs_old",
            expiresAt: "2099-01-01T00:00:00Z",
            createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
          })) as never)
          .mockImplementationOnce((async () => ({
            token: "ghs_new",
            expiresAt: "2099-01-01T00:00:00Z",
            createdAt: new Date().toISOString(),
          })) as never);
        await expect(
          getReadOnlyInstallationToken("o", "r"),
        ).resolves.toMatchObject({ token: "ghs_new" });
        expect(auth).toHaveBeenCalledTimes(2);
        expect(
          auth.mock.calls.map((c) => (c[0] as { refresh: boolean }).refresh),
        ).toEqual([true, true]);
      });

      it("a cached broker token with under five minutes left is refreshed once", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
        let n = 0;
        const calls = mockRequests(undefined, () => ({
          token: `ghs_${++n}`,
          expires_at: "2026-11-14T00:04:00Z",
        }));
        // Every token expires in four minutes: the first is already too old to
        // reuse, so each call mints, then refreshes exactly once.
        const token = await getWriteInstallationToken("o", "r");
        expect(token.token).toBe("ghs_2");
        expect(posts(calls)).toHaveLength(2);
      });

      it("a failed permissions read is not cached: the next call reads again", async () => {
        const calls = mockRequests(undefined, MINTED, 1);
        await expect(getWriteInstallationToken("o", "r")).rejects.toThrow();
        await expect(
          getWriteInstallationToken("o", "r"),
        ).resolves.toMatchObject({ token: "ghs_x" });
        expect(gets(calls)).toHaveLength(2);
      });
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
      // The installation grants the four read permissions (the preset requires them all).
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
          return {
            data: { id: 42, permissions: { ...READ_ONLY_TOKEN_PERMISSIONS } },
          };
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
      const calls = mockGitHub(
        { id: 42, permissions: { ...READ_ONLY_TOKEN_PERMISSIONS } },
        {
          token: "ghs_readonly_test_token",
          expires_at: "2026-10-04T03:00:00Z",
        },
      );
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
      mockGitHub(
        { id: 42, permissions: { ...READ_ONLY_TOKEN_PERMISSIONS } },
        { token: "ghs_x" },
      );
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

    it("a known installation id is the one minted for; both bodies keep their exact scope", async () => {
      const calls = mockGitHub(
        { id: 42, permissions: { ...READ_ONLY_TOKEN_PERMISSIONS } },
        { token: "ghs_x", expires_at: "2026-10-04T03:00:00Z" },
      );
      await expect(lookupInstallationId("o", "r")).resolves.toBe(42);
      await getInstallationToken("o", "r", 7);
      await getReadOnlyInstallationToken("o", "r", 7);
      // getInstallationToken(7) skips the lookup; the read-only mint reads the
      // granted permissions first (one GET), then mints for installation 7.
      expect(calls.map((c) => c.route)).toEqual([
        "GET /repos/{owner}/{repo}/installation",
        "POST /app/installations/{installation_id}/access_tokens",
        "GET /repos/{owner}/{repo}/installation",
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
      expect(calls[3]!.params).toEqual({
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
