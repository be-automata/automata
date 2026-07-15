import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestAutomation,
} from "@terragon/shared/model/test-helpers";
import { User, Session } from "@terragon/shared";
import {
  createOrganization,
  addOrganizationMember,
} from "@terragon/shared/model/organizations";
import {
  session as sessionTable,
  automations as automationsTable,
} from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { mockLoggedInUser } from "@/test-helpers/mock-next";
import { getAutomations, deleteAutomation } from "./automations";
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

async function setActiveOrg(sessionId: string, orgId: string | null) {
  await db
    .update(sessionTable)
    .set({ activeOrganizationId: orgId })
    .where(eq(sessionTable.id, sessionId));
}

async function automationInOrg(userId: string, orgId: string) {
  const a = await createTestAutomation({ db, userId });
  await db
    .update(automationsTable)
    .set({ organizationId: orgId })
    .where(eq(automationsTable.id, a.id));
  return a.id;
}

describe("automations server actions — org fencing (WI-5)", () => {
  let user: User;
  let session: Session;
  let orgX: string;
  let orgY: string;
  let autoX: string;
  let autoY: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const created = await createTestUser({ db });
    user = created.user;
    session = created.session;
    orgX = await createOrg(user.id);
    orgY = await createOrg(user.id);
    autoX = await automationInOrg(user.id, orgX);
    autoY = await automationInOrg(user.id, orgY);
  });

  it("getAutomations returns only the active org's automations, honoring org-switch", async () => {
    await mockLoggedInUser(session);

    await setActiveOrg(session.id, orgX);
    const listX = unwrapResult(await getAutomations());
    const idsX = listX.map((a) => a.id);
    expect(idsX).toContain(autoX);
    expect(idsX).not.toContain(autoY);

    // Switch active org → the list follows.
    await setActiveOrg(session.id, orgY);
    const listY = unwrapResult(await getAutomations());
    const idsY = listY.map((a) => a.id);
    expect(idsY).toContain(autoY);
    expect(idsY).not.toContain(autoX);
  });

  it("deleteAutomation is fenced to the active org", async () => {
    await mockLoggedInUser(session);
    await setActiveOrg(session.id, orgY);

    // Deleting the orgX automation while active org is Y must not delete it.
    await expect(deleteAutomation(autoX)).resolves.toBeDefined();
    const [stillThere] = await db
      .select()
      .from(automationsTable)
      .where(eq(automationsTable.id, autoX));
    expect(stillThere).toBeDefined();

    // Switching to orgX lets the owner delete it.
    await setActiveOrg(session.id, orgX);
    await deleteAutomation(autoX);
    const [gone] = await db
      .select()
      .from(automationsTable)
      .where(eq(automationsTable.id, autoX));
    expect(gone).toBeUndefined();
  });
});
