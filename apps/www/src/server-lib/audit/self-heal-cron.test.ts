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
  const settlePrs = vi.fn(async () => {
    order.push("settlePrs");
    return { processed: 0, outcomes: {} };
  });
  const breakers = vi.fn(async () => {
    order.push("breakers");
    return { repos: 0, orgs: 0, transitions: 0 };
  });
  const dispatch = vi.fn(async () => {
    order.push("dispatch");
    return { dispatched: null, considered: 0 };
  });
  const expirePrs = vi.fn(async () => {
    order.push("expirePrs");
    return { checked: 0, expired: 0, outcomes: {} };
  });
  const regressions = vi.fn(async () => {
    order.push("regressions");
    return { checked: 0, regressed: 0, reopened: 0, outcomes: {} };
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
    settlePrs: settlePrs as unknown as SelfHealCronDeps["settlePrs"],
    breakers: breakers as unknown as SelfHealCronDeps["breakers"],
    dispatch: dispatch as unknown as SelfHealCronDeps["dispatch"],
    expirePrs: expirePrs as unknown as SelfHealCronDeps["expirePrs"],
    regressions: regressions as unknown as SelfHealCronDeps["regressions"],
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
    settlePrs,
    breakers,
    dispatch,
    expirePrs,
    regressions,
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

  it("a tick drains, sweeps, reconciles, opens pending drafts, evaluates draft CI, settles fix PRs and the breakers, then runs the fix dispatcher LAST, and does not prune", async () => {
    const h = harness();
    await runSelfHealCron("tick", h.deps);
    expect(h.order).toEqual([
      "drain",
      "sweep",
      "reconcile",
      "openPrs",
      "evaluateDrafts",
      "settlePrs",
      "breakers",
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
      "settlePrs",
      "breakers",
      "dispatch",
    ]);
  });

  it("the breaker evaluation runs after the draft CI sweep and before the dispatcher, with the shared deadline", async () => {
    const h = harness();
    await runSelfHealCron("tick", h.deps);
    const order = h.order;
    expect(order.indexOf("breakers")).toBe(order.indexOf("settlePrs") + 1);
    expect(order.indexOf("dispatch")).toBe(order.indexOf("breakers") + 1);
    const arg = (
      h.breakers.mock.calls[0] as unknown as [
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

  it("the fix PR settle sweep runs after the draft CI sweep with the shared deadline and LIMIT 20 (09-14)", async () => {
    const h = harness();
    await runSelfHealCron("tick", h.deps);
    expect(h.order.indexOf("settlePrs")).toBe(
      h.order.indexOf("evaluateDrafts") + 1,
    );
    const arg = (
      h.settlePrs.mock.calls[0] as unknown as [
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

  it("still evaluates breakers and dispatches when the settle sweep throws", async () => {
    const h = harness();
    h.settlePrs.mockRejectedValueOnce(new Error("boom"));
    await runSelfHealCron("tick", h.deps);
    expect(h.order).toEqual([
      "drain",
      "sweep",
      "reconcile",
      "openPrs",
      "evaluateDrafts",
      "breakers",
      "dispatch",
    ]);
  });

  it("still dispatches when the breaker evaluation throws", async () => {
    const h = harness();
    h.breakers.mockRejectedValueOnce(new Error("boom"));
    await runSelfHealCron("tick", h.deps);
    expect(h.order).toEqual([
      "drain",
      "sweep",
      "reconcile",
      "openPrs",
      "evaluateDrafts",
      "settlePrs",
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
      "settlePrs",
      "breakers",
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
      "settlePrs",
      "breakers",
      "dispatch",
    ]);
  });

  it("the hourly kind prunes, then expires unreviewed fix PRs, then checks merged fixes for regressions, and never reconciles or dispatches", async () => {
    const h = harness();
    await runSelfHealCron("hourly", h.deps);
    expect(h.order).toEqual([
      "drain",
      "sweep",
      "prune",
      "expirePrs",
      "regressions",
    ]);
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.openPrs).not.toHaveBeenCalled();
    expect(h.evaluateDrafts).not.toHaveBeenCalled();
    expect(h.settlePrs).not.toHaveBeenCalled();
    expect(h.breakers).not.toHaveBeenCalled();
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
      "settlePrs",
      "breakers",
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
    expect(h.order).toEqual(["sweep", "prune", "expirePrs", "regressions"]);
  });

  it("the expiry and regression sweeps get the hourly run's shared deadline and LIMIT 20 (R5)", async () => {
    const h = harness();
    await runSelfHealCron("hourly", h.deps);
    const drainArg = (
      h.drain.mock.calls[0] as unknown as [{ deadlineAt: Date }]
    )[0];
    for (const fn of [h.expirePrs, h.regressions]) {
      const arg = (
        fn.mock.calls[0] as unknown as [
          { deadlineAt: Date; limit: number; db: unknown; now: Date },
        ]
      )[0];
      expect(arg.deadlineAt).toEqual(drainArg.deadlineAt);
      expect(arg.limit).toBe(20);
      expect(arg.db).toBe(h.deps.db);
      expect(arg.now).toBeInstanceOf(Date);
    }
    expect(h.expirePrs).toHaveBeenCalledTimes(1);
    expect(h.regressions).toHaveBeenCalledTimes(1);
  });

  it("still checks regressions when the expiry sweep throws; a tick runs neither", async () => {
    const h = harness();
    h.expirePrs.mockRejectedValueOnce(new Error("boom"));
    await runSelfHealCron("hourly", h.deps);
    expect(h.order).toEqual(["drain", "sweep", "prune", "regressions"]);
    const t = harness();
    await runSelfHealCron("tick", t.deps);
    expect(t.expirePrs).not.toHaveBeenCalled();
    expect(t.regressions).not.toHaveBeenCalled();
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
