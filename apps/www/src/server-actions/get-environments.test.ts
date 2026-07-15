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
  environment as environmentTable,
} from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { mockLoggedInUser } from "@/test-helpers/mock-next";
import { getEnvironments } from "./get-environments";
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

async function envInOrg(userId: string, orgId: string, repo: string) {
  const [row] = await db
    .insert(environmentTable)
    .values({ userId, organizationId: orgId, repoFullName: repo })
    .returning();
  return row!.id;
}

describe("getEnvironments server action — org fencing (WI-5)", () => {
  let user: User;
  let session: Session;
  let orgX: string;
  let orgY: string;
  let envX: string;
  let envY: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const created = await createTestUser({ db });
    user = created.user;
    session = created.session;
    orgX = await createOrg(user.id);
    orgY = await createOrg(user.id);
    envX = await envInOrg(user.id, orgX, "acme/x");
    envY = await envInOrg(user.id, orgY, "acme/y");
  });

  it("returns only the active org's environments and honors org-switch", async () => {
    await mockLoggedInUser(session);

    await db
      .update(sessionTable)
      .set({ activeOrganizationId: orgX })
      .where(eq(sessionTable.id, session.id));
    const listX = unwrapResult(await getEnvironments());
    const idsX = listX.map((e) => e.id);
    expect(idsX).toContain(envX);
    expect(idsX).not.toContain(envY);

    await db
      .update(sessionTable)
      .set({ activeOrganizationId: orgY })
      .where(eq(sessionTable.id, session.id));
    const listY = unwrapResult(await getEnvironments());
    const idsY = listY.map((e) => e.id);
    expect(idsY).toContain(envY);
    expect(idsY).not.toContain(envX);
  });
});
