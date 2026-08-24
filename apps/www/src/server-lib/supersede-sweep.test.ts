import { describe, it, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { recordHatchetRun } from "@terragon/shared/model/hatchet-run";
import {
  thread as threadTable,
  hatchetRun as hatchetRunTable,
} from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import { runSupersedeSweep } from "./supersede-sweep";
import type { AgentRunStatus } from "@/agent/hatchet/transport";

/**
 * #125 C4 sweep rules against the real DB with an injected engine status
 * reader (the engine round-trip itself is covered by transport.test.ts).
 */
describe("runSupersedeSweep (#125 C4)", () => {
  let user: User;
  let orgId: string;
  const T = 10 * 60 * 1000;
  const N = 15 * 60 * 1000;

  beforeEach(async () => {
    user = (await createTestUser({ db })).user;
    const org = await createOrganization({
      db,
      name: "Org",
      slug: `org-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
  });

  async function remoteRun(
    prNumber: number,
    ageMs: number,
    externalId: string,
  ) {
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId, sandboxProvider: "hatchet-remote" },
    });
    await db
      .update(threadTable)
      .set({ status: "working" })
      .where(eq(threadTable.id, t.threadId));
    const run = await recordHatchetRun({
      db,
      threadId: t.threadId,
      organizationId: orgId,
      repoFullName: "be-automata/automata",
      prNumber,
      externalId,
    });
    await db
      .update(hatchetRunTable)
      .set({ createdAt: new Date(Date.now() - ageMs) })
      .where(eq(hatchetRunTable.id, run.id));
    return t.threadId;
  }

  const threadRow = async (id: string) =>
    (
      await db.query.thread.findMany({ where: (t, { eq: e }) => e(t.id, id) })
    )[0]!;

  const reader = (map: Record<string, AgentRunStatus>) => async (id: string) =>
    map[id] ?? "NOT_FOUND";

  it("rule (i): CANCELLED with a newer sibling ⇒ superseded; without ⇒ user-cancelled; FAILED ⇒ daemon-failed; live/done ⇒ untouched", async () => {
    const superseded = await remoteRun(1, T + 60_000, "r-old");
    await remoteRun(1, 0, "r-newer"); // newer sibling, same PR
    const userCancelled = await remoteRun(2, T + 60_000, "r-alone");
    const failed = await remoteRun(3, T + 60_000, "r-failed");
    const running = await remoteRun(4, T + 60_000, "r-running");
    const done = await remoteRun(5, T + 60_000, "r-done");

    const report = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus: reader({
        "r-old": "CANCELLED",
        "r-alone": "NOT_FOUND",
        "r-failed": "FAILED",
        "r-running": "RUNNING",
        "r-done": "COMPLETED",
      }),
    });
    expect(report.terminals).toEqual(
      expect.arrayContaining([
        { threadId: superseded, cause: "superseded" },
        { threadId: userCancelled, cause: "user-cancelled" },
        { threadId: failed, cause: "daemon-failed" },
      ]),
    );
    expect((await threadRow(superseded)).terminalCause).toBe("superseded");
    expect((await threadRow(userCancelled)).terminalCause).toBe(
      "user-cancelled",
    );
    expect((await threadRow(failed)).terminalCause).toBe("daemon-failed");
    expect((await threadRow(running)).status).toBe("working");
    expect((await threadRow(done)).status).toBe("working");
  });

  it("rule (i) waits T: a fresh in_flight run is not examined", async () => {
    await remoteRun(6, 60_000, "r-fresh");
    const report = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus: reader({ "r-fresh": "CANCELLED" }),
    });
    expect(report.examined).toBe(0);
  });

  it("lease: two concurrent ticks read the engine ONCE and write ONE terminal", async () => {
    const threadId = await remoteRun(7, T + 60_000, "r-race");
    let reads = 0;
    const readStatus = async (): Promise<AgentRunStatus> => {
      reads++;
      await new Promise((r) => setTimeout(r, 50));
      return "CANCELLED";
    };
    const [a, b] = await Promise.all([
      runSupersedeSweep({ cancelledAfterMs: T, orphanAfterMs: N, readStatus }),
      runSupersedeSweep({ cancelledAfterMs: T, orphanAfterMs: N, readStatus }),
    ]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(reads).toBe(1);
    expect(a.terminals.length + b.terminals.length).toBe(1);
    expect((await threadRow(threadId)).terminalCause).toBe("user-cancelled");
    // A later tick re-examines nothing: the row is swept and the thread terminal.
    const again = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus,
    });
    expect(again.examined).toBe(0);
    expect(reads).toBe(1);
  });

  it("rule (ii): a dispatched remote thread with no recorded run ⇒ plane-offline after N, not before", async () => {
    const orphan = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId, sandboxProvider: "hatchet-remote" },
    });
    await db
      .update(threadTable)
      .set({ status: "booting", createdAt: new Date(Date.now() - N + 60_000) })
      .where(eq(threadTable.id, orphan.threadId));
    let report = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus: reader({}),
    });
    expect(report.orphans).not.toContain(orphan.threadId);
    await db
      .update(threadTable)
      .set({ createdAt: new Date(Date.now() - N - 60_000) })
      .where(eq(threadTable.id, orphan.threadId));
    report = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus: reader({}),
    });
    expect(report.orphans).toContain(orphan.threadId);
    expect((await threadRow(orphan.threadId)).terminalCause).toBe(
      "plane-offline",
    );
  });
});
