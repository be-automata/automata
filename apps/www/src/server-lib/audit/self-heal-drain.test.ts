import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  thread as threadTable,
  threadChat as threadChatTable,
} from "@terragon/shared/db/schema";
import {
  claimAuditRun,
  createAuditRunAtDispatch,
  finishAuditRun,
  getAuditRunByThread,
} from "@terragon/shared/model/audit-findings";
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

  describe("terminal write after a successful cancel", () => {
    const REPO = "acme/widgets";

    async function makeAuditThread(chatMode = false): Promise<string> {
      const threadId = chatMode
        ? (
            await createTestThread({
              db,
              userId,
              enableThreadChatCreation: true,
            })
          ).threadId
        : await makeThread(AUDIT_STAMP);
      if (chatMode) {
        await db
          .update(threadTable)
          .set({
            organizationId: orgId,
            sourceMetadata: AUDIT_STAMP,
            version: 1,
            status: "working",
          })
          .where(eq(threadTable.id, threadId));
      }
      await db
        .update(threadChatTable)
        .set({ status: "working" })
        .where(eq(threadChatTable.threadId, threadId));
      await createAuditRunAtDispatch({
        db,
        organizationId: orgId,
        repoFullName: REPO,
        threadId,
        audit: "security-audit",
      });
      return threadId;
    }

    async function threadState(threadId: string) {
      const [t] = await db
        .select({
          status: threadTable.status,
          terminalCause: threadTable.terminalCause,
        })
        .from(threadTable)
        .where(eq(threadTable.id, threadId));
      const chats = await db
        .select({
          status: threadChatTable.status,
          terminalCause: threadChatTable.terminalCause,
        })
        .from(threadChatTable)
        .where(eq(threadChatTable.threadId, threadId));
      return { thread: t, chats };
    }

    function drain(deps: DrainDeps) {
      return drainSelfHeal({
        db,
        organizationId: orgId,
        actorUserId: userId,
        deps,
      });
    }

    it("marks the thread terminal on both tables and finishes the audit run done/killed", async () => {
      const a = await makeAuditThread(true);
      const { deps } = makeDeps({
        [a]: [{ externalId: "run-a", status: "RUNNING" }],
      });
      const result = await drain(deps);
      expect(result.cancelled).toEqual([a]);

      const state = await threadState(a);
      expect(state.thread?.status).toBe("complete");
      expect(state.thread?.terminalCause).toBe("user-cancelled");
      expect(state.chats.length).toBeGreaterThan(0);
      for (const chat of state.chats) {
        expect(chat.status).toBe("complete");
        expect(chat.terminalCause).toBe("user-cancelled");
      }
      const run = await getAuditRunByThread({
        db,
        organizationId: orgId,
        threadId: a,
      });
      expect(run?.status).toBe("done");
      expect(run?.outcome).toBe("killed");
      expect(run?.finishedAt).not.toBeNull();
    });

    it("leaves an audit run that is already done unchanged", async () => {
      const a = await makeAuditThread();
      const claimed = await claimAuditRun({
        db,
        organizationId: orgId,
        repoFullName: REPO,
        threadId: a,
        audit: "security-audit",
      });
      await finishAuditRun({
        db,
        organizationId: orgId,
        id: claimed?.id ?? "",
        status: "done",
        outcome: "published",
        now: new Date("2026-10-04T10:00:00.000Z"),
      });
      const { deps } = makeDeps({
        [a]: [{ externalId: "run-a", status: "RUNNING" }],
      });
      await drain(deps);
      const run = await getAuditRunByThread({
        db,
        organizationId: orgId,
        threadId: a,
      });
      expect(run?.status).toBe("done");
      expect(run?.outcome).toBe("published");
      expect(run?.finishedAt?.toISOString()).toBe("2026-10-04T10:00:00.000Z");
    });

    it("leaves thread and audit run untouched when the cancel fails", async () => {
      const a = await makeAuditThread();
      const { deps, cancel } = makeDeps({
        [a]: [{ externalId: "run-a", status: "RUNNING" }],
      });
      cancel.mockRejectedValueOnce(new Error("Hatchet cancel failed: 500"));
      const result = await drain(deps);
      expect(result.cancelFailed).toEqual([a]);
      const state = await threadState(a);
      expect(state.thread?.status).toBe("working");
      expect(state.chats.every((c) => c.status === "working")).toBe(true);
      const run = await getAuditRunByThread({
        db,
        organizationId: orgId,
        threadId: a,
      });
      expect(run?.status).toBe("dispatched");
      expect(run?.outcome).toBeNull();
    });

    it("leaves thread and audit run untouched when the lookup fails", async () => {
      const a = await makeAuditThread();
      const { deps } = makeDeps({ [a]: new Error("502") });
      const result = await drain(deps);
      expect(result.lookupFailed).toEqual([a]);
      expect((await threadState(a)).thread?.status).toBe("working");
      const run = await getAuditRunByThread({
        db,
        organizationId: orgId,
        threadId: a,
      });
      expect(run?.status).toBe("dispatched");
    });

    it("is idempotent: a second Drain changes nothing and does not throw", async () => {
      const a = await makeAuditThread();
      const { deps } = makeDeps({
        [a]: [{ externalId: "run-a", status: "RUNNING" }],
      });
      await drain(deps);
      const before = await getAuditRunByThread({
        db,
        organizationId: orgId,
        threadId: a,
      });
      const second = await drain(deps);
      expect(second.nothingInFlight).toBe(true);
      const after = await getAuditRunByThread({
        db,
        organizationId: orgId,
        threadId: a,
      });
      expect(after?.status).toBe("done");
      expect(after?.outcome).toBe("killed");
      expect(after?.finishedAt?.toISOString()).toBe(
        before?.finishedAt?.toISOString(),
      );
      expect((await threadState(a)).thread?.status).toBe("complete");
    });
  });
});
