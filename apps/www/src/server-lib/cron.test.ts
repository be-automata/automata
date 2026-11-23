import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { STALLED_CUTOFF_SECS } from "./cron";

const h = vi.hoisted(() => ({
  order: [] as string[],
  getStalledThreads: vi.fn(),
  selfHeal: vi.fn(),
  purge: vi.fn(),
  evidenceCheck: vi.fn(),
  cellEvidence: vi.fn(),
  reconcile: vi.fn(),
  busSweep: vi.fn(),
  dueThreads: vi.fn(async (): Promise<unknown[]> => []),
  due: vi.fn(async (): Promise<unknown[]> => []),
  runAutomation: vi.fn(),
  admit: vi.fn(),
  setHolder: vi.fn(),
  release: vi.fn(),
  strandedSweep: vi.fn(),
  stuckUsers: vi.fn(async (): Promise<string[]> => []),
  drain: vi.fn(),
  cellProvider: vi.fn(),
  cellReconcile: vi.fn(),
  pruneAgentMessages: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@terragon/shared/model/threads", () => ({
  getStalledThreads: h.getStalledThreads,
  stopStalledThreads: vi.fn(async ({ threadIds }: { threadIds: string[] }) => {
    h.order.push("stop");
    return threadIds;
  }),
  getUserIdsWithThreadsStuckInQueue: h.stuckUsers,
  getUserIdsWithThreadsReadyToProcess: vi.fn(async () => []),
  getScheduledThreadChatsDueToRun: h.dueThreads,
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
  maybeStartQueuedThreadChat: h.drain,
  retireStrandedQueuedThreads: h.strandedSweep,
}));
vi.mock("@/server-lib/review/mention-terminal-reply", () => ({
  replyToMentionsAtTerminal: vi.fn(
    async (targets: readonly { threadId: string }[]) => {
      h.order.push(`mention-reply:${targets.map((t) => t.threadId).join(",")}`);
    },
  ),
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
vi.mock("@terragon/shared/model/agent-bus/retention", () => ({
  pruneAgentMessages: h.pruneAgentMessages,
}));
vi.mock("@/server-lib/audit/self-heal-cron", () => ({
  runSelfHealCron: h.selfHeal,
}));
vi.mock("@/server-lib/knowledge/reconcile-sweep", () => ({
  runKnowledgeReconcileSweep: h.reconcile,
}));
vi.mock("@/server-lib/agent-bus/delivery", () => ({
  runAgentBusSweep: h.busSweep,
}));
vi.mock("@/server-lib/knowledge/purge-sweep", () => ({
  runKnowledgePurgeSweep: h.purge,
}));
vi.mock("@/server-lib/compute/cell-control", () => ({
  cellProvider: h.cellProvider,
  runCellReconciler: h.cellReconcile,
}));
vi.mock("@/server-lib/compute/profile-evidence-expiry", () => ({
  runProfileEvidenceExpiryCheck: h.evidenceCheck,
}));
vi.mock("@/server-lib/compute/cell-evidence-status", async (importActual) => ({
  ...(await importActual<
    typeof import("@/server-lib/compute/cell-evidence-status")
  >()),
  readCellEvidenceStatus: h.cellEvidence,
}));

/**
 * Enterprise-hardening #2 watchdog delta (amendment 5): the hourly stalled-task cron
 * reaps with a cutoff ABOVE a remote task run's 90m worst case (30m Hatchet schedule
 * + 60m task-lane execution budget, #742), else a late-starting remote run is reaped
 * at the boundary. runStalledTasksCron passes this constant to getStalledThreads (see
 * cron.ts); this locks the raised value so a future edit can't silently drop it.
 */
describe("stalled-task watchdog cutoff", () => {
  it("is 105 minutes — above the 30 + 60 minute remote worst case, with margin", () => {
    expect(STALLED_CUTOFF_SECS).toBe(105 * 60);
    expect(STALLED_CUTOFF_SECS).toBeGreaterThan((30 + 60) * 60);
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
    h.purge.mockReset();
    h.purge.mockImplementation(async () => {
      h.order.push("knowledge-purge");
    });
    h.evidenceCheck.mockReset();
    h.evidenceCheck.mockImplementation(async () => {
      h.order.push("profile-evidence");
      return { ran: false, expiring: [], alerted: false };
    });
    h.cellEvidence.mockReset();
    h.cellEvidence.mockImplementation(async () => {
      h.order.push("cell-evidence");
      return { status: "unconfigured" };
    });
    h.pruneAgentMessages.mockReset();
    h.pruneAgentMessages.mockImplementation(async () => {
      h.order.push("prune-agent-messages");
      return { messages: 0, applied: 0, orphans: 0 };
    });
    h.cellProvider.mockReset();
    h.cellProvider.mockReturnValue(null);
    h.cellReconcile.mockReset();
    h.cellReconcile.mockImplementation(async () => {
      h.order.push("cell-reconcile");
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
      "prune-agent-messages",
      "stop",
      // #668: the threads the watchdog moved, after hibernation.
      "mention-reply:t1",
      "self-heal:hourly",
      "knowledge-purge",
      "profile-evidence",
      "cell-evidence",
    ]);
  });

  it("hourly: a throwing self-heal cron does not break the run or skip the purge", async () => {
    h.selfHeal.mockRejectedValue(new Error("self-heal down"));
    await expect(runScheduledCron("0 * * * *")).resolves.toBeUndefined();
    expect(h.order).toEqual([
      "review-sweep",
      "prune-hatchet",
      "prune-egress",
      "prune-agent-messages",
      "stop",
      "mention-reply:t1",
      "knowledge-purge",
      "profile-evidence",
      "cell-evidence",
    ]);
  });

  it("hourly (#759): a throwing agent_messages prune is logged and skips neither the stop, self-heal nor the purge", async () => {
    h.pruneAgentMessages.mockRejectedValue(new Error("prune down"));
    await expect(runScheduledCron("0 * * * *")).resolves.toBeUndefined();
    expect(h.order).toEqual([
      "review-sweep",
      "prune-hatchet",
      "prune-egress",
      "stop",
      "mention-reply:t1",
      "self-heal:hourly",
      "knowledge-purge",
      "profile-evidence",
      "cell-evidence",
    ]);
    expect(console.error).toHaveBeenCalledWith(
      "[cron:stalled] agent_messages prune failed (non-fatal)",
      expect.any(Error),
    );
  });

  it("hourly (#759): the agent_messages prune logs counts only when it deleted rows", async () => {
    await runScheduledCron("0 * * * *");
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining("agent_messages"),
    );
    h.pruneAgentMessages.mockResolvedValueOnce({
      messages: 3,
      applied: 3,
      orphans: 1,
    });
    await runScheduledCron("0 * * * *");
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("pruned 3 consumed + 1 orphaned agent_messages"),
    );
  });

  it("hourly: a throwing knowledge purge does not reject the cron", async () => {
    h.purge.mockRejectedValue(new Error("purge down"));
    await expect(runScheduledCron("0 * * * *")).resolves.toBeUndefined();
    expect(h.order.slice(-3)).toEqual([
      "self-heal:hourly",
      "profile-evidence",
      "cell-evidence",
    ]);
  });

  it("hourly: a throwing evidence expiry check does not reject the cron", async () => {
    h.evidenceCheck.mockRejectedValue(new Error("db down"));
    await expect(runScheduledCron("0 * * * *")).resolves.toBeUndefined();
    expect(h.order.slice(-2)).toEqual(["knowledge-purge", "cell-evidence"]);
  });

  it("hourly (#709): the cell evidence check logs an error line only when it needs attention", async () => {
    h.cellEvidence.mockResolvedValueOnce({
      status: "expiring",
      expiresAt: "2026-12-19T00:00:00.000Z",
      daysLeft: 3,
    });
    await runScheduledCron("0 * * * *");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("egress_not_enforced"),
      expect.objectContaining({ status: "expiring", daysLeft: 3 }),
    );
    vi.mocked(console.error).mockClear();
    h.cellEvidence.mockResolvedValueOnce({
      status: "ok",
      expiresAt: "2026-12-19T00:00:00.000Z",
      daysLeft: 20,
    });
    await runScheduledCron("0 * * * *");
    expect(console.log).toHaveBeenCalledWith(
      "[cron:cell-evidence] ok",
      expect.objectContaining({ status: "ok" }),
    );
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("[cron:cell-evidence]"),
      expect.anything(),
    );
  });

  it("hourly (#709): a throwing cell evidence check does not reject the cron", async () => {
    h.cellEvidence.mockRejectedValue(new Error("db down"));
    await expect(runScheduledCron("0 * * * *")).resolves.toBeUndefined();
    expect(h.order.at(-1)).toBe("profile-evidence");
  });

  it("other patterns never run the knowledge purge", async () => {
    await runScheduledCron("*/10 * * * *");
    await runScheduledCron("*/1 * * * *");
    expect(h.purge).not.toHaveBeenCalled();
    expect(h.evidenceCheck).not.toHaveBeenCalled();
    expect(h.cellEvidence).not.toHaveBeenCalled();
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
      "prune-agent-messages",
      "stop",
      "mention-reply:t1",
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

  // #471: plain `queued` rows are outside every drain; the 10m tick retires
  // the stranded ones first, and a failing sweep never skips the drain.
  it("*/10: the stranded-queued sweep runs before the drain", async () => {
    h.strandedSweep.mockReset();
    h.strandedSweep.mockImplementation(async () => {
      h.order.push("stranded-sweep");
      return { retired: 0, failed: 0 };
    });
    h.stuckUsers.mockResolvedValueOnce(["u1"]);
    h.drain.mockImplementation(async () => {
      h.order.push("drain");
    });
    await runScheduledCron("*/10 * * * *");
    expect(h.order).toEqual(["stranded-sweep", "drain", "self-heal:tick"]);
    expect(h.cellReconcile).not.toHaveBeenCalled();
  });

  it("*/10: a throwing stranded-queued sweep does not skip the drain", async () => {
    h.strandedSweep.mockReset();
    h.strandedSweep.mockRejectedValue(new Error("db down"));
    h.stuckUsers.mockResolvedValueOnce(["u1"]);
    h.drain.mockImplementation(async () => {
      h.order.push("drain");
    });
    await expect(runScheduledCron("*/10 * * * *")).resolves.toBeUndefined();
    expect(h.order).toEqual(["drain", "self-heal:tick"]);
  });

  it("*/10: the cell reconciler runs last when OpenSandbox is configured", async () => {
    h.cellProvider.mockReturnValue({});
    await runScheduledCron("*/10 * * * *");
    expect(h.order.at(-2)).toBe("self-heal:tick");
    expect(h.order.at(-1)).toBe("cell-reconcile");
  });

  it("*/10: the cell reconciler is a no-op when OpenSandbox is not configured", async () => {
    await runScheduledCron("*/10 * * * *");
    expect(h.cellReconcile).not.toHaveBeenCalled();
  });

  it("*/10: a throwing cell reconciler is swallowed", async () => {
    h.cellProvider.mockReturnValue({});
    h.cellReconcile.mockRejectedValue(new Error("server down"));
    await expect(runScheduledCron("*/10 * * * *")).resolves.toBeUndefined();
  });

  it("other patterns never run the cell reconciler", async () => {
    h.cellProvider.mockReturnValue({});
    await runScheduledCron("*/1 * * * *");
    await runScheduledCron("*/30 * * * *");
    expect(h.cellReconcile).not.toHaveBeenCalled();
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

/** D-12 / PD-7: the reconcile sweep rides the every-minute tick, last, fail-soft. */
describe("runScheduledTasksCron knowledge reconcile sweep", () => {
  let runScheduledTasksCron: () => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    ({ runScheduledTasksCron } = await import("./cron"));
    h.reconcile.mockReset();
    h.reconcile.mockResolvedValue(undefined);
    h.dueThreads.mockReset();
    h.dueThreads.mockResolvedValue([]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the sweep exactly once, after scheduled-thread processing", async () => {
    h.dueThreads.mockImplementation(async () => {
      h.order.push("due-threads");
      return [];
    });
    h.reconcile.mockImplementation(async () => {
      h.order.push("reconcile");
    });
    h.order.length = 0;
    await runScheduledTasksCron();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.order.slice(-2)).toEqual(["due-threads", "reconcile"]);
  });

  it("still runs the sweep when thread processing throws, and the error propagates", async () => {
    h.dueThreads.mockRejectedValue(new Error("db down"));
    await expect(runScheduledTasksCron()).rejects.toThrow("db down");
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it("a throwing sweep is logged and does not change the outcome", async () => {
    h.reconcile.mockRejectedValue(new Error("sweep down"));
    await expect(runScheduledTasksCron()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "[cron:knowledge-reconcile] failed (non-fatal)",
      expect.any(Error),
    );
  });

  it("the */1 pattern reaches the sweep once", async () => {
    const { runScheduledCron } = await import("./cron");
    await runScheduledCron("*/1 * * * *");
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });
});

/** #660 (D1): the agent-bus sweep rides the every-minute tick, after the reconcile sweep, fail-soft. */
describe("runScheduledTasksCron agent-bus sweep", () => {
  let runScheduledTasksCron: () => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    ({ runScheduledTasksCron } = await import("./cron"));
    h.busSweep.mockReset();
    h.busSweep.mockResolvedValue(undefined);
    h.reconcile.mockReset();
    h.reconcile.mockResolvedValue(undefined);
    h.dueThreads.mockReset();
    h.dueThreads.mockResolvedValue([]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the sweep once, after the due-threads step and the reconcile sweep", async () => {
    h.dueThreads.mockImplementation(async () => {
      h.order.push("due-threads");
      return [];
    });
    h.reconcile.mockImplementation(async () => {
      h.order.push("reconcile");
    });
    h.busSweep.mockImplementation(async () => {
      h.order.push("agent-bus");
    });
    h.order.length = 0;
    await runScheduledTasksCron();
    expect(h.busSweep).toHaveBeenCalledTimes(1);
    expect(h.order.slice(-3)).toEqual([
      "due-threads",
      "reconcile",
      "agent-bus",
    ]);
  });

  it("still runs the sweep when the due-threads step throws", async () => {
    h.dueThreads.mockRejectedValue(new Error("db down"));
    await expect(runScheduledTasksCron()).rejects.toThrow("db down");
    expect(h.busSweep).toHaveBeenCalledTimes(1);
  });

  it("a throwing sweep is logged and swallowed", async () => {
    h.busSweep.mockRejectedValue(new Error("bus down"));
    await expect(runScheduledTasksCron()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "[cron:agent-bus] sweep failed (non-fatal)",
      expect.any(Error),
    );
  });
});
