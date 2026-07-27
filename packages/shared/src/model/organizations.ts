import { DB } from "../db";
import { organization, member } from "../db/schema";
import { Organization, Member } from "../db/types";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

/**
 * Data-access helpers for the Better Auth `organization` tenant tables.
 *
 * Better Auth owns org lifecycle through its API in the request path; these
 * helpers exist for server-side/background code (and the query sweep in WI-5d)
 * that needs to read or seed org rows directly against the pooled `db`. They
 * are deliberately thin — the tenant-scoping seam from ADR-001 lands separately.
 */

export async function createOrganization({
  db,
  name,
  slug,
  logo,
  metadata,
}: {
  db: DB;
  name: string;
  slug: string;
  logo?: string;
  metadata?: string;
}): Promise<Organization> {
  const [org] = await db
    .insert(organization)
    .values({
      id: nanoid(),
      name,
      slug,
      logo,
      metadata,
      createdAt: new Date(),
    })
    .returning();
  if (!org) {
    throw new Error("Failed to create organization");
  }
  return org;
}

export async function getOrganizationById({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<Organization | undefined> {
  const [org] = await db
    .select()
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  return org;
}

export async function getOrganizationBySlug({
  db,
  slug,
}: {
  db: DB;
  slug: string;
}): Promise<Organization | undefined> {
  const [org] = await db
    .select()
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);
  return org;
}

export async function addOrganizationMember({
  db,
  organizationId,
  userId,
  role = "member",
}: {
  db: DB;
  organizationId: string;
  userId: string;
  role?: string;
}): Promise<Member> {
  const [row] = await db
    .insert(member)
    .values({
      id: nanoid(),
      organizationId,
      userId,
      role,
      createdAt: new Date(),
    })
    .returning();
  if (!row) {
    throw new Error("Failed to add organization member");
  }
  return row;
}

export async function getOrganizationMembers({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<Member[]> {
  return db
    .select()
    .from(member)
    .where(eq(member.organizationId, organizationId))
    .orderBy(member.createdAt);
}

/**
 * The userId to attribute an org-level (non-user-initiated) task to — e.g. a
 * mirror-intake task from a PR opening, which has no "commenter" (pilot).
 * Prefers the earliest `owner`; falls back to the earliest member of any role so
 * an org seeded without an explicit owner role still resolves. Null when the org
 * has no members at all.
 */
export async function getOrganizationOwnerUserId({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<string | null> {
  const members = await getOrganizationMembers({ db, organizationId });
  if (members.length === 0) {
    return null;
  }
  const owner = members.find((m) => m.role === "owner");
  return (owner ?? members[0]!).userId;
}

export async function getMembership({
  db,
  organizationId,
  userId,
}: {
  db: DB;
  organizationId: string;
  userId: string;
}): Promise<Member | undefined> {
  const [row] = await db
    .select()
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .limit(1);
  return row;
}

/**
 * Orgs a user belongs to, resolved through the `member` join. This is the read
 * the guard layer will use to populate `session.activeOrganizationId`.
 */
export async function getOrganizationsForUser({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}): Promise<Organization[]> {
  const rows = await db
    .select({ organization })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, userId))
    // Secondary key makes the "oldest org first" contract deterministic even
    // when createdAt ties (bulk backfills create orgs in the same instant).
    .orderBy(organization.createdAt, organization.id);
  return rows.map((row) => row.organization);
}

export async function removeOrganizationMember({
  db,
  organizationId,
  userId,
}: {
  db: DB;
  organizationId: string;
  userId: string;
}): Promise<void> {
  await db
    .delete(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    );
}
