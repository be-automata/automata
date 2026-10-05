import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DB } from "@terragon/shared/db";

import {
  runSelfHealCron,
  SELF_HEAL_CRON_BUDGET,
  type SelfHealCronDeps,
} from "./self-heal-cron";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@terragon/env/apps-www", () => ({
  env: {
    GITHUB_SIDE_EFFECTS_ENABLED: true,
    GITHUB_BOT_LOGIN: "automata-ai-bot[bot]",
    NEXT_PUBLIC_GITHUB_APP_NAME: "automata-ai-bot",
  },
}));
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));

function harness(overrides: Partial<SelfHealCronDeps> = {}) {
  const order: string[] = [];
  const drain = vi.fn(async () => {
    order.push("drain");
    return { claimed: 0, applied: 0, pending: 0, failed: 0, groups: 0 };
  });
  const sweep = vi.fn(async () => {
    order.push("sweep");
    return { scanned: 0, processed: 0 };
  });
  const prune = vi.fn(async () => {
    order.push("prune");
    return { effects: 0, events: 0, runs: 0 };
  });
  const reconcile = vi.fn(async () => {
    order.push("reconcile");
    return {
      lost: 0,
      extended: 0,
      refunded: 0,
      counted: 0,
      killed: 0,
      lookupFailed: 0,
    };
  });
  const openPrs = vi.fn(async () => {
    order.push("openPrs");
    return { processed: 0, outcomes: {} };
  });
  const evaluateDrafts = vi.fn(async () => {
    order.push("evaluateDrafts");
    return { processed: 0, outcomes: {} };
  });
  const dispatch = vi.fn(async () => {
    order.push("dispatch");
    return { dispatched: null, considered: 0 };
  });
  const deps: SelfHealCronDeps = {
    db: {} as DB,
    now: () => new Date(),
    drain: drain as unknown as SelfHealCronDeps["drain"],
    sweep: sweep as unknown as SelfHealCronDeps["sweep"],
    prune: prune as unknown as SelfHealCronDeps["prune"],
    reconcile: reconcile as unknown as SelfHealCronDeps["reconcile"],
    openPrs: openPrs as unknown as SelfHealCronDeps["openPrs"],
    evaluateDrafts:
      evaluateDrafts as unknown as SelfHealCronDeps["evaluateDrafts"],
    dispatch: dispatch as unknown as SelfHealCronDeps["dispatch"],
    budget: SELF_HEAL_CRON_BUDGET,
    ...overrides,
  };
  return {
    deps,
    order,
    drain,
    sweep,
    prune,
    reconcile,
    openPrs,
    evaluateDrafts,
    dispatch,
  };
}

