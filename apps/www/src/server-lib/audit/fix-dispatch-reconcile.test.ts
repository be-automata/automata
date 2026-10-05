import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import {
  auditFindings,
  selfHealBreakerEvent,
  thread,
  threadChat,
} from "@terragon/shared/db/schema";
import { insertFinding } from "@terragon/shared/model/audit-findings";
import {
  bindFixAttemptThread,
  claimFixAttempt,
  getFixAttemptById,
} from "@terragon/shared/model/audit-fix-attempts";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import type { AgentRunStatus } from "@/agent/hatchet/transport";

import {
  runFixDispatchReconcile,
  type FixReconcileDeps,
} from "./fix-dispatch-reconcile";

vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/**
 * Ancient instants, one day EARLIER per test: the selectors are cross-org, so
 * rows other files create at wall-clock time (and rows an earlier test here
 * left behind, which sit later) stay outside every window this test reads.
 */
const BASE = Date.UTC(1992, 0, 1);
let day = 0;

describe("runFixDispatchReconcile (RECON-01)", () => {
  let organizationId: string;
  let userId: string;
  let at: (minutes: number) => Date;
  let runs: Map<string, Array<{ externalId: string; status: AgentRunStatus }>>;
  let failing: Set<string>;
  let stopped: Array<{ threadId: string; cause: string }>;
  let logs: string[];
  let listRuns: ReturnType<typeof vi.fn>;

  function deps(): FixReconcileDeps {
    return {
      listRuns: listRuns as unknown as FixReconcileDeps["listRuns"],
      stopThread: async ({ threadId, cause }) => {
        stopped.push({ threadId, cause });
      },
      log: (message) => {
        logs.push(message);
      },
    };
  }

  function reconcile(
    nowMin: number,
    extra: Partial<Parameters<typeof runFixDispatchReconcile>[0]> = {},
  ) {
    return runFixDispatchReconcile({
      db,
      now: at(nowMin),
      deadlineAt: new Date(Date.now() + 60_000),
      deps: deps(),
      ...extra,
    });
  }

  async function seedAttempt({
    threadValues,
    bind = true,
  }: {
    threadValues?: Partial<typeof thread.$inferInsert>;
    bind?: boolean;
  } = {}) {
    const finding = await insertFinding({
      db,
      organizationId,
      finding: {
        repoFullName: "acme/widgets",
        fingerprint: randomBytes(8).toString("hex"),
        audit: "security-audit",
        ruleId: "supply.lockfile-missing",
        severity: "high",
        checkKind: "script",
        title: "Lockfile missing",
        status: "open",
        issueNumber: Math.floor(Math.random() * 100_000) + 1,
        fixReadyAt: at(-60),
        autoFixLabeled: true,
      },
    });
    const claimed = await claimFixAttempt({
      db,
      organizationId,
      findingId: finding.id,
      maxAttempts: 3,
      cooldownMin: 30,
      branchFor: (n) => `automata/fix-1-abc-${n}`,
      now: at(0),
    });
    if (!claimed) throw new Error("claim failed");
    const attemptId = claimed.attempt.id;
    if (!bind) return { findingId: finding.id, attemptId, threadId: "" };
    const { threadId } = await createTestThread({ db, userId });
    await bindFixAttemptThread({
      db,
      organizationId,
      attemptId,
      threadId,
      now: at(0),
    });
    if (threadValues) {
      await db.update(thread).set(threadValues).where(eq(thread.id, threadId));
    }
    // Age every write so the terminal grace measures from at(0).
    await db
      .update(thread)
      .set({ updatedAt: at(0) })
      .where(eq(thread.id, threadId));
    await db
      .update(threadChat)
      .set({ updatedAt: at(0) })
      .where(eq(threadChat.threadId, threadId));
    return { findingId: finding.id, attemptId, threadId };
  }

  async function attempt(id: string) {
    const row = await getFixAttemptById({ db, organizationId, id });
    if (!row) throw new Error("attempt vanished");
    return row;
  }

  async function findingAttempts(id: string) {
    const [row] = await db
      .select({ attempts: auditFindings.attempts })
      .from(auditFindings)
      .where(eq(auditFindings.id, id));
    return row?.attempts;
  }

  async function events(scopeKind: "exec_plane" | "hatchet_dispatch") {
    return db
      .select({
        outcome: selfHealBreakerEvent.outcome,
        signal: selfHealBreakerEvent.signal,
        scopeKey: selfHealBreakerEvent.scopeKey,
      })
      .from(selfHealBreakerEvent)
      .where(
        and(
          eq(selfHealBreakerEvent.organizationId, organizationId),
          eq(selfHealBreakerEvent.scopeKind, scopeKind),
        ),
      );
  }

  beforeEach(async () => {
    day++;
    const base = BASE - day * DAY;
    at = (minutes) => new Date(base + minutes * MIN);
    organizationId = await createTestOrg({ db });
    userId = (await createTestUser({ db })).user.id;
    runs = new Map();
    failing = new Set();
    stopped = [];
    logs = [];
    listRuns = vi.fn(async ({ threadId }: { threadId: string }) => {
      if (failing.has(threadId)) throw new Error("hatchet 502");
      const listed = runs.get(threadId);
      // Unknown threads (another test's leftovers) fail closed: no change.
      if (!listed) throw new Error("unexpected thread");
      return listed;
    });
  });

  it("RES-09: no run for a booting thread past its lease → dispatch_lost, refunded, thread stopped, one hatchet_dispatch failure", async () => {
    const s = await seedAttempt({ threadValues: { status: "booting" } });
    runs.set(s.threadId, []);
    expect(await findingAttempts(s.findingId)).toBe(1);

    const result = await reconcile(11);

    expect(result.lost).toBe(1);
    const a = await attempt(s.attemptId);
    expect(a.phase).toBe("closed");
    expect(a.infraRefunded).toBe(true);
    expect(a.terminalCause).toBe("dispatch_lost");
    expect(await findingAttempts(s.findingId)).toBe(0);
    expect(stopped).toEqual([{ threadId: s.threadId, cause: "plane-offline" }]);
    expect(await events("hatchet_dispatch")).toEqual([
      { outcome: "failure", signal: "dispatch_lost", scopeKey: "*" },
    ]);

    // Idempotent: a second tick changes nothing and records nothing.
    await reconcile(12);
    expect(await events("hatchet_dispatch")).toHaveLength(1);
  });

  it("a RUNNING run extends the lease by 10 minutes and records a success", async () => {
    const s = await seedAttempt({ threadValues: { status: "booting" } });
    runs.set(s.threadId, [{ externalId: "r1", status: "RUNNING" }]);

    const result = await reconcile(11);

    expect(result.extended).toBe(1);
    const a = await attempt(s.attemptId);
    expect(a.phase).toBe("dispatched");
    expect(a.dispatchLeaseUntil?.getTime()).toBe(at(21).getTime());
    expect(await findingAttempts(s.findingId)).toBe(1);
    expect(stopped).toEqual([]);
    expect(await events("hatchet_dispatch")).toEqual([
      { outcome: "success", signal: "dispatch_visible", scopeKey: "*" },
    ]);
  });

  it("a failed Hatchet lookup changes nothing and is logged", async () => {
    const s = await seedAttempt({ threadValues: { status: "queued" } });
    failing.add(s.threadId);

    const result = await reconcile(11);

    expect(result.lookupFailed).toBe(1);
    const a = await attempt(s.attemptId);
    expect(a.phase).toBe("dispatched");
    expect(a.dispatchLeaseUntil?.getTime()).toBe(at(10).getTime());
    expect(await findingAttempts(s.findingId)).toBe(1);
    expect(stopped).toEqual([]);
    expect(await events("hatchet_dispatch")).toEqual([]);
    expect(logs).toContain(
      "[self-heal-reconcile] hatchet lookup failed; unchanged",
    );
  });

  it("ended runs for a thread that never booted: refunded, stopped, exec_plane failure", async () => {
    const s = await seedAttempt({ threadValues: { status: "booting" } });
    runs.set(s.threadId, [{ externalId: "r1", status: "FAILED" }]);

    const result = await reconcile(11);

    expect(result.refunded).toBe(1);
    expect((await attempt(s.attemptId)).infraRefunded).toBe(true);
    expect(stopped).toEqual([{ threadId: s.threadId, cause: "daemon-failed" }]);
    expect(await events("exec_plane")).toEqual([
      { outcome: "failure", signal: "daemon_failed", scopeKey: "*" },
    ]);
  });

  it("a thread past boot only has its lease extended (no lookup)", async () => {
    const s = await seedAttempt({ threadValues: { status: "working" } });
    const result = await reconcile(11);
    expect(result.extended).toBe(1);
    expect(listRuns).not.toHaveBeenCalled();
    expect((await attempt(s.attemptId)).dispatchLeaseUntil?.getTime()).toBe(
      at(21).getTime(),
    );
  });

  it("a thread parked on the agent rate limit is a quota failure: counted, stopped, no plane signal", async () => {
    const s = await seedAttempt({
      threadValues: { status: "queued-agent-rate-limit" },
    });
    const result = await reconcile(11);
    expect(result.counted).toBe(1);
    const a = await attempt(s.attemptId);
    expect(a.infraRefunded).toBe(false);
    expect(a.terminalCause).toBe("credential");
    expect(await findingAttempts(s.findingId)).toBe(1);
    expect(stopped.map((x) => x.threadId)).toEqual([s.threadId]);
    expect(await events("exec_plane")).toEqual([]);
  });

  it("RES-10: daemon-failed with no report after 10 min → refunded + exec_plane failure", async () => {
    const s = await seedAttempt({
      threadValues: { status: "complete", terminalCause: "daemon-failed" },
    });

    // Inside the grace: untouched.
    await reconcile(5);
    expect((await attempt(s.attemptId)).phase).toBe("dispatched");

    const result = await reconcile(11);
    expect(result.refunded).toBe(1);
    const a = await attempt(s.attemptId);
    expect(a.phase).toBe("closed");
    expect(a.infraRefunded).toBe(true);
    expect(a.outcome).toBe("refunded");
    expect(a.terminalCause).toBe("daemon_failed");
    expect(await findingAttempts(s.findingId)).toBe(0);
    expect(await events("exec_plane")).toEqual([
      { outcome: "failure", signal: "daemon_failed", scopeKey: "*" },
    ]);
  });

  it("credential quota → counted (closeFixAttempt counted), never an exec_plane event", async () => {
    const s = await seedAttempt({
      threadValues: {
        status: "complete",
        terminalCause: "daemon-failed",
        errorMessage: "Weekly limit reached · resets 6pm (UTC)",
      },
    });
    const result = await reconcile(11);
    expect(result.counted).toBe(1);
    const a = await attempt(s.attemptId);
    expect(a.phase).toBe("closed");
    expect(a.infraRefunded).toBe(false);
    expect(a.outcome).toBe("run_failed");
    expect(a.terminalCause).toBe("credential");
    expect(await findingAttempts(s.findingId)).toBe(1);
    expect(await events("exec_plane")).toEqual([]);
  });

  it("KILL-01: a drained (cancelled) run is refunded with outcome killed", async () => {
    const s = await seedAttempt({
      threadValues: { status: "complete", terminalCause: "user-cancelled" },
    });
    const result = await reconcile(11);
    expect(result.killed).toBe(1);
    const a = await attempt(s.attemptId);
    expect(a.outcome).toBe("killed");
    expect(a.infraRefunded).toBe(true);
    expect(await findingAttempts(s.findingId)).toBe(0);
    expect(await events("exec_plane")).toEqual([]);
  });

  it("LEASE-01: an expired claim that never bound a thread is refunded", async () => {
    const s = await seedAttempt({ bind: false });
    await reconcile(9);
    expect((await attempt(s.attemptId)).phase).toBe("claimed");
    const result = await reconcile(11);
    expect(result.refunded).toBe(1);
    const a = await attempt(s.attemptId);
    expect(a.infraRefunded).toBe(true);
    expect(a.terminalCause).toBe("claim_expired");
    expect(await findingAttempts(s.findingId)).toBe(0);
  });

  it("handles at most LIMIT rows per tick", async () => {
    const seeded = await Promise.all(
      [0, 1, 2].map(() => seedAttempt({ threadValues: { status: "booting" } })),
    );
    for (const s of seeded) runs.set(s.threadId, []);
    const result = await reconcile(11, { limit: 2 });
    expect(result.lost).toBe(2);
    expect(listRuns).toHaveBeenCalledTimes(2);
  });

  it("does nothing once the tick's deadline has passed", async () => {
    const s = await seedAttempt({ threadValues: { status: "booting" } });
    runs.set(s.threadId, []);
    const result = await reconcile(11, {
      deadlineAt: new Date(Date.now() - 1),
    });
    expect(result).toEqual({
      lost: 0,
      extended: 0,
      refunded: 0,
      counted: 0,
      killed: 0,
      lookupFailed: 0,
    });
    expect((await attempt(s.attemptId)).phase).toBe("dispatched");
  });
});
