import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { User, Session } from "@terragon/shared";
import {
  createOrganization,
  addOrganizationMember,
} from "@terragon/shared/model/organizations";
import {
  session as sessionTable,
  agentProviderCredentials,
} from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { mockLoggedInUser } from "@/test-helpers/mock-next";
import { getUserCredentialsAction } from "./user-credentials";
import { getAgentProviderCredentialsAction } from "./credentials";
import { exchangeCode } from "./claude-oauth";
import { unwrapResult } from "@/lib/server-actions";

vi.mock("@/lib/claude-oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/claude-oauth")>();
  return {
    ...actual,
    exchangeAuthorizationCode: vi.fn(async () => ({
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "user:inference",
    })),
    createAnthropicAPIKey: vi.fn(async () => "sk-ant-test"),
  };
});

async function createOrg(userId: string) {
  const org = await createOrganization({
    db,
    name: "Org",
    slug: `org-${nanoid(8).toLowerCase()}`,
  });
  await addOrganizationMember({ db, organizationId: org.id, userId });
  return org.id;
}

describe("user-credentials server action — org fencing (WI-5)", () => {
  let user: User;
  let session: Session;
  let orgX: string;
  let orgY: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const created = await createTestUser({ db });
    user = created.user;
    session = created.session;
    orgX = await createOrg(user.id);
    orgY = await createOrg(user.id);
    // A Claude credential owned by the user, scoped to orgX only.
    await db.insert(agentProviderCredentials).values({
      userId: user.id,
      organizationId: orgX,
      agent: "claudeCode",
      type: "api-key",
      isActive: true,
      apiKeyEncrypted: "enc",
    });
  });

  it("reflects only the active org's credentials, honoring org-switch", async () => {
    await mockLoggedInUser(session);

    await db
      .update(sessionTable)
      .set({ activeOrganizationId: orgX })
      .where(eq(sessionTable.id, session.id));
    expect(unwrapResult(await getUserCredentialsAction()).hasClaude).toBe(true);

    await db
      .update(sessionTable)
      .set({ activeOrganizationId: orgY })
      .where(eq(sessionTable.id, session.id));
    expect(unwrapResult(await getUserCredentialsAction()).hasClaude).toBe(false);
  });

  it("stamps the active org on a Claude OAuth credential so the list shows it", async () => {
    await mockLoggedInUser(session);
    await db
      .update(sessionTable)
      .set({ activeOrganizationId: orgY })
      .where(eq(sessionTable.id, session.id));

    unwrapResult(
      await exchangeCode({
        code: "code",
        codeVerifier: "verifier",
        state: "state",
        // api-key avoids the Anthropic profile fetch in the subscription path.
        authType: "api-key",
      }),
    );

    const credentials = unwrapResult(await getAgentProviderCredentialsAction());
    expect(credentials.claudeCode?.length).toBe(1);
  });
});
