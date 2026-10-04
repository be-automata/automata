import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  SelfHealActivityDto,
  SelfHealBreakerDto,
} from "@/queries/self-heal-queries";
import {
  KILLED_MESSAGE,
  MISSING_PERMISSION_MESSAGE,
  NO_RUNS_MESSAGE,
  PAUSED_MESSAGE,
  SelfHealActivityView,
  churnPercent,
  issueUrl,
  topSkippedReasons,
} from "./self-heal-activity";

// The app compiles JSX with the automatic runtime; vitest here uses the
// classic one, so wrappers without an explicit React import are stubbed.
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div className={className} data-skeleton="" />
  ),
}));

const REPO = "acme/api";

function closed(
  scopeKind: SelfHealBreakerDto["scopeKind"],
  scopeKey: string,
): SelfHealBreakerDto {
  return {
    scopeKind,
    scopeKey,
    state: "closed",
    openUntil: null,
    lastTripReason: null,
  };
}

function activity(
  overrides: Partial<SelfHealActivityDto> = {},
): SelfHealActivityDto {
  return {
    effective: { mode: "dry-run", reason: "mode_dry_run" },
    runs: [],
    findings: [],
    outbox: { pending: 0, failed: 0, oldestPendingAt: null },
    breakers: {
      repo: {
        loopAudit: closed("loop_audit", REPO),
        loopFix: closed("loop_fix", REPO),
      },
      installation: [],
    },
    adminLog: [],
    churn: [],
    ...overrides,
  };
}

function render(
  data: SelfHealActivityDto | null,
  scope: "org" | "repo" = "repo",
  extra: Partial<React.ComponentProps<typeof SelfHealActivityView>> = {},
): string {
  return renderToStaticMarkup(
    <SelfHealActivityView
      data={data}
      repoFullName={REPO}
      scope={scope}
      onReset={() => {}}
      {...extra}
    />,
  );
}

