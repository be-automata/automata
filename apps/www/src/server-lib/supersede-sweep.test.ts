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
import { auth } from "@/lib/auth";
import { daemonRunKey, hasActiveDaemonToken } from "@/lib/daemon-token";
import { vi } from "vitest";

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

  it("rule (i): CANCELLED under complete-run-discard ⇒ discarded even with a newer sibling (the recheck), which is linked; the reader gets createdAt + threadId as its lookup hint", async () => {
    const victim = await remoteRun(8, T + 60_000, "r-discarded");
    // The recheck of the discarded head is a NEWER sibling on the same PR —
    // it must not flip the cause to `superseded` (prod 2026-08-25 18:25Z did
    // exactly that), but it IS the run to link to.
    const recheck = await remoteRun(8, 0, "r-recheck");
    await db
      .update(hatchetRunTable)
      .set({ supersedePolicy: "complete-run-discard" })
      .where(eq(hatchetRunTable.externalId, "r-discarded"));
    const hints: Record<string, { createdAt: Date; threadId: string }> = {};
    const report = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus: async (id, hint) => {
        hints[id] = hint;
        return "CANCELLED";
      },
    });
    expect(report.terminals).toEqual([
      { threadId: victim, cause: "discarded" },
    ]);
    const row = await threadRow(victim);
    expect(row.terminalCause).toBe("discarded");
    expect(row.status).toBe("complete");
    expect(row.supersededByThreadId).toBe(recheck);
    expect(hints["r-discarded"]!.createdAt.getTime()).toBeLessThan(
      Date.now() - T,
    );
    expect(hints["r-discarded"]!.threadId).toBe(victim);
  });

  it("rule (i): CANCELLED under complete-run-discard with NO newer sibling ⇒ discarded, nothing linked (recheck off, or the sweep won the race with the recheck dispatch)", async () => {
    const victim = await remoteRun(9, T + 60_000, "r-discarded-alone");
    await db
      .update(hatchetRunTable)
      .set({ supersedePolicy: "complete-run-discard" })
      .where(eq(hatchetRunTable.externalId, "r-discarded-alone"));
    const report = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus: reader({ "r-discarded-alone": "CANCELLED" }),
    });
    expect(report.terminals).toEqual([
      { threadId: victim, cause: "discarded" },
    ]);
    const row = await threadRow(victim);
    expect(row.terminalCause).toBe("discarded");
    expect(row.supersededByThreadId).toBeNull();
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

/**
 * #380 sweep rule (iii) + token revocation on every sweep terminal.
 * Cards:
 *  - (iii) FAILED: protects=a run that died before posting back (any
 *    lane, no run row) is terminalised `run-failed-unreported` after N and
 *    its daemon token revoked so a retry is not skipped; fails_when=the
 *    thread stays booting, the token stays live, or a younger thread is
 *    touched; no_claim=the engine listing (injected).
 *  - (iii) RUNNING / empty: protects=a live or invisible run is left
 *    alone; fails_when=it is terminalised; no_claim=none.
 *  - (iii) row ⇒ rule (i): protects=a thread WITH a run row is never
 *    listed by rule (iii) (rule (i) owns it) and rule (i)'s own FAILED
 *    terminal ALSO revokes the token; fails_when=listRuns is consulted for
 *    a row-bearing thread or the token survives rule (i); no_claim=none.
 */
