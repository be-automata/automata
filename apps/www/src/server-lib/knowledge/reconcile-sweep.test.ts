import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import {
  runKnowledgeReconcileSweep,
  type KnowledgeReconcileSweepDeps,
} from "./reconcile-sweep";

const ROW = (id: string) => ({
  id,
  organizationId: "org1",
  repoFullName: "acme/r",
  targetSha: "abc",
});

function makeDeps(
  overrides: Partial<KnowledgeReconcileSweepDeps> = {},
): KnowledgeReconcileSweepDeps {
  return {
    secret: () => "s3cret",
    requeueExpired: vi.fn(async () => []),
    claimDue: vi.fn(async () => []),
    fail: vi.fn(async () => ({
      result: "recorded" as const,
      state: "pending" as const,
      attempts: 1,
      code: "dispatch_failed" as const,
      becameFailed: false,
      organizationId: "org1",
      repoFullName: "acme/r",
    })),
    trigger: vi.fn(async () => undefined),
    alert: vi.fn(async () => undefined),
    listHeadCandidates: vi.fn(async () => []),
    readHead: vi.fn(async () => ({ kind: "error" as const })),
    recoverHead: vi.fn(async () => ({ outcome: "in_sync" as const })),
    log: { log: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe("runKnowledgeReconcileSweep", () => {
  it("does nothing with an empty secret", async () => {
    const deps = makeDeps({ secret: () => "" });
    const r = await runKnowledgeReconcileSweep(deps);
    expect(r.disabled).toBe(true);
    expect(deps.requeueExpired).not.toHaveBeenCalled();
    expect(deps.claimDue).not.toHaveBeenCalled();
    expect(deps.trigger).not.toHaveBeenCalled();
  });

  it("logs and alerts once for a requeued row that became failed", async () => {
    const deps = makeDeps({
      requeueExpired: vi.fn(async () => [
        {
          id: "i1",
          organizationId: "org1",
          repoFullName: "acme/r",
          attempts: 8,
          code: "max_attempts" as const,
          state: "failed" as const,
          becameFailed: true,
        },
        {
          id: "i2",
          organizationId: "org1",
          repoFullName: "acme/r",
          attempts: 2,
          code: "lease_expired" as const,
          state: "pending" as const,
          becameFailed: false,
        },
      ]),
    });
    const r = await runKnowledgeReconcileSweep(deps);
    expect(r.requeued).toBe(2);
    expect(r.failed).toBe(1);
    expect(deps.alert).toHaveBeenCalledTimes(1);
    expect(deps.alert).toHaveBeenCalledWith({
      organizationId: "org1",
      repoFullName: "acme/r",
      code: "max_attempts",
      attempts: 8,
    });
    expect(deps.log.error).toHaveBeenCalledWith(
      "[cron:knowledge-reconcile] intent failed",
      {
        intentId: "i1",
        organizationId: "org1",
        code: "max_attempts",
        attempts: 8,
      },
    );
  });

  it("dispatches every claimed row", async () => {
    const deps = makeDeps({
      claimDue: vi.fn(async () => [ROW("a"), ROW("b")]),
    });
    const r = await runKnowledgeReconcileSweep(deps);
    expect(r.dispatched).toBe(2);
    expect(vi.mocked(deps.trigger).mock.calls.map((c) => c[0].id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("records dispatch_failed, alerts when exhausted and still dispatches the next row", async () => {
    const trigger = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const deps = makeDeps({
      claimDue: vi.fn(async () => [ROW("a"), ROW("b")]),
      trigger,
      fail: vi.fn(async () => ({
        result: "recorded" as const,
        state: "failed" as const,
        attempts: 8,
        code: "dispatch_failed" as const,
        becameFailed: true,
        organizationId: "org1",
        repoFullName: "acme/r",
      })),
    });
    const r = await runKnowledgeReconcileSweep(deps);
    expect(deps.fail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.fail).mock.calls[0]![0]).toBe("a");
    expect(vi.mocked(deps.fail).mock.calls[0]![1]).toBe("dispatch_failed");
    expect(deps.alert).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ dispatched: 1, dispatchFailed: 1, failed: 1 });
  });

  it("does not alert when the failed dispatch is not yet exhausted", async () => {
    const deps = makeDeps({
      claimDue: vi.fn(async () => [ROW("a")]),
      trigger: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await runKnowledgeReconcileSweep(deps);
    expect(deps.alert).not.toHaveBeenCalled();
  });

  it("resolves when claim throws, logging the error name only", async () => {
    const deps = makeDeps({
      claimDue: vi.fn(async () => {
        throw new TypeError("secret detail");
      }),
    });
    await expect(runKnowledgeReconcileSweep(deps)).resolves.toBeDefined();
    expect(deps.log.error).toHaveBeenCalledWith(
      "[cron:knowledge-reconcile] claim failed",
      { error: "TypeError" },
    );
  });

  it("an Off org (claim returns nothing) triggers and fails nothing", async () => {
    const deps = makeDeps();
    await runKnowledgeReconcileSweep(deps);
    expect(deps.trigger).not.toHaveBeenCalled();
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it("leaves remaining rows processing once the total budget is spent", async () => {
    const deps = makeDeps({
      claimDue: vi.fn(async () => [ROW("a"), ROW("b")]),
      budget: { totalMs: 0, claimLimit: 10, triggerTimeoutMs: 5000 },
    });
    const r = await runKnowledgeReconcileSweep(deps);
    expect(r.dispatched).toBe(0);
    expect(deps.fail).not.toHaveBeenCalled();
  });
});

describe("runKnowledgeReconcileSweep head check (D-03 / PD-19)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const CAND = (repo: string) => ({
    organizationId: "org1",
    repoFullName: repo,
    defaultBranch: "main" as string | null,
    lastSha: null,
    observedHeadSha: null,
  });
  const HEAD = "a".repeat(40);

  it("lists the slot of the tick minute, reads each head and recovers ok results", async () => {
    const now = new Date(Date.UTC(2026, 10, 2, 12, 7)); // minute 7 of the hour
    const minuteIndex = Math.floor(now.getTime() / 60_000);
    const deps = makeDeps({
      listHeadCandidates: vi.fn(async () => [CAND("acme/a"), CAND("acme/b")]),
      readHead: vi.fn(async (row) =>
        row.repoFullName === "acme/a"
          ? { kind: "ok" as const, sha: HEAD, defaultBranch: "main" }
          : { kind: "no_access" as const },
      ),
      recoverHead: vi.fn(async () => ({ outcome: "inserted" as const })),
    });
    const r = await runKnowledgeReconcileSweep(deps, now);
    expect(deps.listHeadCandidates).toHaveBeenCalledWith(
      now,
      minuteIndex % 15,
      5,
    );
    expect(deps.recoverHead).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.recoverHead).mock.calls[0]![1]).toBe(HEAD);
    expect(r).toMatchObject({
      headChecked: 1,
      headRecovered: 1,
      headSkipped: 1,
    });
    const logged = JSON.stringify([
      vi.mocked(deps.log.log).mock.calls,
      vi.mocked(deps.log.error).mock.calls,
    ]);
    expect(logged).not.toContain(HEAD);
  });

  it("counts in_sync as checked only and other outcomes as skipped", async () => {
    const outcomes = [
      "in_sync",
      "open_intent",
      "failed_exists",
      "busy",
    ] as const;
    let i = 0;
    const deps = makeDeps({
      listHeadCandidates: vi.fn(async () =>
        outcomes.map((_, n) => CAND(`acme/r${n}`)),
      ),
      readHead: vi.fn(async () => ({
        kind: "ok" as const,
        sha: HEAD,
        defaultBranch: "main",
      })),
      recoverHead: vi.fn(async () => ({ outcome: outcomes[i++]! })),
    });
    const r = await runKnowledgeReconcileSweep(deps);
    expect(r).toMatchObject({
      headChecked: 4,
      headRecovered: 0,
      headSkipped: 3,
    });
  });

  it("skips the head check entirely under 8 s of remaining budget", async () => {
    const deps = makeDeps({
      budget: {
        totalMs: 7_000,
        claimLimit: 10,
        triggerTimeoutMs: 5_000,
      },
    });
    const r = await runKnowledgeReconcileSweep(deps);
    expect(deps.listHeadCandidates).not.toHaveBeenCalled();
    expect(r.headChecked).toBe(0);
    expect(deps.log.log).toHaveBeenCalledTimes(1);
  });

  it("does not run when the sweep is disabled", async () => {
    const deps = makeDeps({ secret: () => "" });
    await runKnowledgeReconcileSweep(deps);
    expect(deps.listHeadCandidates).not.toHaveBeenCalled();
  });

  it("runs after dispatch so a head check never delays it", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      claimDue: vi.fn(async () => [ROW("a")]),
      trigger: vi.fn(async () => {
        order.push("trigger");
      }),
      listHeadCandidates: vi.fn(async () => {
        order.push("list");
        return [];
      }),
    });
    await runKnowledgeReconcileSweep(deps);
    expect(order).toEqual(["trigger", "list"]);
  });

  it("logs by error name and keeps dispatch results when readHead or recover throws", async () => {
    const deps = makeDeps({
      claimDue: vi.fn(async () => [ROW("a")]),
      listHeadCandidates: vi.fn(async () => [CAND("acme/a"), CAND("acme/b")]),
      readHead: vi
        .fn()
        .mockRejectedValueOnce(new TypeError("boom"))
        .mockResolvedValueOnce({
          kind: "ok",
          sha: HEAD,
          defaultBranch: "main",
        }),
      recoverHead: vi.fn(async () => {
        throw new RangeError("db down");
      }),
    });
    const r = await runKnowledgeReconcileSweep(deps);
    expect(r).toMatchObject({ dispatched: 1, headSkipped: 2 });
    expect(deps.log.error).toHaveBeenCalledWith(
      "[cron:knowledge-reconcile] head check failed",
      { organizationId: "org1", error: "TypeError" },
    );
    expect(deps.log.error).toHaveBeenCalledWith(
      "[cron:knowledge-reconcile] head check failed",
      { organizationId: "org1", error: "RangeError" },
    );
  });

  it("survives listHeadCandidates throwing", async () => {
    const deps = makeDeps({
      listHeadCandidates: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(runKnowledgeReconcileSweep(deps)).resolves.toMatchObject({
      headChecked: 0,
    });
  });

  it("bounds a slow repo by min(remaining - 4 s, 9 s) and never overruns the sweep", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const deadlines: number[] = [];
    const deps = makeDeps({
      listHeadCandidates: vi.fn(async () => [
        CAND("acme/a"),
        CAND("acme/b"),
        CAND("acme/c"),
        CAND("acme/d"),
      ]),
      readHead: vi.fn(
        (_row, signal: AbortSignal) =>
          new Promise<{ kind: "error" }>((resolve) => {
            const began = Date.now();
            signal.addEventListener("abort", () => {
              deadlines.push(Date.now() - began);
              resolve({ kind: "error" as const });
            });
          }),
      ),
    });
    const pending = runKnowledgeReconcileSweep(deps);
    await vi.advanceTimersByTimeAsync(25_000);
    const r = await pending;
    // 20 s total: first repo min(20 - 4, 9) = 9 s, second min(11 - 4, 9) = 7 s,
    // then 4 s remain: nothing more is started.
    expect(deadlines).toEqual([9_000, 7_000]);
    expect(deps.readHead).toHaveBeenCalledTimes(2);
    expect(r.headSkipped).toBe(2);
    expect(Date.now() - start).toBeLessThanOrEqual(25_000);
    expect(deadlines.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
      20_000 - 4_000,
    );
  });
});
