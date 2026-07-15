import { describe, it, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { User } from "@terragon/shared";
import {
  createOrganization,
  addOrganizationMember,
} from "@terragon/shared/model/organizations";
import { insertAgentProviderCredentials } from "@terragon/shared/model/agent-provider-credentials";
import { nanoid } from "nanoid";
import { getAndVerifyCredentials } from "./credentials";

async function createOrg(userId: string) {
  const org = await createOrganization({
    db,
    name: "Org",
    slug: `org-${nanoid(8).toLowerCase()}`,
  });
  await addOrganizationMember({ db, organizationId: org.id, userId });
  return org.id;
}

describe("getAndVerifyCredentials — org fence (WI-5 batch 3a)", () => {
  let user: User;
  let orgX: string;
  let orgY: string;

  beforeEach(async () => {
    user = (await createTestUser({ db })).user;
    orgX = await createOrg(user.id);
    orgY = await createOrg(user.id);
    // An Amp credential owned by the user, scoped to orgX.
    await insertAgentProviderCredentials({
      db,
      userId: user.id,
      organizationId: orgX,
      credentialData: {
        agent: "amp",
        type: "api-key",
        apiKey: "sgamp_user_test",
        isActive: true,
        expiresAt: null,
        lastRefreshedAt: null,
        metadata: null,
      },
      encryptionKey: env.ENCRYPTION_MASTER_KEY,
    });
  });

  it("resolves the credential for the thread's org", async () => {
    const creds = await getAndVerifyCredentials({
      agent: "amp",
      model: null,
      userId: user.id,
      organizationId: orgX,
    });
    expect(creds).toEqual({
      type: "env-var",
      key: "AMP_API_KEY",
      value: "sgamp_user_test",
    });
  });

  it("does NOT resolve a credential from another org (no-drift pin)", async () => {
    // The agent run belongs to a thread in orgY; the orgX credential must not
    // leak. This pins the tenant fence — the credential is chosen by the thread's
    // org, never the user's other orgs.
    await expect(
      getAndVerifyCredentials({
        agent: "amp",
        model: null,
        userId: user.id,
        organizationId: orgY,
      }),
    ).rejects.toThrow();
  });
});