describe("runSelfHealCron", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pins the budget", () => {
    expect(SELF_HEAL_CRON_BUDGET).toEqual({
      totalMs: 120_000,
      perItemMs: 20_000,
      limit: 20,
    });
  });

  it("a tick drains, sweeps, reconciles, opens pending drafts, evaluates draft CI, then runs the fix dispatcher LAST, and does not prune", async () => {
    const h = harness();
    await runSelfHealCron("tick", h.deps);
    expect(h.order).toEqual([
      "drain",
      "sweep",
      "reconcile",
      "openPrs",
      "evaluateDrafts",
      "dispatch",
    ]);
  });

  it("the draft CI sweep gets the shared deadline and the LIMIT 20 budget", async () => {
    const h = harness();
    await runSelfHealCron("tick", h.deps);
    const arg = (
      h.evaluateDrafts.mock.calls[0] as unknown as [
        { deadlineAt: Date; limit: number; db: unknown; now: Date },
      ]
    )[0];
    const drainArg = (
      h.drain.mock.calls[0] as unknown as [{ deadlineAt: Date }]
    )[0];
    expect(arg.deadlineAt).toEqual(drainArg.deadlineAt);
    expect(arg.limit).toBe(20);
    expect(arg.db).toBe(h.deps.db);
    expect(arg.now).toBeInstanceOf(Date);
  });

  it("still dispatches when the draft CI sweep throws", async () => {
    const h = harness();
    h.evaluateDrafts.mockRejectedValueOnce(new Error("boom"));
    await runSelfHealCron("tick", h.deps);
    expect(h.order).toEqual([
      "drain",
      "sweep",
      "reconcile",
      "openPrs",
      "dispatch",
    ]);
  });

  it("the draft-open sweep gets the shared deadline and the LIMIT 20 budget", async () => {
    const h = harness();
    await runSelfHealCron("tick", h.deps);
    const arg = (
      h.openPrs.mock.calls[0] as unknown as [
        { deadlineAt: Date; limit: number; db: unknown; now: Date },
      ]
    )[0];
    const drainArg = (
      h.drain.mock.calls[0] as unknown as [{ deadlineAt: Date }]
    )[0];
    expect(arg.deadlineAt).toEqual(drainArg.deadlineAt);
    expect(arg.limit).toBe(20);
    expect(arg.db).toBe(h.deps.db);
    expect(arg.now).toBeInstanceOf(Date);
  });

  it("still dispatches when the draft-open sweep throws", async () => {
    const h = harness();
    h.openPrs.mockRejectedValueOnce(new Error("boom"));
    await runSelfHealCron("tick", h.deps);
    expect(h.order).toEqual([
      "drain",
      "sweep",
      "reconcile",
      "evaluateDrafts",
      "dispatch",
    ]);
  });

  it("the reconcile gets the shared deadline and the LIMIT 20 budget", async () => {
    const h = harness();
    await runSelfHealCron("tick", h.deps);
    const arg = (
      h.reconcile.mock.calls[0] as unknown as [
        { deadlineAt: Date; limit: number; db: unknown },
      ]
    )[0];
    const drainArg = (
      h.drain.mock.calls[0] as unknown as [{ deadlineAt: Date }]
    )[0];
    expect(arg.deadlineAt).toEqual(drainArg.deadlineAt);
    expect(arg.limit).toBe(20);
    expect(arg.db).toBe(h.deps.db);
  });

  it("still dispatches when the reconcile throws", async () => {
    const h = harness();
    h.reconcile.mockRejectedValueOnce(new Error("boom"));
    await runSelfHealCron("tick", h.deps);
    expect(h.order).toEqual([
      "drain",
      "sweep",
      "openPrs",
      "evaluateDrafts",
      "dispatch",
    ]);
  });

  it("the hourly kind prunes and never reconciles or dispatches", async () => {
    const h = harness();
    await runSelfHealCron("hourly", h.deps);
    expect(h.order).toEqual(["drain", "sweep", "prune"]);
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.openPrs).not.toHaveBeenCalled();
    expect(h.evaluateDrafts).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("the dispatcher gets the tick's shared deadline (inside the 120 s budget)", async () => {
    const h = harness();
    const start = Date.now();
    await runSelfHealCron("tick", h.deps);
    const arg = (
      h.dispatch.mock.calls[0] as unknown as [
        { deadlineAt: Date; now: Date; db: unknown },
      ]
    )[0];
    const drainArg = (
      h.drain.mock.calls[0] as unknown as [{ deadlineAt: Date }]
    )[0];
    expect(arg.deadlineAt).toEqual(drainArg.deadlineAt);
    expect(arg.deadlineAt.getTime() - start).toBeLessThanOrEqual(
      SELF_HEAL_CRON_BUDGET.totalMs + 50,
    );
    expect(arg.db).toBe(h.deps.db);
  });

  it("still dispatches when the drain and the sweep throw", async () => {
    const h = harness();
    h.drain.mockRejectedValueOnce(new Error("boom"));
    h.sweep.mockRejectedValueOnce(new Error("boom"));
    await expect(runSelfHealCron("tick", h.deps)).resolves.toBeUndefined();
    expect(h.order).toEqual([
      "reconcile",
      "openPrs",
      "evaluateDrafts",
      "dispatch",
    ]);
  });

  it("abandons a hung dispatcher at the total deadline and resolves", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.dispatch.mockImplementationOnce(() => new Promise(() => undefined));
    const done = runSelfHealCron("tick", h.deps);
    await vi.advanceTimersByTimeAsync(SELF_HEAL_CRON_BUDGET.totalMs + 1);
    await expect(done).resolves.toBeUndefined();
  });

  it("passes the shared deadline, per-item budget and limit down", async () => {
    const h = harness();
    await runSelfHealCron("tick", h.deps);
    const arg = (
      h.drain.mock.calls[0] as unknown as [Record<string, unknown>]
    )[0];
    expect(arg.perItemMs).toBe(20_000);
    expect(arg.limit).toBe(20);
    expect(arg.deadlineAt).toBeInstanceOf(Date);
  });

  it("still sweeps and prunes when the drain throws", async () => {
    const h = harness();
    h.drain.mockRejectedValueOnce(new Error("boom"));
    await expect(runSelfHealCron("hourly", h.deps)).resolves.toBeUndefined();
    expect(h.order).toEqual(["sweep", "prune"]);
  });

  it("abandons a hung drain at the total deadline and resolves", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.drain.mockImplementationOnce(() => new Promise(() => undefined));
    const done = runSelfHealCron("tick", h.deps);
    await vi.advanceTimersByTimeAsync(SELF_HEAL_CRON_BUDGET.totalMs + 1);
    await expect(done).resolves.toBeUndefined();
  });
});
