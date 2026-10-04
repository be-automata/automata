import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { STALLED_CUTOFF_SECS } from "./cron";

const h = vi.hoisted(() => ({
  order: [] as string[],
  getStalledThreads: vi.fn(),
  selfHeal: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@terragon/shared/model/threads", () => ({
  getStalledThreads: h.getStalledThreads,
  stopStalledThreads: vi.fn(async () => {
    h.order.push("stop");
  }),
  getUserIdsWithThreadsStuckInQueue: vi.fn(async () => []),
  getUserIdsWithThreadsReadyToProcess: vi.fn(async () => []),
  getScheduledThreadChatsDueToRun: vi.fn(async () => []),
}));
vi.mock("@terragon/shared/model/automations", () => ({
  getScheduledAutomationsDueToRun: vi.fn(async () => []),
}));
vi.mock("@/agent/sandbox", () => ({ maybeHibernateSandboxById: vi.fn() }));
vi.mock("@/server-lib/process-queued-thread", () => ({
  maybeStartQueuedThreadChat: vi.fn(),
}));
vi.mock("@/server-lib/review/review-sweep", () => ({
  runReviewSweep: vi.fn(async () => {
    h.order.push("review-sweep");
  }),
}));
vi.mock("@terragon/shared/model/hatchet-run", () => ({
  pruneHatchetRuns: vi.fn(async () => {
    h.order.push("prune-hatchet");
    return 0;
  }),
}));
vi.mock("@terragon/shared/model/egress-events", () => ({
  pruneEgressEvents: vi.fn(async () => {
    h.order.push("prune-egress");
    return 0;
  }),
}));
vi.mock("@/server-lib/audit/self-heal-cron", () => ({
  runSelfHealCron: h.selfHeal,
}));

/**
 * Enterprise-hardening #2 watchdog delta (amendment 5): the hourly stalled-task cron
 * reaps with a cutoff ABOVE a remote agent-run's 60m worst case (30m Hatchet schedule
 * + 30m execution), else a late-starting remote run is reaped at the boundary.
 * runStalledTasksCron passes this constant to getStalledThreads (see cron.ts); this
 * locks the raised value so a future edit can't silently drop it back to ≤60m.
 */
describe("stalled-task watchdog cutoff", () => {
  it("is 75 minutes — above the 60m remote worst case, with margin", () => {
    expect(STALLED_CUTOFF_SECS).toBe(75 * 60);
    expect(STALLED_CUTOFF_SECS).toBeGreaterThan(60 * 60);
  });
});

/** RES-20: self-heal work is last and can never starve review recovery. */
describe("runScheduledCron self-heal bulkhead", () => {
  let runScheduledCron: (cron: string) => Promise<void>;

  beforeEach(async () => {
    // The cron module is loaded eagerly by the test harness with real top-level
    // imports; a fresh module graph is what lets the mocks above bind.
    vi.resetModules();
    ({ runScheduledCron } = await import("./cron"));
    h.order.length = 0;
    h.getStalledThreads.mockReset();
    h.getStalledThreads.mockResolvedValue([{ id: "t1", userId: "u1" }]);
    h.selfHeal.mockReset();
    h.selfHeal.mockImplementation(async (kind: string) => {
      h.order.push(`self-heal:${kind}`);
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hourly: review sweep, prunes and the stalled stop run before self-heal", async () => {
    await runScheduledCron("0 * * * *");
    expect(h.order).toEqual([
      "review-sweep",
      "prune-hatchet",
      "prune-egress",
      "stop",
      "self-heal:hourly",
    ]);
  });

  it("hourly: a throwing self-heal cron does not break the run", async () => {
    h.selfHeal.mockRejectedValue(new Error("self-heal down"));
    await expect(runScheduledCron("0 * * * *")).resolves.toBeUndefined();
    expect(h.order).toEqual([
      "review-sweep",
      "prune-hatchet",
      "prune-egress",
      "stop",
    ]);
  });

  it("hourly: a hanging self-heal cron cannot have delayed anything before it", async () => {
    h.selfHeal.mockImplementation(() => new Promise(() => undefined));
    void runScheduledCron("0 * * * *");
    await vi.waitFor(() => expect(h.selfHeal).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    expect(h.order).toEqual([
      "review-sweep",
      "prune-hatchet",
      "prune-egress",
      "stop",
    ]);
  });

  it("hourly: self-heal runs when there are no stalled threads (early return)", async () => {
    h.getStalledThreads.mockResolvedValue([]);
    await runScheduledCron("0 * * * *");
    expect(h.selfHeal).toHaveBeenCalledWith("hourly");
  });

  it("hourly: self-heal runs when the stalled runner throws", async () => {
    h.getStalledThreads.mockRejectedValue(new Error("db down"));
    await expect(runScheduledCron("0 * * * *")).rejects.toThrow("db down");
    expect(h.selfHeal).toHaveBeenCalledWith("hourly");
  });

  it("*/10: the queue drain runs, then self-heal as a tick", async () => {
    await runScheduledCron("*/10 * * * *");
    expect(h.selfHeal).toHaveBeenCalledTimes(1);
    expect(h.selfHeal).toHaveBeenCalledWith("tick");
  });

  it("other patterns never run self-heal", async () => {
    await runScheduledCron("*/1 * * * *");
    await runScheduledCron("*/30 * * * *");
    expect(h.selfHeal).not.toHaveBeenCalled();
  });
});
