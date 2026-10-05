import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { STALLED_CUTOFF_SECS } from "./cron";

const h = vi.hoisted(() => ({
  order: [] as string[],
  getStalledThreads: vi.fn(),
  selfHeal: vi.fn(),
  due: vi.fn(async (): Promise<unknown[]> => []),
  runAutomation: vi.fn(),
  admit: vi.fn(),
  setHolder: vi.fn(),
  release: vi.fn(),
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
  getScheduledAutomationsDueToRun: h.due,
}));
vi.mock("@/server-lib/automations", () => ({
  runAutomation: h.runAutomation,
}));
vi.mock("@/server-lib/audit/self-heal-admission", () => ({
  admitSelfHealRun: h.admit,
}));
vi.mock("@terragon/shared/model/self-heal-slot", () => ({
  setSlotHolderThread: h.setHolder,
  releaseSelfHealSlot: h.release,
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

/**
 * BULK-01: scheduled audit-findings automations obey the same review-first
 * admission and box slot as fix runs. A deferred audit never reaches
 * runAutomation — the only writer of nextRunAt (markAutomationExecuted) — so
 * it stays due and the next tick retries it.
 */
describe("runAutomationsCron self-heal admission", () => {
  let runAutomationsCron: () => Promise<void>;

  const AUDIT = {
    id: "auto-audit",
    userId: "u1",
    organizationId: "org-1",
    repoFullName: "acme/widgets",
    action: {
      type: "skill_message",
      config: { skillName: "audit-findings", version: "latest" },
    },
  };
  const PLAIN = {
    id: "auto-plain",
    userId: "u2",
    organizationId: "org-1",
    repoFullName: "acme/widgets",
    action: {
      type: "user_message",
      config: { message: { type: "user", model: null, parts: [] } },
    },
  };
  const OTHER_SKILL = {
    ...PLAIN,
    id: "auto-skill",
    action: {
      type: "skill_message",
      config: { skillName: "pr-review", version: "latest" },
    },
  };

  beforeEach(async () => {
    vi.resetModules();
    ({ runAutomationsCron } = await import("./cron"));
    for (const fn of [
      h.due,
      h.runAutomation,
      h.admit,
      h.setHolder,
      h.release,
    ]) {
      fn.mockReset();
    }
    h.runAutomation.mockResolvedValue({
      threadId: "thr-1",
      threadChatId: "c1",
    });
    h.admit.mockResolvedValue({ admitted: true });
    h.setHolder.mockResolvedValue(true);
    h.release.mockResolvedValue(true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defers an audit while a review is in flight: runAutomation is not called, it stays due", async () => {
    h.due.mockResolvedValue([AUDIT]);
    h.admit.mockResolvedValue({ admitted: false, reason: "review_in_flight" });
    await runAutomationsCron();
    expect(h.admit).toHaveBeenCalledTimes(1);
    expect(h.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        holderKind: "audit",
        context: expect.objectContaining({ repoFullName: "acme/widgets" }),
      }),
    );
    expect(h.runAutomation).not.toHaveBeenCalled();
    expect(h.setHolder).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();

    // Next tick: still selected as due (nothing advanced nextRunAt).
    h.admit.mockResolvedValue({ admitted: true });
    await runAutomationsCron();
    expect(h.runAutomation).toHaveBeenCalledTimes(1);
  });

  it("defers an audit when the slot is held", async () => {
    h.due.mockResolvedValue([AUDIT]);
    h.admit.mockResolvedValue({ admitted: false, reason: "slot_held" });
    await runAutomationsCron();
    expect(h.runAutomation).not.toHaveBeenCalled();
  });

  it("admitted: runs the audit and records its thread as the slot holder", async () => {
    h.due.mockResolvedValue([AUDIT]);
    await runAutomationsCron();
    expect(h.runAutomation).toHaveBeenCalledWith({
      automationId: "auto-audit",
      userId: "u1",
      source: "automated",
    });
    expect(h.setHolder).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thr-1" }),
    );
    expect(h.release).not.toHaveBeenCalled();
  });

  it("admitted but no thread started: the pre-holder slot is released", async () => {
    h.due.mockResolvedValue([AUDIT]);
    h.runAutomation.mockResolvedValue(undefined);
    await runAutomationsCron();
    expect(h.setHolder).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release.mock.calls[0]![0]).not.toHaveProperty("threadId");
  });

  it("admitted but runAutomation throws: the slot is released and the cron does not throw", async () => {
    h.due.mockResolvedValue([AUDIT]);
    h.runAutomation.mockRejectedValue(new Error("boom"));
    await expect(runAutomationsCron()).resolves.toBeUndefined();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("an admission error fails closed: deferred, no throw out of the cron", async () => {
    h.due.mockResolvedValue([AUDIT, PLAIN]);
    h.admit.mockRejectedValue(new Error("db down"));
    await expect(runAutomationsCron()).resolves.toBeUndefined();
    expect(h.runAutomation).toHaveBeenCalledTimes(1);
    expect(h.runAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ automationId: "auto-plain" }),
    );
  });

  it("non-audit automations bypass admission exactly as before", async () => {
    h.due.mockResolvedValue([PLAIN, OTHER_SKILL]);
    await runAutomationsCron();
    expect(h.admit).not.toHaveBeenCalled();
    expect(h.runAutomation).toHaveBeenCalledTimes(2);
    expect(h.setHolder).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });
});
