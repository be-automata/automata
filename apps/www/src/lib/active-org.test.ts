import { describe, it, beforeEach, vi, expect } from "vitest";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestOrganization,
} from "@terragon/shared/model/test-helpers";
import {
  addOrganizationMember,
  createOrganization,
} from "@terragon/shared/model/organizations";
import { organization as organizationTable } from "@terragon/shared/db/schema";
import { User } from "@terragon/shared";
import { withDefaultActiveOrganization } from "./active-org";

describe("withDefaultActiveOrganization (session.create.before hook body)", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
  });

  it("stamps the member's org onto a new session", async () => {
    const { organization } = await createTestOrganization({
      db,
      userId: user.id,
      name: "stamp",
    });
    const session = { userId: user.id, token: "t" };
    const result = await withDefaultActiveOrganization({ db, session });
    expect(result).toEqual({
      data: { ...session, activeOrganizationId: organization.id },
    });
  });

  it("returns undefined for a user with no org (session unchanged)", async () => {
    expect(
      await withDefaultActiveOrganization({ db, session: { userId: user.id } }),
    ).toBeUndefined();
  });

  it("respects an explicit activeOrganizationId", async () => {
    await createTestOrganization({ db, userId: user.id, name: "ignored" });
    expect(
      await withDefaultActiveOrganization({
        db,
        session: { userId: user.id, activeOrganizationId: "explicit-org" },
      }),
    ).toBeUndefined();
  });

  it("picks the oldest-created org for multi-org users", async () => {
    const { organization: first } = await createTestOrganization({
      db,
      userId: user.id,
      name: "first",
    });
    // createdAt has ms precision — guarantee a strictly later second org.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createTestOrganization({ db, userId: user.id, name: "second" });
    const result = await withDefaultActiveOrganization({
      db,
      session: { userId: user.id, activeOrganizationId: null },
    });
    expect(result?.data.activeOrganizationId).toBe(first.id);
  });

  // createdAt has ms precision — space orgs so "oldest" is strict.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  async function joinOrg(slug: string, isPersonal = false) {
    const org = await createOrganization({ db, name: slug, slug });
    if (isPersonal) {
      await db
        .update(organizationTable)
        .set({ isPersonal: true })
        .where(eq(organizationTable.id, org.id));
    }
    await addOrganizationMember({
      db,
      organizationId: org.id,
      userId: user.id,
    });
    return org;
  }

  it("prefers the oldest team org over an older personal org (is_personal)", async () => {
    const suffix = nanoid(8).toLowerCase();
    await joinOrg(`mine-${suffix}`, true);
    await tick();
    const team = await joinOrg(`team-${suffix}`);
    await tick();
    await joinOrg(`later-team-${suffix}`);
    const result = await withDefaultActiveOrganization({
      db,
      session: { userId: user.id, activeOrganizationId: null },
    });
    expect(result?.data.activeOrganizationId).toBe(team.id);
  });

  it("treats a team org with a personal- slug as a team org (is_personal only)", async () => {
    const suffix = nanoid(8).toLowerCase();
    const team = await joinOrg(`personal-${suffix}`);
    await tick();
    await joinOrg(`team-${suffix}`);
    const result = await withDefaultActiveOrganization({
      db,
      session: { userId: user.id, activeOrganizationId: null },
    });
    expect(result?.data.activeOrganizationId).toBe(team.id);
  });

  it("falls back to the personal org when the user has no team org", async () => {
    const suffix = nanoid(8).toLowerCase();
    const personal = await joinOrg(`solo-${suffix}`, true);
    const result = await withDefaultActiveOrganization({
      db,
      session: { userId: user.id, activeOrganizationId: null },
    });
    expect(result?.data.activeOrganizationId).toBe(personal.id);
  });
});
