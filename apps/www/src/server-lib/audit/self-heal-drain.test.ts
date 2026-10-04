import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { thread as threadTable } from "@terragon/shared/db/schema";
import type { ThreadSourceMetadata } from "@terragon/shared";
import {
  ORG_DEFAULT_REPO_SENTINEL,
  getRepoReviewSetting,
} from "@terragon/shared/model/repo-review-settings";
import { listSelfHealAdminActions } from "@terragon/shared/model/self-heal-admin-log";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { drainSelfHeal, type DrainDeps } from "./self-heal-drain";

const AUDIT_STAMP: ThreadSourceMetadata = {
  type: "automation-skill",
  skillName: "audit-findings",
  contentSha: "sha",
  source: "db",
};
const REVIEW_STAMP: ThreadSourceMetadata = {
  ...AUDIT_STAMP,
  skillName: "pr-review",
} as ThreadSourceMetadata;

let userId: string;
let orgId: string;

async function makeThread(
  stamp: ThreadSourceMetadata,
  status: "working" | "complete" = "working",
  organizationId: string = orgId,
): Promise<string> {
  const { threadId } = await createTestThread({ db, userId });
  await db
    .update(threadTable)
    .set({ organizationId, sourceMetadata: stamp, status })
    .where(eq(threadTable.id, threadId));
  return threadId;
}

function makeDeps(
  runsByThread: Record<
    string,
    | Array<{
        externalId: string;
        status: "QUEUED" | "RUNNING" | "COMPLETED";
      }>
    | Error
  >,
) {
  const cancel = vi.fn(async (_ids: string[]) => undefined);
  const listRuns = vi.fn(async (hint: { threadId: string }) => {
    const runs = runsByThread[hint.threadId];
    if (runs instanceof Error) throw runs;
    return runs ?? [];
  });
  const deps: DrainDeps = {
    listRuns: listRuns as unknown as DrainDeps["listRuns"],
    cancel,
    now: () => new Date("2026-10-04T12:00:00.000Z"),
    log: vi.fn(),
  };
  return { deps, cancel, listRuns };
}

beforeEach(async () => {
  userId = (await createTestUser({ db })).user.id;
  orgId = await createTestOrg({ db });
});

describe("drainSelfHeal", () => {
  it("sets the kill switch, cancels only live runs of self-heal threads, and logs the actor", async () => {
    const a = await makeThread(AUDIT_STAMP);
    const b = await makeThread(AUDIT_STAMP);
    const review = await makeThread(REVIEW_STAMP);
    const done = await makeThread(AUDIT_STAMP, "complete");
    const { deps, cancel, listRuns } = makeDeps({
      [a]: [
        { externalId: "run-a", status: "RUNNING" },
        { externalId: "run-a-old", status: "COMPLETED" },
      ],
      [b]: [{ externalId: "run-b", status: "QUEUED" }],
      [review]: [{ externalId: "run-review", status: "RUNNING" }],
      [done]: [{ externalId: "run-done", status: "RUNNING" }],
    });

    const result = await drainSelfHeal({
      db,
      organizationId: orgId,
      actorUserId: userId,
      deps,
    });

    expect(result.killSwitchSet).toBe(true);
    expect(result.nothingInFlight).toBe(false);
    expect([...result.cancelled].sort()).toEqual([a, b].sort());
    expect(result.lookupFailed).toEqual([]);
    expect(cancel.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([["run-a"], ["run-b"]]),
    );
    expect(cancel).toHaveBeenCalledTimes(2);
    const looked = listRuns.mock.calls.map((c) => c[0].threadId);
    expect(looked).not.toContain(review);
    expect(looked).not.toContain(done);

    const setting = await getRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
    });
    expect(setting?.selfHealKillSwitch).toBe(true);

    const log = await listSelfHealAdminActions({ db, organizationId: orgId });
    const drains = log.filter((row) => row.action === "drain");
    expect(drains).toHaveLength(1);
    expect(drains[0]?.actorUserId).toBe(userId);
    expect(
      (drains[0]?.target as { cancelled: string[] }).cancelled.sort(),
    ).toEqual([a, b].sort());
  });

  it("does not touch another org's threads", async () => {
    const otherOrg = await createTestOrg({ db, name: "Other" });
    const foreign = await makeThread(AUDIT_STAMP, "working", otherOrg);
    const { deps, cancel } = makeDeps({
      [foreign]: [{ externalId: "run-x", status: "RUNNING" }],
    });
    const result = await drainSelfHeal({
      db,
      organizationId: orgId,
      actorUserId: userId,
      deps,
    });
    expect(result.nothingInFlight).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("reports a failed lookup and still cancels the other thread", async () => {
    const bad = await makeThread(AUDIT_STAMP);
    const good = await makeThread(AUDIT_STAMP);
    const { deps, cancel } = makeDeps({
      [bad]: new Error("Hatchet run status failed: 502"),
      [good]: [{ externalId: "run-good", status: "RUNNING" }],
    });
    const result = await drainSelfHeal({
      db,
      organizationId: orgId,
      actorUserId: userId,
      deps,
    });
    expect(result.lookupFailed).toEqual([bad]);
    expect(result.cancelled).toEqual([good]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(["run-good"]);
  });

  it("is idempotent: nothing in flight still sets the switch and writes the log row", async () => {
    const { deps, cancel } = makeDeps({});
    const first = await drainSelfHeal({
      db,
      organizationId: orgId,
      actorUserId: userId,
      deps,
    });
    const second = await drainSelfHeal({
      db,
      organizationId: orgId,
      actorUserId: userId,
      deps,
    });
    for (const result of [first, second]) {
      expect(result.nothingInFlight).toBe(true);
      expect(result.killSwitchSet).toBe(true);
      expect(result.cancelled).toEqual([]);
    }
    expect(cancel).not.toHaveBeenCalled();
    const log = await listSelfHealAdminActions({ db, organizationId: orgId });
    expect(log.filter((row) => row.action === "drain")).toHaveLength(2);
  });

  it("records a throwing cancel and resolves", async () => {
    const a = await makeThread(AUDIT_STAMP);
    const { deps, cancel } = makeDeps({
      [a]: [{ externalId: "run-a", status: "RUNNING" }],
    });
    cancel.mockRejectedValueOnce(new Error("Hatchet cancel failed: 500"));
    const result = await drainSelfHeal({
      db,
      organizationId: orgId,
      actorUserId: userId,
      deps,
    });
    expect(result.cancelled).toEqual([]);
    expect(result.cancelFailed).toEqual([a]);
    expect(result.killSwitchSet).toBe(true);
  });
});
