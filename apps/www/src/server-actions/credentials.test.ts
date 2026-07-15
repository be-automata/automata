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
import { unwrapResult } from "@/lib/server-actions";

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
});
