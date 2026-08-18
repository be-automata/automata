import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { User, Session } from "@terragon/shared";
import { agentProviderCredentials } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { mockLoggedInUser } from "@/test-helpers/mock-next";
import { saveClaudeSetupToken } from "./claude-setup-token";
import { saveAgentProviderApiKey } from "./credentials";
import { unwrapResult } from "@/lib/server-actions";

describe("saveClaudeSetupToken", () => {
  let user: User;
  let session: Session;

  beforeEach(async () => {
    vi.clearAllMocks();
    // The optional account probe hits api.anthropic.com; a setup token is
    // inference-scoped so it may legitimately be refused. Stub it to prove the
    // save does not depend on it either way.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    );
    const created = await createTestUser({ db });
    user = created.user;
    session = created.session;
    await mockLoggedInUser(session);
  });

  it("stores the token so the resolver emits an OAuth file, not an api-key", async () => {
    unwrapResult(await saveClaudeSetupToken({ token: "sk-ant-oat01-real" }));

    const rows = await db
      .select()
      .from(agentProviderCredentials)
      .where(eq(agentProviderCredentials.userId, user.id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.type).toBe("setup-token");
    // apiKeyEncrypted would make getClaudeCredentialsJSONOrNull emit
    // {anthropicApiKey}, which the CLI sends as x-api-key → guaranteed 401.
    expect(row.apiKeyEncrypted).toBeNull();
    expect(row.accessTokenEncrypted).not.toBeNull();
    // No refresh token and no expiry: getValidAccessTokenForCredential treats
    // that as "never refresh", which is correct — there is nothing to refresh.
    expect(row.refreshTokenEncrypted).toBeNull();
    expect(row.expiresAt).toBeNull();
  });

  it("saves even when the account probe is refused (setup tokens are inference-only)", async () => {
    // The probe 403s (mocked above). If the save were gated on it, every valid
    // setup token would be rejected.
    unwrapResult(await saveClaudeSetupToken({ token: "sk-ant-oat01-real" }));
    const rows = await db
      .select()
      .from(agentProviderCredentials)
      .where(eq(agentProviderCredentials.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it("names the mistake when an API key is pasted into the token field", async () => {
    const result = await saveClaudeSetupToken({ token: "sk-ant-api03-key" });
    expect(JSON.stringify(result)).toMatch(/Anthropic API key/);
    const rows = await db
      .select()
      .from(agentProviderCredentials)
      .where(eq(agentProviderCredentials.userId, user.id));
    expect(rows).toHaveLength(0);
  });

  it("rejects a value that is not a setup token at all", async () => {
    const result = await saveClaudeSetupToken({ token: "hunter2" });
    expect(JSON.stringify(result)).toMatch(/sk-ant-oat/);
  });

  it("names the mistake when a setup token is pasted into the API key field", async () => {
    // The inverse trap, and the one that is live today: `sk-ant-oat…` passes a
    // bare `sk-ant-` check, stores as an api-key, and fails at run time as an
    // opaque 401 far from the paste that caused it.
    const result = await saveAgentProviderApiKey({
      agent: "claudeCode",
      apiKey: "sk-ant-oat01-real",
    });
    expect(JSON.stringify(result)).toMatch(/setup-token/);
    const rows = await db
      .select()
      .from(agentProviderCredentials)
      .where(eq(agentProviderCredentials.userId, user.id));
    expect(rows).toHaveLength(0);
  });

  it("still accepts a real Anthropic API key in the API key field", async () => {
    unwrapResult(
      await saveAgentProviderApiKey({
        agent: "claudeCode",
        apiKey: "sk-ant-api03-real",
      }),
    );
    const rows = await db
      .select()
      .from(agentProviderCredentials)
      .where(eq(agentProviderCredentials.userId, user.id));
    expect(rows[0]!.type).toBe("api-key");
  });
});
