import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser } from "./test-helpers";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { User } from "../db/types";
import { nanoid } from "nanoid";
import {
  addOrganizationMember,
  createOrganization,
  getMembership,
  getOrganizationById,
  getOrganizationBySlug,
  getOrganizationMembers,
  getOrganizationOwnerUserId,
  getOrganizationsForUser,
  removeOrganizationMember,
} from "./organizations";

const db = createDb(env.DATABASE_URL!);

function uniqueSlug(prefix = "org") {
  return `${prefix}-${nanoid(8).toLowerCase()}`;
}

describe("organizations", () => {
  let owner: User;

  beforeEach(async () => {
    const created = await createTestUser({ db });
    owner = created.user;
  });

  it("creates and reads an organization by id and slug", async () => {
    const slug = uniqueSlug();
    const org = await createOrganization({ db, name: "Acme", slug });

    expect(org.id).toBeTruthy();
    expect(org.name).toBe("Acme");
    expect(org.slug).toBe(slug);
    expect(org.createdAt).toBeInstanceOf(Date);

    const byId = await getOrganizationById({ db, organizationId: org.id });
    expect(byId?.id).toBe(org.id);

    const bySlug = await getOrganizationBySlug({ db, slug });
    expect(bySlug?.id).toBe(org.id);
  });

  it("enforces slug uniqueness", async () => {
    const slug = uniqueSlug();
    await createOrganization({ db, name: "First", slug });
    await expect(
      createOrganization({ db, name: "Second", slug }),
    ).rejects.toThrow();
  });

  it("adds a member, defaults role to member, and lists members", async () => {
    const org = await createOrganization({
      db,
      name: "Team",
      slug: uniqueSlug(),
    });

    const membership = await addOrganizationMember({
      db,
      organizationId: org.id,
      userId: owner.id,
      role: "owner",
    });
    expect(membership.role).toBe("owner");

    const second = await createTestUser({ db });
    await addOrganizationMember({
      db,
      organizationId: org.id,
      userId: second.user.id,
    });

    const members = await getOrganizationMembers({
      db,
      organizationId: org.id,
    });
    expect(members).toHaveLength(2);
    const defaultMember = members.find((m) => m.userId === second.user.id);
    expect(defaultMember?.role).toBe("member");
  });

  it("resolves the owner userId, preferring role 'owner', else the earliest member; null when empty", async () => {
    const org = await createOrganization({
      db,
      name: "Attrib",
      slug: uniqueSlug(),
    });
    // No members yet.
    expect(
      await getOrganizationOwnerUserId({ db, organizationId: org.id }),
    ).toBeNull();

    // Earliest member is added as a plain member; a later user is the owner.
    const earliest = await createTestUser({ db });
    await addOrganizationMember({
      db,
      organizationId: org.id,
      userId: earliest.user.id,
    });
    await addOrganizationMember({
      db,
      organizationId: org.id,
      userId: owner.id,
      role: "owner",
    });

    // Prefers the owner role over the earliest-created member.
    expect(
      await getOrganizationOwnerUserId({ db, organizationId: org.id }),
    ).toBe(owner.id);
  });

  it("falls back to the earliest member when no owner role exists", async () => {
    const org = await createOrganization({
      db,
      name: "NoOwner",
      slug: uniqueSlug(),
    });
    await addOrganizationMember({
      db,
      organizationId: org.id,
      userId: owner.id,
    });
    expect(
      await getOrganizationOwnerUserId({ db, organizationId: org.id }),
    ).toBe(owner.id);
  });

  it("prevents duplicate membership for the same user in one org", async () => {
    const org = await createOrganization({
      db,
      name: "Dupes",
      slug: uniqueSlug(),
    });
    await addOrganizationMember({
      db,
      organizationId: org.id,
      userId: owner.id,
    });
    await expect(
      addOrganizationMember({
        db,
        organizationId: org.id,
        userId: owner.id,
      }),
    ).rejects.toThrow();
  });

  it("resolves the organizations a user belongs to", async () => {
    const orgA = await createOrganization({
      db,
      name: "A",
      slug: uniqueSlug("a"),
    });
    const orgB = await createOrganization({
      db,
      name: "B",
      slug: uniqueSlug("b"),
    });
    const orgC = await createOrganization({
      db,
      name: "C",
      slug: uniqueSlug("c"),
    });

    await addOrganizationMember({
      db,
      organizationId: orgA.id,
      userId: owner.id,
    });
    await addOrganizationMember({
      db,
      organizationId: orgB.id,
      userId: owner.id,
    });

    const orgs = await getOrganizationsForUser({ db, userId: owner.id });
    const ids = orgs.map((o) => o.id);
    expect(ids).toContain(orgA.id);
    expect(ids).toContain(orgB.id);
    expect(ids).not.toContain(orgC.id);
  });

  it("reads and removes a single membership", async () => {
    const org = await createOrganization({
      db,
      name: "Removable",
      slug: uniqueSlug(),
    });
    await addOrganizationMember({
      db,
      organizationId: org.id,
      userId: owner.id,
    });

    const found = await getMembership({
      db,
      organizationId: org.id,
      userId: owner.id,
    });
    expect(found?.userId).toBe(owner.id);

    await removeOrganizationMember({
      db,
      organizationId: org.id,
      userId: owner.id,
    });

    const gone = await getMembership({
      db,
      organizationId: org.id,
      userId: owner.id,
    });
    expect(gone).toBeUndefined();
  });
});
