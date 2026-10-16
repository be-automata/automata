import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AgentActivityRow,
  OrgAgentActivity,
} from "@terragon/shared/model/agent-activity";

// The app compiles JSX with the automatic runtime; vitest here uses the
// classic one, so wrappers without an explicit React import are stubbed.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div className={className} data-skeleton="" />
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, asChild, ...rest }: any) =>
    asChild ? children : <button {...rest}>{children}</button>,
}));
vi.mock("@/queries/agent-activity-queries", () => ({
  useAgentActivity: vi.fn(),
}));
vi.mock("@/queries/organization-queries", () => ({
  useActiveOrganization: vi.fn(),
}));
vi.mock("@/server-actions/read-thread", () => ({ readThread: vi.fn() }));

import { AgentActivityBoardView } from "./agent-activity-board";

const org = { id: "org_acme", name: "Acme", logo: null };
const now = new Date("2026-10-16T12:00:00Z").getTime();

function row(overrides: Partial<AgentActivityRow>): AgentActivityRow {
  return {
    threadId: "t1",
    canOpen: true,
    title: "Fix the flaky drill",
    repoFullName: "acme/api",
    branchName: "fix/drill",
    prNumber: null,
    prStatus: null,
    state: { kind: "running", word: "working", reason: null },
    trigger: "web",
    automationId: null,
    automationName: null,
    starter: { kind: "you", name: "Ada" },
    startedAt: new Date(now - 65_000),
    updatedAt: new Date(now - 10_000),
    needsYou: null,
    ...overrides,
  };
}

function render(
  data: OrgAgentActivity | undefined,
  isLoading = false,
  isError = false,
) {
  return renderToStaticMarkup(
    <AgentActivityBoardView
      organization={org}
      data={data}
      isLoading={isLoading}
      isError={isError}
      onRetry={() => {}}
      onDismiss={async () => true}
      now={now}
      scope="everyone"
      onScopeChange={() => {}}
      who="all"
      onWhoChange={() => {}}
    />,
  );
}

const empty: OrgAgentActivity = {
  needsYou: [],
  active: [],
  recent: [],
  counts: { running: 0, waiting: 0, needsYou: 0 },
};

describe("AgentActivityBoardView", () => {
  it("shows skeleton rows while loading", () => {
    expect(render(undefined, true)).toContain('aria-busy="true"');
  });

  it("names the org in the empty state and hides Needs you", () => {
    const html = render(empty);
    expect(html).toContain("No agents running in Acme");
    expect(html).not.toContain("Needs you");
  });

  it("groups running work by repository with elapsed time and state word", () => {
    const html = render({
      ...empty,
      active: [
        row({ threadId: "a", repoFullName: "acme/api" }),
        row({
          threadId: "b",
          repoFullName: "acme/web",
          state: {
            kind: "waiting",
            word: "queued",
            reason: "waiting for a free slot",
          },
        }),
      ],
      counts: { running: 1, waiting: 1, needsYou: 0 },
    });
    expect(html).toContain("acme/api");
    expect(html).toContain("acme/web");
    expect(html).toContain("00:01:05");
    expect(html).toContain("queued");
    expect(html).toContain("waiting for a free slot");
    expect(html).toContain("1 running · 1 waiting");
  });

  it("never prints the title of a task the viewer cannot open", () => {
    const html = render({
      ...empty,
      active: [
        row({
          canOpen: false,
          title: null,
          branchName: null,
          starter: { kind: "member", name: "Grace" },
        }),
      ],
      counts: { running: 1, waiting: 0, needsYou: 0 },
    });
    expect(html).toContain("Private task");
    expect(html).not.toContain("/task/t1");
  });

  it("groups a masked repo under Other repositories without naming it", () => {
    const html = render({
      ...empty,
      active: [
        row({
          canOpen: false,
          title: null,
          repoFullName: null,
          branchName: null,
        }),
      ],
      counts: { running: 1, waiting: 0, needsYou: 0 },
    });
    expect(html).toContain("Other repositories");
    expect(html).not.toContain("acme/api");
  });

  it("explains a run that needs you and links the fix", () => {
    const html = render({
      ...empty,
      needsYou: [
        row({
          state: { kind: "needs-you", word: "error", reason: null },
          needsYou: {
            title: "Agent credential rejected",
            reason: "The agent's credential was rejected.",
            action: "reconnect-credential",
          },
        }),
      ],
      counts: { running: 0, waiting: 0, needsYou: 1 },
    });
    expect(html).toContain("Needs you");
    expect(html).toContain("Agent credential rejected");
    expect(html).toContain('href="/settings/agent"');
    expect(html).toContain("Dismiss");
  });

  it("offers a retry when activity fails to load", () => {
    const html = render(undefined, false, true);
    expect(html).toContain("Agent activity could not be loaded.");
    expect(html).toContain("Retry");
  });

  it("prints the PR status word next to its number", () => {
    const html = render({
      ...empty,
      active: [row({ prNumber: 363, prStatus: "open" })],
      counts: { running: 1, waiting: 0, needsYou: 0 },
    });
    expect(html).toContain("#363");
    expect(html).toContain(" open");
  });

  it("offers Dismiss only on the viewer's own failures", () => {
    const failing = (kind: "you" | "member") =>
      row({
        threadId: kind,
        state: { kind: "needs-you", word: "error", reason: null },
        starter: { kind, name: "Grace" },
        needsYou: {
          title: "Agent error",
          reason: "The agent stopped with an error.",
          action: "open-task",
        },
      });
    const html = render({
      ...empty,
      needsYou: [failing("member")],
      counts: { running: 0, waiting: 0, needsYou: 1 },
    });
    expect(html).toContain('href="/task/member"');
    expect(html).not.toContain("Dismiss");
  });
});
