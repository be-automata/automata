import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { insertAgentProviderCredentials } from "@terragon/shared/model/agent-provider-credentials";
import {
  createTestOrg,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import {
  claudeOauthAccessTokenFromContents,
  getClaudeOauthAccessToken,
} from "./claudeCredentials";
describe("claudeOauthAccessTokenFromContents", () => {
  it("returns a non-empty OAuth token and nothing else", () => {
    const oauth = (accessToken: unknown) =>
      JSON.stringify({ claudeAiOauth: { accessToken } });
    expect(claudeOauthAccessTokenFromContents(oauth("tok"))).toBe("tok");
    expect(claudeOauthAccessTokenFromContents(oauth(""))).toBeNull();
    expect(claudeOauthAccessTokenFromContents(oauth(7))).toBeNull();
    expect(
      claudeOauthAccessTokenFromContents(
        JSON.stringify({ anthropicApiKey: "k" }),
      ),
    ).toBeNull();
    expect(claudeOauthAccessTokenFromContents("{not json")).toBeNull();
    expect(claudeOauthAccessTokenFromContents("null")).toBeNull();
  });
});

describe("getClaudeOauthAccessToken (real database)", () => {
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    orgId = await createTestOrg({ db });
  });

  const insert = (
    credentialData: Parameters<
      typeof insertAgentProviderCredentials
    >[0]["credentialData"],
  ) =>
    insertAgentProviderCredentials({
      db,
      userId,
      organizationId: orgId,
      credentialData,
      encryptionKey: env.ENCRYPTION_MASTER_KEY,
    });

  it("returns the token of a setup-token credential, fenced to the org", async () => {
    await insert({
      agent: "claudeCode",
      type: "setup-token",
      accessToken: "sk-ant-oat01-test",
      isActive: true,
      expiresAt: null,
      lastRefreshedAt: null,
      metadata: { type: "claude", isSubscription: true },
    });
    expect(
      await getClaudeOauthAccessToken({ userId, organizationId: orgId }),
    ).toBe("sk-ant-oat01-test");
    // Another org of the same user has none.
    expect(
      await getClaudeOauthAccessToken({
        userId,
        organizationId: await createTestOrg({ db }),
      }),
    ).toBeNull();
  });

  it("is null for an API key", async () => {
    await insert({
      agent: "claudeCode",
      type: "api-key",
      apiKey: "sk-ant-api-test",
      isActive: true,
      expiresAt: null,
      lastRefreshedAt: null,
      metadata: { type: "claude", isSubscription: false },
    } as never);
    expect(
      await getClaudeOauthAccessToken({ userId, organizationId: orgId }),
    ).toBeNull();
  });

  it("is null with no credential (built-in credits)", async () => {
    expect(
      await getClaudeOauthAccessToken({ userId, organizationId: orgId }),
    ).toBeNull();
  });
});

describe("getClaudeOauthAccessToken (lookup failure)", () => {
  it("throws when the lookup reports an error, and never returns null for it", async () => {
    await expect(
      getClaudeOauthAccessToken({ userId: "u" }, async () => ({
        contents: null,
        error: "Failed to get Claude credentials",
        credentialId: null,
      })),
    ).rejects.toThrow("claude credential lookup failed");
  });

  it("is null for an API-key file, built-in credits and unparseable contents", async () => {
    const reading = (contents: string | null) => async () => ({
      contents,
      error: null,
      credentialId: contents === null ? null : "cred-1",
    });
    for (const contents of [
      JSON.stringify({ anthropicApiKey: "k" }),
      null,
      "{not json",
    ]) {
      expect(
        await getClaudeOauthAccessToken({ userId: "u" }, reading(contents)),
      ).toBeNull();
    }
    expect(
      await getClaudeOauthAccessToken(
        { userId: "u" },
        reading(JSON.stringify({ claudeAiOauth: { accessToken: "t" } })),
      ),
    ).toBe("t");
  });
});
