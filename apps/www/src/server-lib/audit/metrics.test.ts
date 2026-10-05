import { describe, expect, it } from "vitest";

import {
  computeSelfHealMetrics,
  type MetricsAttempt,
  type MetricsFinding,
} from "./metrics";

const BOT = "automata-app[bot]";
const OWNER = "repo-owner";

let seq = 0;
function attempt(overrides: Partial<MetricsAttempt> = {}): MetricsAttempt {
  seq += 1;
  return {
    findingId: `f${seq}`,
    phase: "closed",
    prNumber: seq,
    prState: "closed",
    readyAt: null,
    mergedAt: null,
    mergedBy: null,
    humanCommitCount: null,
    regression: null,
    infraRefunded: false,
    ...overrides,
  };
}

function merged(
  mergedBy: string | null,
  overrides: Partial<MetricsAttempt> = {},
): MetricsAttempt {
  return attempt({
    prState: "merged",
    readyAt: "2026-09-01T00:00:00.000Z",
    mergedAt: "2026-09-02T00:00:00.000Z",
    mergedBy,
    ...overrides,
  });
}

function windowRecord(
  overrides: Partial<{
    reverted: boolean;
    followupShas: string[];
    reopened: boolean;
    windowComplete: boolean;
  }> = {},
) {
  return {
    reverted: false,
    followupShas: [],
    reopened: false,
    checkedAt: "2026-10-02T00:00:00.000Z",
    windowComplete: true,
    ...overrides,
  };
}

function compute(
  attempts: MetricsAttempt[],
  {
    findings = [] as MetricsFinding[],
    triggerLogins = [BOT, OWNER],
    admissionDeferrals = 0,
  } = {},
) {
  return computeSelfHealMetrics({
    attempts,
    findings,
    triggerLogins,
    admissionDeferrals,
  });
}

describe("computeSelfHealMetrics", () => {
  it("counts only merges by someone other than the bot or the automation owner", () => {
    const metrics = compute([
      merged(BOT),
      merged(OWNER),
      merged("a-reviewer"),
      attempt({ prState: "closed" }),
    ]);
    expect(metrics.prsOpened).toBe(4);
    expect(metrics.merged).toBe(3);
    expect(metrics.mergedByNonTrigger).toBe(1);
    expect(metrics.mergeRate).toBe(0.25);
    expect(metrics.mergeRateBasis).toBe("bot-and-owner");
  });

  it("login comparison ignores case; an unknown merger is not a non-trigger merge", () => {
    const metrics = compute([
      merged("Automata-App[bot]"),
      merged("REPO-OWNER"),
      merged(null),
      merged("someone"),
    ]);
    expect(metrics.mergedByNonTrigger).toBe(1);
  });

  it("basis is bot-only without an owner login, and the owner's merge then counts", () => {
    const metrics = compute([merged(BOT), merged(OWNER)], {
      triggerLogins: [BOT],
    });
    expect(metrics.mergeRateBasis).toBe("bot-only");
    expect(metrics.mergedByNonTrigger).toBe(1);
    expect(metrics.mergeRate).toBe(0.5);
  });

  it("empty logins do not count toward the basis", () => {
    expect(compute([], { triggerLogins: [BOT, "", "  "] }).mergeRateBasis).toBe(
      "bot-only",
    );
  });

  it("merge and expiry rates use decided PRs only (merged, closed or expired)", () => {
    const metrics = compute([
      merged("a-reviewer"),
      attempt({ prState: "expired" }),
      attempt({ prState: "draft", phase: "ci_pending" }),
      attempt({ prState: "ready", phase: "ready", readyAt: new Date() }),
      attempt({ prNumber: null, prState: null }),
      attempt({ prNumber: null, prState: "open_failed" }),
    ]);
    expect(metrics.prsOpened).toBe(4);
    expect(metrics.ready).toBe(2);
    expect(metrics.mergeRate).toBe(0.5);
    expect(metrics.expiredRate).toBe(0.5);
  });

  it("human-edit ratio is over merged PRs whose commit count is known", () => {
    const metrics = compute([
      merged("a", { humanCommitCount: 2 }),
      merged("b", { humanCommitCount: 0 }),
      merged("c", { humanCommitCount: 0 }),
      merged("d", { humanCommitCount: 1 }),
      merged("e", { humanCommitCount: null }),
      attempt({ humanCommitCount: 5 }),
    ]);
    expect(metrics.humanEditRatio).toBe(0.5);
  });

  it("reopen and regression rates count only merged fixes whose 30-day window is complete", () => {
    const metrics = compute([
      merged("a", { regression: windowRecord({ reopened: true }) }),
      merged("b", { regression: windowRecord({ reverted: true }) }),
      merged("c", { regression: windowRecord({ followupShas: ["abc"] }) }),
      merged("d", { regression: windowRecord() }),
      merged("e", {
        regression: windowRecord({ reverted: true, windowComplete: false }),
      }),
      merged("f", { regression: null }),
      merged("g", { regression: { reverted: "yes" } }),
    ]);
    expect(metrics.reopenRate).toBe(0.25);
    expect(metrics.regressionRate30d).toBe(0.5);
  });

  it("zero denominators are null", () => {
    const metrics = compute([]);
    expect(metrics).toEqual({
      prsOpened: 0,
      ready: 0,
      merged: 0,
      mergedByNonTrigger: 0,
      mergeRate: null,
      humanEditRatio: null,
      reopenRate: null,
      regressionRate30d: null,
      meanAttemptsToClose: null,
      expiredRate: null,
      refunded: 0,
      counted: 0,
      admissionDeferrals: 0,
      mergeRateBasis: "bot-and-owner",
    });
    const openOnly = compute([
      attempt({ prState: "draft", phase: "ci_pending" }),
    ]);
    expect(openOnly.mergeRate).toBeNull();
    expect(openOnly.expiredRate).toBeNull();
    expect(compute([merged("x")]).humanEditRatio).toBeNull();
  });

  it("mean attempts to close is over resolved findings that had at least one counted attempt", () => {
    const metrics = compute([], {
      findings: [
        { id: "a", status: "resolved", attempts: 1 },
        { id: "b", status: "resolved", attempts: 2 },
        { id: "c", status: "resolved", attempts: 0 },
        { id: "d", status: "open", attempts: 3 },
        { id: "e", status: "needs_human", attempts: 3 },
      ],
    });
    expect(metrics.meanAttemptsToClose).toBe(1.5);
  });

  it("splits finished attempts into refunded and counted; in-flight attempts are neither", () => {
    const metrics = compute([
      attempt({ infraRefunded: true }),
      attempt({ infraRefunded: true }),
      attempt({ infraRefunded: false }),
      merged("x"),
      attempt({ phase: "ci_pending", prState: "draft" }),
    ]);
    expect(metrics.refunded).toBe(2);
    expect(metrics.counted).toBe(2);
  });

  it("passes admission deferrals through", () => {
    expect(compute([], { admissionDeferrals: 7 }).admissionDeferrals).toBe(7);
  });

  it("accepts Date and ISO string timestamps alike (the export is JSON)", () => {
    const asDate = compute([
      merged("x", { mergedAt: new Date("2026-09-02T00:00:00Z") }),
    ]);
    const asString = compute([merged("x")]);
    expect(asDate).toEqual(asString);
  });
});