describe("SelfHealActivityView", () => {
  it("shows the empty state and the effective mode with its reason", () => {
    const html = render(activity());
    expect(html).toContain(NO_RUNS_MESSAGE);
    expect(html).toContain("dry-run");
    expect(html).toContain("mode_dry_run");
  });

  it("renders runs with would_ decisions verbatim and findings with issue links", () => {
    const html = render(
      activity({
        runs: [
          {
            id: "r1",
            createdAt: "2026-10-04T10:00:00.000Z",
            mode: "dry-run",
            outcome: "dry_run",
            createdCount: 2,
            updatedCount: 1,
            closedCount: 0,
            skipped: { cooldown: 4, cap: 2 },
            decisions: [
              {
                fingerprint: "abcdef0123456789",
                decision: "would_create",
                reason: "new_finding",
              },
            ],
          },
        ],
        findings: [
          {
            id: "f1",
            ruleId: "SEC-1",
            severity: "high",
            status: "open",
            issueNumber: 42,
            attempts: 1,
            consecutiveCheckPasses: 3,
            lastDecision: "update",
            lastDecisionReason: "still_failing",
          },
        ],
      }),
    );
    expect(html).toContain("abcdef01 would_create: new_finding");
    expect(html).toContain("cooldown ×4, cap ×2");
    expect(html).toContain("2/1/0");
    expect(html).toContain(`href="https://github.com/${REPO}/issues/42"`);
    expect(html).toContain("#42");
    expect(html).toContain("SEC-1");
    expect(html).toContain("update: still_failing");
  });

  it("renders the missing-permission and killed outcomes in words", () => {
    const run = {
      id: "r",
      createdAt: "t",
      mode: "on",
      createdCount: 0,
      updatedCount: 0,
      closedCount: 0,
      skipped: null,
      decisions: null,
    };
    const html = render(
      activity({
        runs: [
          { ...run, id: "r1", outcome: "missing-permission" },
          { ...run, id: "r2", outcome: "killed" },
        ],
      }),
    );
    expect(html).toContain(MISSING_PERMISSION_MESSAGE);
    expect(html).toContain(KILLED_MESSAGE);
  });

  it("shows a red banner for an open github_write breaker with reason, open_until and Reset", () => {
    const html = render(
      activity({
        breakers: {
          repo: {
            loopAudit: closed("loop_audit", REPO),
            loopFix: closed("loop_fix", REPO),
          },
          installation: [
            {
              scopeKind: "github_write",
              scopeKey: "123",
              state: "open",
              openUntil: "2026-10-04T12:00:00.000Z",
              lastTripReason: "failure_ratio",
            },
          ],
        },
      }),
    );
    expect(html).toContain("self-heal-breaker-banner");
    expect(html).toContain("failure_ratio");
    expect(html).toContain("2026-10-04T12:00:00.000Z");
    expect(html).toContain("Reset breaker");
  });

  it("shows the paused banner for a paused_manual loop breaker", () => {
    const html = render(
      activity({
        breakers: {
          repo: {
            loopAudit: {
              ...closed("loop_audit", REPO),
              state: "paused_manual",
            },
            loopFix: closed("loop_fix", REPO),
          },
          installation: [],
        },
      }),
    );
    expect(html).toContain(PAUSED_MESSAGE);
  });

  it("shows the permission banner when the latch is set", () => {
    const html = render(
      activity({
        breakers: {
          repo: {
            loopAudit: closed("loop_audit", REPO),
            loopFix: closed("loop_fix", REPO),
          },
          installation: [
            { ...closed("permission", "issues"), state: "paused_manual" },
          ],
        },
      }),
    );
    expect(html).toContain(MISSING_PERMISSION_MESSAGE);
  });

  it("shows no banner when every breaker is closed", () => {
    expect(render(activity())).not.toContain("self-heal-breaker-banner");
  });

  it("shows churn percentages and highlights those above 10%", () => {
    const html = render(
      activity({
        churn: [
          { fromRunId: "a", toRunId: "b", churn: 0.05 },
          { fromRunId: "b", toRunId: "c", churn: 0.25 },
        ],
      }),
    );
    expect(html).toContain("5%");
    expect(html).toContain("25%");
    expect(html).toContain('data-highlight="false"');
    expect(html).toContain('data-highlight="true"');
  });

  it("renders the outbox backlog", () => {
    const html = render(
      activity({
        outbox: { pending: 3, failed: 1, oldestPendingAt: null },
      }),
    );
    expect(html).toContain("3 pending, 1");
  });

  it("renders Drain at org scope only", () => {
    expect(render(activity(), "org", { onDrain: () => {} })).toContain("Drain");
    expect(render(activity(), "repo", { onDrain: () => {} })).not.toContain(
      "self-heal-drain",
    );
    expect(render(activity(), "org")).not.toContain("self-heal-drain");
  });

  it("shows the drain result, including failed lookups", () => {
    const html = render(activity(), "org", {
      onDrain: () => {},
      drainResult: {
        killSwitchSet: true,
        cancelled: ["t1"],
        lookupFailed: ["t2"],
        cancelFailed: [],
        nothingInFlight: false,
      },
    });
    expect(html).toContain("Cancelled 1 thread(s)");
    expect(html).toContain("Lookup failed for 1 thread(s)");
  });

  it("still renders Drain at org scope with no repo data", () => {
    const html = renderToStaticMarkup(
      <SelfHealActivityView
        data={null}
        repoFullName={null}
        scope="org"
        onDrain={() => {}}
        onReset={() => {}}
      />,
    );
    expect(html).toContain("self-heal-drain");
    expect(html).not.toContain(NO_RUNS_MESSAGE);
  });
});

describe("helpers", () => {
  it("formats issue links, percentages and skipped reasons", () => {
    expect(issueUrl("a/b", 7)).toBe("https://github.com/a/b/issues/7");
    expect(churnPercent(0.126)).toBe("13%");
    expect(topSkippedReasons({ count: 2 })).toEqual(["count ×2"]);
    expect(topSkippedReasons(null)).toEqual([]);
    expect(topSkippedReasons({ a: 1, b: 5, c: 3, d: 2 })).toEqual([
      "b ×5",
      "c ×3",
      "d ×2",
    ]);
  });
});
