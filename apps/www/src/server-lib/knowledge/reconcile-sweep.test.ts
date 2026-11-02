import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import {
  runKnowledgeReconcileSweep,
  type KnowledgeReconcileSweepDeps,
} from "./reconcile-sweep";

const ROW = (id: string) => ({
  id,
  organizationId: "org1",
  repoFullName: "o/r",
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
      repoFullName: "o/r",
    })),
    trigger: vi.fn(async () => undefined),
    alert: vi.fn(async () => undefined),
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
          repoFullName: "o/r",
          attempts: 8,
          code: "max_attempts" as const,
          state: "failed" as const,
          becameFailed: true,
        },
        {
          id: "i2",
          organizationId: "org1",
          repoFullName: "o/r",
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
      repoFullName: "o/r",
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
        repoFullName: "o/r",
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
