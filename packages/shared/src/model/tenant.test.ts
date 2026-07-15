import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser } from "./test-helpers";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { User } from "../db/types";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { thread, threadChat, environment } from "../db/schema";
import {
  createOrganization,
  addOrganizationMember,
} from "./organizations";
import { forTenant } from "./tenant";

const db = createDb(env.DATABASE_URL!);

function slug() {
  return `org-${nanoid(8).toLowerCase()}`;
}

async function createOrgWithMembers(userIds: string[]) {
  const org = await createOrganization({ db, name: "Org", slug: slug() });
  for (const userId of userIds) {
    await addOrganizationMember({ db, organizationId: org.id, userId });
  }
  return org.id;
}

const threadValues = {
  githubRepoFullName: "acme/repo",
  repoBaseBranchName: "main",
  name: "Test thread",
};

describe("forTenant accessor — thread tenant scoping", () => {
  // orgX has two co-members (alice, bob); orgY has carol.
  let alice: User;
  let bob: User;
  let carol: User;
  let orgX: string;
  let orgY: string;

  beforeEach(async () => {
    alice = (await createTestUser({ db })).user;
    bob = (await createTestUser({ db })).user;
    carol = (await createTestUser({ db })).user;
    orgX = await createOrgWithMembers([alice.id, bob.id]);
    orgY = await createOrgWithMembers([carol.id]);
  });

  it("createThread stamps organizationId on the thread and its chat", async () => {
    const { threadId, threadChatId } = await forTenant({
      db,
      organizationId: orgX,
      userId: alice.id,
    }).createThread({
      threadValues,
      initialChatValues: { agent: "claudeCode" },
      enableThreadChatCreation: true,
    });

    const [row] = await db.select().from(thread).where(eq(thread.id, threadId));
    expect(row!.organizationId).toBe(orgX);
    expect(row!.userId).toBe(alice.id);

    const [chat] = await db
      .select()
      .from(threadChat)
      .where(eq(threadChat.id, threadChatId));
    expect(chat!.organizationId).toBe(orgX);
  });

  it("is private-to-creator within an org: a co-member cannot read it", async () => {
    const { threadId } = await forTenant({
      db,
      organizationId: orgX,
      userId: alice.id,
    }).createThread({
      threadValues,
      initialChatValues: { agent: "claudeCode" },
    });

    // Creator sees it.
    const asAlice = await forTenant({
      db,
      organizationId: orgX,
      userId: alice.id,
    }).getThread(threadId);
    expect(asAlice?.id).toBe(threadId);

    // Same-org co-member does NOT (per-user task list preserved).
    const asBob = await forTenant({
      db,
      organizationId: orgX,
      userId: bob.id,
    }).getThread(threadId);
    expect(asBob).toBeUndefined();
  });

  it("enforces the tenant boundary across orgs", async () => {
    const { threadId } = await forTenant({
      db,
      organizationId: orgX,
      userId: alice.id,
    }).createThread({
      threadValues,
      initialChatValues: { agent: "claudeCode" },
    });

    // Another org's member cannot read it.
    const asCarol = await forTenant({
      db,
      organizationId: orgY,
      userId: carol.id,
    }).getThread(threadId);
    expect(asCarol).toBeUndefined();

    // The fence is on org, not just user: the creator with the WRONG org context
    // (as if their active org were orgY) is also denied.
    const aliceWrongOrg = await forTenant({
      db,
      organizationId: orgY,
      userId: alice.id,
    }).getThread(threadId);
    expect(aliceWrongOrg).toBeUndefined();
  });

  it("listThreads only returns the caller's own threads within the org", async () => {
    const aliceCtx = forTenant({ db, organizationId: orgX, userId: alice.id });
    const bobCtx = forTenant({ db, organizationId: orgX, userId: bob.id });

    const { threadId } = await aliceCtx.createThread({
      threadValues,
      initialChatValues: { agent: "claudeCode" },
    });
    await bobCtx.createThread({
      threadValues,
      initialChatValues: { agent: "claudeCode" },
    });

    const aliceList = await aliceCtx.listThreads();
    expect(aliceList.map((t) => t.id)).toContain(threadId);
    // Bob's list never includes Alice's thread.
    const bobList = await bobCtx.listThreads();
    expect(bobList.map((t) => t.id)).not.toContain(threadId);
  });

  it("blocks writes that cross the tenant fence", async () => {
    const { threadId } = await forTenant({
      db,
      organizationId: orgX,
      userId: alice.id,
    }).createThread({
      threadValues,
      initialChatValues: { agent: "claudeCode" },
    });

    // Co-member update is fenced out (0 rows -> throws).
    await expect(
      forTenant({ db, organizationId: orgX, userId: bob.id }).updateThread(
        threadId,
        { name: "hijacked" },
      ),
    ).rejects.toThrow();

    // Cross-org delete is fenced out.
    await expect(
      forTenant({ db, organizationId: orgY, userId: carol.id }).deleteThread(
        threadId,
      ),
    ).rejects.toThrow();

    // The thread is untouched.
    const [row] = await db.select().from(thread).where(eq(thread.id, threadId));
    expect(row!.name).toBe("Test thread");
    expect(row!.organizationId).toBe(orgX);

    // The owner in the right org can update it.
    await forTenant({
      db,
      organizationId: orgX,
      userId: alice.id,
    }).updateThread(threadId, { name: "renamed" });
    const [after] = await db
      .select()
      .from(thread)
      .where(eq(thread.id, threadId));
    expect(after!.name).toBe("renamed");
  });
});

