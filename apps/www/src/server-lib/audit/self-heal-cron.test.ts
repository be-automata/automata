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
  const deps: SelfHealCronDeps = {
    db: {} as DB,
    now: () => new Date(),
    drain: drain as unknown as SelfHealCronDeps["drain"],
    sweep: sweep as unknown as SelfHealCronDeps["sweep"],
    prune: prune as unknown as SelfHealCronDeps["prune"],
    budget: SELF_HEAL_CRON_BUDGET,
    ...overrides,
  };
  return { deps, order, drain, sweep, prune };
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

  it("a tick drains, then sweeps, and does not prune", async () => {
    const h = harness();
    await runSelfHealCron("tick", h.deps);
    expect(h.order).toEqual(["drain", "sweep"]);
  });

  it("the hourly kind additionally prunes", async () => {
    const h = harness();
    await runSelfHealCron("hourly", h.deps);
    expect(h.order).toEqual(["drain", "sweep", "prune"]);
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
