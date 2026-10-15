import { describe, it, vi, beforeEach, expect } from "vitest";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { User, Session } from "@terragon/shared";
import {
  createOrganization,
  addOrganizationMember,
} from "@terragon/shared/model/organizations";
import { session as sessionTable } from "@terragon/shared/db/schema";
import { mockLoggedInUser } from "@/test-helpers/mock-next";
import { unwrapResult } from "@/lib/server-actions";
import { getMyOrganizations, switchActiveOrganization } from "./organizations";

async function createOrg(name: string, slug: string) {
  return await createOrganization({ db, name, slug });
}

async function setActiveOrg(sessionId: string, orgId: string | null) {
  await db
    .update(sessionTable)
    .set({ activeOrganizationId: orgId })
    .where(eq(sessionTable.id, sessionId));
}

describe("organization server actions", () => {
  let user: User;
  let session: Session;
  let teamOrgId: string;
  let personalOrgId: string;
  let strangerOrgId: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const created = await createTestUser({ db });
    user = created.user;
    session = created.session;
    const suffix = nanoid(8).toLowerCase();
    // Created first, so it is the "oldest" org; it must still list after
    // the personal one.
    const team = await createOrg("Team", `team-${suffix}`);
    const personal = await createOrg("Me", `personal-${suffix}`);
    const stranger = await createOrg("Stranger", `stranger-${suffix}`);
    await addOrganizationMember({
      db,
      organizationId: team.id,
      userId: user.id,
    });
    await addOrganizationMember({
      db,
      organizationId: personal.id,
      userId: user.id,
    });
    teamOrgId = team.id;
    personalOrgId = personal.id;
    strangerOrgId = stranger.id;
    await mockLoggedInUser(session);
  });

  it("lists only the user's orgs, personal first, with the active one", async () => {
    await setActiveOrg(session.id, teamOrgId);
    const result = unwrapResult(await getMyOrganizations());
    expect(result.organizations.map((org) => org.id)).toEqual([
      personalOrgId,
      teamOrgId,
    ]);
    expect(result.organizations[0]?.isPersonal).toBe(true);
    expect(result.activeOrganizationId).toBe(teamOrgId);
  });

  it("reports no active org when the session points at an org the user left", async () => {
    await setActiveOrg(session.id, strangerOrgId);
    const result = unwrapResult(await getMyOrganizations());
    expect(result.activeOrganizationId).toBeNull();
  });

  it("refuses to switch to an org the user is not a member of", async () => {
    const setActive = vi
      .spyOn(auth.api, "setActiveOrganization")
      .mockResolvedValue(null as never);
    const result = await switchActiveOrganization({
      organizationId: strangerOrgId,
    });
    expect(result.success).toBe(false);
    expect(setActive).not.toHaveBeenCalled();
  });

  it("switches to an org the user belongs to", async () => {
    const setActive = vi
      .spyOn(auth.api, "setActiveOrganization")
      .mockResolvedValue(null as never);
    unwrapResult(await switchActiveOrganization({ organizationId: teamOrgId }));
    expect(setActive).toHaveBeenCalledWith(
      expect.objectContaining({ body: { organizationId: teamOrgId } }),
    );
  });
});