describe("runSupersedeSweep rule (iii) — failed-unreported runs (#380)", () => {
  let user: User;
  let orgId: string;
  const T = 10 * 60 * 1000;
  const N = 15 * 60 * 1000;

  beforeEach(async () => {
    user = (await createTestUser({ db })).user;
    orgId = await createTestOrg({ db });
  });

  /** A non-review (task) thread dispatched remotely, booting for `ageMs`, with its daemon token minted. */
  async function bootingTaskThread(ageMs: number) {
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        organizationId: orgId,
        sandboxProvider: "hatchet-remote",
        githubRepoFullName: "be-automata/automata",
      },
    });
    const stamp = new Date(Date.now() - ageMs);
    await db
      .update(threadTable)
      .set({ status: "booting", createdAt: stamp, updatedAt: stamp })
      .where(eq(threadTable.id, t.threadId));
    const name = daemonRunKey(t);
    await auth.api.createApiKey({
      body: { name, userId: user.id, metadata: { tokenType: "daemon" } },
    });
    return { ...t, name };
  }
  const threadRow = async (id: string) =>
    (
      await db.query.thread.findMany({ where: (t, { eq: e }) => e(t.id, id) })
    )[0]!;
  const reader = (map: Record<string, AgentRunStatus>) => async (id: string) =>
    map[id] ?? "NOT_FOUND";

  it("every engine run FAILED + older than N ⇒ run-failed-unreported, token revoked; younger / RUNNING / unlisted ⇒ untouched", async () => {
    const dead = await bootingTaskThread(N + 60_000);
    const young = await bootingTaskThread(N - 60_000);
    const live = await bootingTaskThread(N + 60_000);
    const unseen = await bootingTaskThread(N + 60_000);
    const listRuns = vi.fn(async (hint: { threadId: string }) => {
      if (hint.threadId === dead.threadId)
        return [{ externalId: "r-dead", status: "FAILED" as const }];
      if (hint.threadId === live.threadId)
        return [
          { externalId: "r-live-1", status: "FAILED" as const },
          { externalId: "r-live-2", status: "RUNNING" as const },
        ];
      return [];
    });
    const report = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus: reader({}),
      listRuns,
    });
    expect(report.unreported).toEqual([dead.threadId]);
    expect(listRuns.mock.calls.map(([h]) => h.threadId).sort()).toEqual(
      [dead.threadId, live.threadId, unseen.threadId].sort(),
    );
    const deadRow = await threadRow(dead.threadId);
    expect(deadRow.terminalCause).toBe("run-failed-unreported");
    expect(deadRow.status).toBe("complete");
    expect(
      await hasActiveDaemonToken({ userId: user.id, name: dead.name }),
    ).toBe(false);
    for (const t of [young, live, unseen]) {
      expect((await threadRow(t.threadId)).status).toBe("booting");
      expect(
        await hasActiveDaemonToken({ userId: user.id, name: t.name }),
      ).toBe(true);
    }
    // Idempotent: a second tick finds nothing new.
    const again = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus: reader({}),
      listRuns,
    });
    expect(again.unreported).toEqual([]);
  });

  it("rule (i): a review run FAILED while its thread is still booting (unsealable payload) ⇒ run-failed-unreported; FAILED after the daemon was up stays daemon-failed", async () => {
    const booting = await createTestRemoteRun({
      db,
      userId: user.id,
      organizationId: orgId,
      prNumber: 41,
      externalId: "r-boot-failed",
      ageMs: T + 60_000,
      repoFullName: "be-automata/automata",
      status: "booting",
    });
    const working = await createTestRemoteRun({
      db,
      userId: user.id,
      organizationId: orgId,
      prNumber: 42,
      externalId: "r-work-failed",
      ageMs: T + 60_000,
      repoFullName: "be-automata/automata",
    });
    const report = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus: reader({
        "r-boot-failed": "FAILED",
        "r-work-failed": "FAILED",
      }),
      listRuns: async () => [],
    });
    expect(report.terminals).toEqual(
      expect.arrayContaining([
        { threadId: booting.threadId, cause: "run-failed-unreported" },
        { threadId: working.threadId, cause: "daemon-failed" },
      ]),
    );
    expect((await threadRow(booting.threadId)).terminalCause).toBe(
      "run-failed-unreported",
    );
    expect((await threadRow(working.threadId)).terminalCause).toBe(
      "daemon-failed",
    );
  });

  it("rule (i) generation guard: a FAILED row whose thread was RESUMED later (booting again, written well after the dispatch) is retired as stale — no terminal, token kept", async () => {
    const resumed = await createTestRemoteRun({
      db,
      userId: user.id,
      organizationId: orgId,
      prNumber: 43,
      externalId: "r-stale-attempt",
      ageMs: T + 60_000,
      repoFullName: "be-automata/automata",
      status: "booting",
    });
    // The resume: a later write on the thread (minutes after the row).
    await db
      .update(threadTable)
      .set({ updatedAt: new Date() })
      .where(eq(threadTable.id, resumed.threadId));
    const name = daemonRunKey(resumed);
    await auth.api.createApiKey({
      body: { name, userId: user.id, metadata: { tokenType: "daemon" } },
    });
    const report = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus: reader({ "r-stale-attempt": "FAILED" }),
      listRuns: async () => [],
    });
    expect(report.terminals).toEqual([]);
    expect((await threadRow(resumed.threadId)).status).toBe("booting");
    expect(await hasActiveDaemonToken({ userId: user.id, name })).toBe(true);
    const [row] = await db
      .select({ status: hatchetRunTable.status })
      .from(hatchetRunTable)
      .where(eq(hatchetRunTable.externalId, "r-stale-attempt"));
    expect(row?.status).toBe("terminal");
  });

  it("a thread WITH a run row is rule (i)'s: never listed by rule (iii), and rule (i)'s FAILED terminal revokes its daemon token too", async () => {
    const { threadId, threadChatId } = await createTestRemoteRun({
      db,
      userId: user.id,
      organizationId: orgId,
      prNumber: 31,
      externalId: "r-row-failed",
      ageMs: T + 60_000,
      repoFullName: "be-automata/automata",
    });
    const name = daemonRunKey({ threadId, threadChatId });
    await auth.api.createApiKey({
      body: { name, userId: user.id, metadata: { tokenType: "daemon" } },
    });
    const listRuns = vi.fn(async (_hint: { threadId: string }) => []);
    const report = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus: reader({ "r-row-failed": "FAILED" }),
      listRuns,
    });
    expect(report.terminals).toEqual([{ threadId, cause: "daemon-failed" }]);
    expect(report.unreported).toEqual([]);
    expect(listRuns.mock.calls.map(([h]) => h.threadId)).not.toContain(
      threadId,
    );
    expect(await hasActiveDaemonToken({ userId: user.id, name })).toBe(false);
  });

  it("a thread whose only run row is RETIRED (a re-run of a thread that once had a review) is rule (iii)'s again", async () => {
    const { retireHatchetRun } = await import(
      "@terragon/shared/model/hatchet-run"
    );
    const old = await createTestRemoteRun({
      db,
      userId: user.id,
      organizationId: orgId,
      prNumber: 51,
      externalId: "r-retired",
      ageMs: N + 120_000,
      repoFullName: "be-automata/automata",
      status: "booting",
    });
    await retireHatchetRun({
      db,
      key: { externalId: "r-retired" },
      as: "terminal",
    });
    const stamp = new Date(Date.now() - N - 60_000);
    await db
      .update(threadTable)
      .set({ updatedAt: stamp })
      .where(eq(threadTable.id, old.threadId));
    const name = daemonRunKey(old);
    await auth.api.createApiKey({
      body: { name, userId: user.id, metadata: { tokenType: "daemon" } },
    });
    const report = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus: reader({}),
      listRuns: async (hint) =>
        hint.threadId === old.threadId
          ? [{ externalId: "r-rerun", status: "FAILED" as const }]
          : [],
    });
    expect(report.unreported).toContain(old.threadId);
    expect((await threadRow(old.threadId)).terminalCause).toBe(
      "run-failed-unreported",
    );
    expect(await hasActiveDaemonToken({ userId: user.id, name })).toBe(false);
  });

  it("a listing failure leaves the thread for the next tick (no terminal, token kept)", async () => {
    const t = await bootingTaskThread(N + 60_000);
    const report = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: N,
      readStatus: reader({}),
      listRuns: async () => {
        throw new Error("engine 503");
      },
    });
    expect(report.unreported).toEqual([]);
    expect((await threadRow(t.threadId)).status).toBe("booting");
    expect(await hasActiveDaemonToken({ userId: user.id, name: t.name })).toBe(
      true,
    );
  });
});
