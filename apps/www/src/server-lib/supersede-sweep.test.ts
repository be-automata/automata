import { describe, it, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
  createTestOrg,
  createTestRemoteRun,
  createTestAutomation,
} from "@terragon/shared/model/test-helpers";
import {
  thread as threadTable,
  hatchetRun as hatchetRunTable,
} from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
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
    orgId = await createTestOrg({ db });
  });

  const remoteRun = async (
    prNumber: number,
    ageMs: number,
    externalId: string,
  ) =>
    (
      await createTestRemoteRun({
        db,
        userId: user.id,
        organizationId: orgId,
        prNumber,
        externalId,
        ageMs,
        repoFullName: "be-automata/automata",
      })
    ).threadId;

  const threadRow = async (id: string) =>
    (
      await db.query.thread.findMany({ where: (t, { eq: e }) => e(t.id, id) })
    )[0]!;

  const reader = (map: Record<string, AgentRunStatus>) => async (id: string) =>
    map[id] ?? "NOT_FOUND";

  it("rule (i): CANCELLED ⇒ superseded (with sibling, linked) / user-cancelled; NOT_FOUND ⇒ superseded / plane-offline; FAILED ⇒ daemon-failed; live ⇒ untouched + lease extended; COMPLETED ⇒ run retired, thread untouched", async () => {
    const superseded = await remoteRun(1, T + 60_000, "r-old");
    const newer = await remoteRun(1, 0, "r-newer"); // newer sibling, same PR
    const userCancelled = await remoteRun(2, T + 60_000, "r-alone");
    const vanished = await remoteRun(6, T + 60_000, "r-vanished");
    const failed = await remoteRun(3, T + 60_000, "r-failed");
    const running = await remoteRun(4, T + 60_000, "r-running");
    const done = await remoteRun(5, T + 60_000, "r-done");

    const report = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus: reader({
        "r-old": "CANCELLED",
        "r-alone": "CANCELLED",
        "r-vanished": "NOT_FOUND",
        "r-failed": "FAILED",
        "r-running": "RUNNING",
        "r-done": "COMPLETED",
      }),
    });
    expect(report.terminals).toEqual(
      expect.arrayContaining([
        { threadId: superseded, cause: "superseded" },
        { threadId: userCancelled, cause: "user-cancelled" },
        { threadId: vanished, cause: "plane-offline" },
        { threadId: failed, cause: "daemon-failed" },
      ]),
    );
    // The superseded thread is LINKED to the newer sibling (persisted, not
    // just computed): the chip's "superseded by" deep link reads this column.
    expect((await threadRow(superseded)).supersededByThreadId).toBe(newer);
    expect((await threadRow(superseded)).terminalCause).toBe("superseded");
    const sup = await threadRow(superseded);
    expect(sup.terminalCause).toBe("superseded");
    expect(sup.errorMessage).toBe("superseded");
    const uc = await threadRow(userCancelled);
    expect(uc.terminalCause).toBe("user-cancelled");
    expect(uc.errorMessage).toBeNull();
    expect((await threadRow(vanished)).terminalCause).toBe("plane-offline");
    expect((await threadRow(failed)).terminalCause).toBe("daemon-failed");
    expect((await threadRow(running)).status).toBe("working");
    expect((await threadRow(done)).status).toBe("working");
    const runRows = await db
      .select({
        externalId: hatchetRunTable.externalId,
        status: hatchetRunTable.status,
        lease: hatchetRunTable.sweepLeaseUntil,
      })
      .from(hatchetRunTable);
    const byId = Object.fromEntries(runRows.map((r) => [r.externalId, r]));
    expect(byId["r-done"]!.status).toBe("terminal");
    expect(byId["r-old"]!.status).toBe("superseded");
    expect(byId["r-failed"]!.status).toBe("terminal");
    // Live: lease pushed out well past the default 5 min.
    expect(byId["r-running"]!.lease!.getTime()).toBeGreaterThan(
      Date.now() + 10 * 60 * 1000,
    );
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
    // A later tick re-examines nothing: the row is retired and the thread terminal.
    const again = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus,
    });
    expect(again.examined).toBe(0);
    expect(reads).toBe(1);
  });

  it("an engine read failure releases the lease so the next tick retries at once", async () => {
    const threadId = await remoteRun(8, T + 60_000, "r-flaky");
    let calls = 0;
    const readStatus = async (): Promise<AgentRunStatus> => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return "CANCELLED";
    };
    await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus,
    });
    expect((await threadRow(threadId)).status).toBe("working");
    const again = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus,
    });
    expect(again.terminals).toEqual([{ threadId, cause: "user-cancelled" }]);
  });

  it("rule (ii): a dispatched REVIEW thread stuck in booting with no recorded run ⇒ plane-offline after N, not before", async () => {
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: {
        organizationId: orgId,
        triggerType: "pull_request",
        repoFullName: "be-automata/automata",
        triggerConfig: { on: { open: true, update: true }, filter: {} },
      },
    });
    const orphan = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        organizationId: orgId,
        sandboxProvider: "hatchet-remote",
        githubRepoFullName: "be-automata/automata",
        githubPRNumber: 5,
        automationId: automation.id,
      },
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
