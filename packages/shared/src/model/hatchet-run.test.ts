import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { createDb } from "../db";
import { thread as threadTable } from "../db/schema";
import { ThreadStatus } from "../db/types";
import { createOrganization } from "./organizations";
import { createTestUser, createTestThread } from "./test-helpers";
import { markThreadsSuperseded } from "./threads";
import {
  recordHatchetRun,
  findSupersedableReviewRuns,
  markHatchetRunsSuperseded,
  SUPERSEDE_FRESHNESS_MS,
} from "./hatchet-run";

const db = createDb(env.DATABASE_URL!);

async function makeOrg(name: string): Promise<string> {
  const org = await createOrganization({
    db,
    name,
    slug: `${name.toLowerCase()}-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

/** Set a thread's status/errorMessage directly (ThreadInsert omits these columns). */
async function setThreadStatus(
  threadId: string,
  status: ThreadStatus,
  errorMessage: string | null = null,
): Promise<void> {
  await db
    .update(threadTable)
    .set({ status, errorMessage })
    .where(eq(threadTable.id, threadId));
}

describe("hatchet-run (#8 supersede tracking, org-fenced)", () => {
  let userId: string;
  let orgA: string;
  let orgB: string;

  async function makeThread(organizationId: string, prNumber: number) {
    const { threadId } = await createTestThread({
      db,
      userId,
      overrides: {
        organizationId,
        githubRepoFullName: "acme/widgets",
        githubPRNumber: prNumber,
      },
    });
    return threadId;
  }

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    orgA = await makeOrg("acme");
    orgB = await makeOrg("globex");
  });

  it("records an in_flight run and finds it as supersedable from a newer thread", async () => {
    const oldThread = await makeThread(orgA, 42);
    const newThread = await makeThread(orgA, 42);
    await recordHatchetRun({
      db,
      threadId: oldThread,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 42,
      externalId: "run-old",
    });

    const found = await findSupersedableReviewRuns({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 42,
      excludeThreadId: newThread,
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.externalId).toBe("run-old");
    expect(found[0]!.threadId).toBe(oldThread);
  });

  it("never returns the current thread's own run (a dispatch can't supersede itself)", async () => {
    const t = await makeThread(orgA, 7);
    await recordHatchetRun({
      db,
      threadId: t,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 7,
      externalId: "run-self",
    });
    const found = await findSupersedableReviewRuns({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 7,
      excludeThreadId: t,
    });
    expect(found).toHaveLength(0);
  });

  it("is org-fenced: org B never sees org A's in-flight run for the same repo/PR", async () => {
    const aThread = await makeThread(orgA, 9);
    await recordHatchetRun({
      db,
      threadId: aThread,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 9,
      externalId: "run-a",
    });
    const bThread = await makeThread(orgB, 9);
    const found = await findSupersedableReviewRuns({
      db,
      organizationId: orgB,
      repoFullName: "acme/widgets",
      prNumber: 9,
      excludeThreadId: bThread,
    });
    expect(found).toHaveLength(0);
  });

  it("matches repo slug case-insensitively", async () => {
    const oldThread = await makeThread(orgA, 5);
    const newThread = await makeThread(orgA, 5);
    await recordHatchetRun({
      db,
      threadId: oldThread,
      organizationId: orgA,
      repoFullName: "ACME/Widgets", // stored lowercased
      prNumber: 5,
      externalId: "run-case",
    });
    const found = await findSupersedableReviewRuns({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 5,
      excludeThreadId: newThread,
    });
    expect(found).toHaveLength(1);
  });

  it("ignores runs older than the freshness window (long-finished, never a cancel target)", async () => {
    const oldThread = await makeThread(orgA, 3);
    const newThread = await makeThread(orgA, 3);
    await recordHatchetRun({
      db,
      threadId: oldThread,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 3,
      externalId: "run-stale",
    });
    // A `now` far past the freshness window makes the just-inserted row too old.
    const found = await findSupersedableReviewRuns({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 3,
      excludeThreadId: newThread,
      now: new Date(Date.now() + SUPERSEDE_FRESHNESS_MS + 60_000),
    });
    expect(found).toHaveLength(0);
  });

  it("markHatchetRunsSuperseded drops rows out of the supersedable set", async () => {
    const oldThread = await makeThread(orgA, 11);
    const newThread = await makeThread(orgA, 11);
    const row = await recordHatchetRun({
      db,
      threadId: oldThread,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 11,
      externalId: "run-x",
    });
    await markHatchetRunsSuperseded({ db, ids: [row.id] });
    const found = await findSupersedableReviewRuns({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      prNumber: 11,
      excludeThreadId: newThread,
    });
    expect(found).toHaveLength(0);
  });
});

describe("markThreadsSuperseded", () => {
  let userId: string;
  let orgA: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    orgA = await makeOrg("acme");
  });

  it("flips an ACTIVE thread to terminal 'complete' with a 'superseded' reason", async () => {
    const { threadId } = await createTestThread({
      db,
      userId,
      overrides: { organizationId: orgA },
    });
    await setThreadStatus(threadId, "working");
    const moved = await markThreadsSuperseded({ db, threadIds: [threadId] });
    expect(moved).toBe(1);
    const [row] = await db.query.thread.findMany({
      where: (thread, { eq }) => eq(thread.id, threadId),
    });
    expect(row!.status).toBe("complete");
    expect(row!.errorMessage).toBe("superseded");
  });

  it("does NOT clobber a thread that already reached a terminal state", async () => {
    const { threadId } = await createTestThread({
      db,
      userId,
      overrides: { organizationId: orgA },
    });
    await setThreadStatus(threadId, "complete", null);
    const moved = await markThreadsSuperseded({ db, threadIds: [threadId] });
    expect(moved).toBe(0);
    const [row] = await db.query.thread.findMany({
      where: (thread, { eq }) => eq(thread.id, threadId),
    });
    expect(row!.errorMessage).toBeNull();
  });
});
