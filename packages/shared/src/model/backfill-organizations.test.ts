import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser, createTestThread } from "./test-helpers";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { User } from "../db/types";
import { eq } from "drizzle-orm";
import { thread, member, organization, environment } from "../db/schema";
import { nanoid } from "nanoid";
import { backfillOrganizations } from "../../scripts/backfill-organizations";

const db = createDb(env.DATABASE_URL!);

async function createEnv(userId: string, repo: string) {
  await db.insert(environment).values({
    id: nanoid(),
    userId,
    repoFullName: repo,
  });
}

describe("backfill-organizations", () => {
  let userA: User;
  let userB: User;

  beforeEach(async () => {
    userA = (await createTestUser({ db })).user;
    userB = (await createTestUser({ db })).user;
  });

  it("creates one personal org per user and stamps their rows", async () => {
    const { threadId: threadA } = await createTestThread({
      db,
      userId: userA.id,
    });
    const { threadId: threadB } = await createTestThread({
      db,
      userId: userB.id,
    });
    await createEnv(userA.id, "acme/a");

    const result = await backfillOrganizations(db);
    expect(result.orgsCreated).toBeGreaterThanOrEqual(2);

    // Each user owns exactly one org, as `owner`.
    const membersA = await db
      .select()
      .from(member)
      .where(eq(member.userId, userA.id));
    expect(membersA).toHaveLength(1);
    expect(membersA[0]!.role).toBe("owner");
    const orgA = membersA[0]!.organizationId;

    const membersB = await db
      .select()
      .from(member)
      .where(eq(member.userId, userB.id));
    expect(membersB).toHaveLength(1);
    const orgB = membersB[0]!.organizationId;

    // Distinct orgs — the tenant boundary.
    expect(orgA).not.toBe(orgB);

    // Threads carry their owner's org, not the other user's.
    const [rowA] = await db.select().from(thread).where(eq(thread.id, threadA));
    const [rowB] = await db.select().from(thread).where(eq(thread.id, threadB));
    expect(rowA!.organizationId).toBe(orgA);
    expect(rowB!.organizationId).toBe(orgB);

    // Environments stamped too.
    const [envA] = await db
      .select()
      .from(environment)
      .where(eq(environment.userId, userA.id));
    expect(envA!.organizationId).toBe(orgA);
  });

  it("is idempotent — re-running creates no new orgs and leaves stamps intact", async () => {
    const { threadId } = await createTestThread({ db, userId: userA.id });
    const first = await backfillOrganizations(db);
    const orgCountAfterFirst = (await db.select().from(organization)).length;

    const second = await backfillOrganizations(db);
    expect(second.orgsCreated).toBe(0);
    expect(Object.keys(second.rowsStamped)).toHaveLength(0);

    const orgCountAfterSecond = (await db.select().from(organization)).length;
    expect(orgCountAfterSecond).toBe(orgCountAfterFirst);

    // A single membership per user (no duplicate).
    const members = await db
      .select()
      .from(member)
      .where(eq(member.userId, userA.id));
    expect(members).toHaveLength(1);

    const [row] = await db.select().from(thread).where(eq(thread.id, threadId));
    expect(row!.organizationId).toBe(members[0]!.organizationId);
    // Sanity: the first pass reported the thread stamp.
    expect(first.rowsStamped.thread).toBeGreaterThanOrEqual(1);
  });

  it("dry run reports orgs to create but writes nothing", async () => {
    // NB: `it`s in a file share the isolated DB, so assert on THIS test's fresh
    // user rather than global emptiness.
    const { threadId } = await createTestThread({ db, userId: userA.id });

    const result = await backfillOrganizations(db, { dryRun: true });
    expect(result.orgsCreated).toBeGreaterThanOrEqual(2);
    expect(Object.keys(result.rowsStamped)).toHaveLength(0);

    // No membership was written for this user, and their thread stays unstamped.
    const members = await db
      .select()
      .from(member)
      .where(eq(member.userId, userA.id));
    expect(members).toHaveLength(0);
    const [row] = await db.select().from(thread).where(eq(thread.id, threadId));
    expect(row!.organizationId).toBeNull();
  });
});
