import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div className={className} data-skeleton="" />
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...rest }: any) => <button {...rest}>{children}</button>,
}));
vi.mock("./usage-chart", () => ({ UsageChart: () => null }));
vi.mock("@/queries/agent-activity-queries", () => ({
  useAgentActivity: vi.fn(),
}));
vi.mock("@/queries/organization-queries", () => ({
  useActiveOrganization: vi.fn(),
}));

import { StatsView } from "./main";

const org = { id: "org_acme", name: "Acme", logo: null };

function render(props: Partial<React.ComponentProps<typeof StatsView>>) {
  return renderToStaticMarkup(
    <StatsView
      organization={org}
      data={undefined}
      isLoading={false}
      isError={false}
      onRetry={() => {}}
      runningNow={2}
      scope="everyone"
      onScopeChange={() => {}}
      range="7"
      onRangeChange={() => {}}
      {...props}
    />,
  );
}

const breakdowns = {
  byRepo: [
    {
      repoFullName: "acme/api",
      tasks: 4,
      merged: 2,
      errored: 1,
      lastActivityAt: new Date(),
      daily: [1, 0, 3],
    },
  ],
  bySource: { web: 3, automation: 1, slack: 0, github: 0, cli: 0 },
  byMember: [],
  funnel: { started: 4, completed: 3, openedPR: 2, merged: 2 },
  errored: 1,
  notFinished: [{ label: "Superseded", count: 1 }],
};

describe("StatsView", () => {
  it("names the org and shows the outcome breakdowns", () => {
    const html = render({
      data: {
        dailyStats: [],
        summary: { totalThreadsCreated: 4, totalPRsMerged: 2 },
        breakdowns,
      },
    });
    expect(html).toContain("Usage");
    expect(html).toContain("Acme");
    expect(html).toContain("acme/api");
    expect(html).toContain("75%");
    expect(html).toContain("From task to merged PR");
    expect(html).toContain("Superseded");
    expect(html).toContain("Web 75% · Automation 25%");
  });

  it("explains own-only totals without an org, and hides org tables", () => {
    const html = render({
      organization: null,
      data: {
        dailyStats: [],
        summary: { totalThreadsCreated: 1, totalPRsMerged: 0 },
        breakdowns: null,
      },
    });
    expect(html).toContain("Choose an organization to see its usage.");
    expect(html).not.toContain("From task to merged PR");
  });

  it("offers a retry on failure", () => {
    expect(render({ isError: true })).toContain(
      "Usage statistics could not be loaded.",
    );
  });
});