describe("forTenant accessor — environment tenant scoping", () => {
  let alice: User;
  let bob: User;
  let carol: User;
  let orgX: string;
  let orgY: string;

  beforeEach(async () => {
    alice = (await createTestUser({ db })).user;
    bob = (await createTestUser({ db })).user;
    carol = (await createTestUser({ db })).user;
    orgX = await createOrgWithMembers([alice.id, bob.id]);
    orgY = await createOrgWithMembers([carol.id]);
  });

  it("getOrCreateEnvironment stamps the org and is idempotent within the tenant", async () => {
    const ctx = forTenant({ db, organizationId: orgX, userId: alice.id });
    const env1 = await ctx.getOrCreateEnvironment("acme/repo");
    expect(env1.organizationId).toBe(orgX);
    expect(env1.userId).toBe(alice.id);

    const env2 = await ctx.getOrCreateEnvironment("acme/repo");
    expect(env2.id).toBe(env1.id);

    const [row] = await db
      .select()
      .from(environment)
      .where(eq(environment.id, env1.id));
    expect(row!.organizationId).toBe(orgX);
  });

  it("fences environment reads to the owner within the org", async () => {
    const env = await forTenant({
      db,
      organizationId: orgX,
      userId: alice.id,
    }).getOrCreateEnvironment("acme/repo");

    // Owner in the right org sees it.
    const asAlice = await forTenant({
      db,
      organizationId: orgX,
      userId: alice.id,
    }).getEnvironment(env.id);
    expect(asAlice?.id).toBe(env.id);

    // Same-org co-member does not.
    const asBob = await forTenant({
      db,
      organizationId: orgX,
      userId: bob.id,
    }).getEnvironment(env.id);
    expect(asBob).toBeUndefined();

    // Cross-org member does not.
    const asCarol = await forTenant({
      db,
      organizationId: orgY,
      userId: carol.id,
    }).getEnvironment(env.id);
    expect(asCarol).toBeUndefined();

    // Owner with the wrong active org is denied (fence is on org, not just user).
    const aliceWrongOrg = await forTenant({
      db,
      organizationId: orgY,
      userId: alice.id,
    }).getEnvironment(env.id);
    expect(aliceWrongOrg).toBeUndefined();
  });

  it("listEnvironments only returns the caller's env within the org", async () => {
    const aliceCtx = forTenant({ db, organizationId: orgX, userId: alice.id });
    const bobCtx = forTenant({ db, organizationId: orgX, userId: bob.id });
    const aliceEnv = await aliceCtx.getOrCreateEnvironment("acme/a");
    await bobCtx.getOrCreateEnvironment("acme/b");

    const aliceList = await aliceCtx.listEnvironments(true);
    expect(aliceList.map((e) => e.id)).toContain(aliceEnv.id);
    const bobList = await bobCtx.listEnvironments(true);
    expect(bobList.map((e) => e.id)).not.toContain(aliceEnv.id);
  });

  it("does not update or delete across the tenant fence", async () => {
    const env = await forTenant({
      db,
      organizationId: orgX,
      userId: alice.id,
    }).getOrCreateEnvironment("acme/repo");

    // Co-member update is a no-op (fenced out).
    await forTenant({ db, organizationId: orgX, userId: bob.id }).updateEnvironment(
      env.id,
      { setupScript: "hijacked" },
    );
    // Cross-org delete is a no-op.
    await forTenant({
      db,
      organizationId: orgY,
      userId: carol.id,
    }).deleteEnvironment(env.id);

    const [still] = await db
      .select()
      .from(environment)
      .where(eq(environment.id, env.id));
    expect(still).toBeDefined();
    expect(still!.setupScript).toBeNull();

    // The owner in the right org can update it.
    await forTenant({
      db,
      organizationId: orgX,
      userId: alice.id,
    }).updateEnvironment(env.id, { setupScript: "echo ok" });
    const [updated] = await db
      .select()
      .from(environment)
      .where(eq(environment.id, env.id));
    expect(updated!.setupScript).toBe("echo ok");
  });
});
