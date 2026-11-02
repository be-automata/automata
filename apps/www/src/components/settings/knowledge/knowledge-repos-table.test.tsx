import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { KnowledgeRepoDto, KnowledgeViewer } from "./knowledge-form";
import {
  KnowledgeReposTableView,
  type KnowledgeReposTableViewProps,
} from "./knowledge-repos-table";

// Same stubs as knowledge-section.test.tsx: vitest uses the classic JSX runtime.
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div className={className} data-skeleton="" />
  ),
}));
vi.mock("@/components/settings/settings-row", () => ({
  SettingsSection: ({
    label,
    description,
    children,
  }: {
    label: string;
    description?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <section>
      <h3>{label}</h3>
      <p>{description}</p>
      {children}
    </section>
  ),
}));

const NOW = new Date("2026-10-10T12:00:00.000Z");
const FULL_SHA = "abcdef0123456789abcdef0123456789abcdef01";

const MEMBER: KnowledgeViewer = { isOrgAdmin: false, isPlatformAdmin: false };
const ADMIN: KnowledgeViewer = { isOrgAdmin: true, isPlatformAdmin: false };
const PLATFORM: KnowledgeViewer = { isOrgAdmin: false, isPlatformAdmin: true };

function repo(over: Partial<KnowledgeRepoDto> = {}): KnowledgeRepoDto {
  return {
    repoFullName: "example-org/example-repo",
    defaultBranch: "main",
    lastPushAt: "2026-10-10T09:00:00.000Z",
    lastSha: FULL_SHA,
    observedHeadSha: FULL_SHA,
    latestIntent: {
      id: "intent-1",
      state: "processed",
      attempts: 1,
      lastErrorCode: null,
      targetSha: FULL_SHA,
      createdAt: "2026-10-10T09:00:00.000Z",
      processedAt: "2026-10-10T09:01:00.000Z",
    },
    pending: false,
    pendingSince: null,
    affectedClaimCount: 0,
    excludedDocClaims: 0,
    excludedInvalidClaims: 0,
    ticketClaimCount: 0,
    ticketSource: null,
    ...over,
  };
}

const failedRepo = repo({
  repoFullName: "example-org/failing-repo",
  latestIntent: {
    id: "intent-failed",
    state: "failed",
    attempts: 8,
    lastErrorCode: "max_attempts",
    targetSha: FULL_SHA,
    createdAt: "2026-10-10T09:00:00.000Z",
    processedAt: null,
  },
});

function render(over: Partial<KnowledgeReposTableViewProps> = {}): string {
  return renderToStaticMarkup(
    <KnowledgeReposTableView
      status="ready"
      repos={[repo()]}
      viewer={ADMIN}
      now={NOW}
      onRetry={() => undefined}
      onDiagnose={() => undefined}
      onReload={() => undefined}
      diagnose={null}
      {...over}
    />,
  );
}

describe("KnowledgeReposTableView", () => {
  it("says 'never seen a push' for a repo with no push, never live", () => {
    const html = render({ repos: [repo({ lastPushAt: null })] });
    expect(html).toContain("never seen a push");
    expect(html).not.toMatch(/\blive\b|\bOK\b/);
  });

  it("shows a processed row as reconciled with the short sha and a full-sha tooltip", () => {
    const html = render();
    expect(html).toContain("reconciled");
    expect(html).toContain("abcdef0");
    expect(html).toContain(`title="${FULL_SHA}"`);
    expect(html).toContain("1/8");
  });

  it("shows pending validation with the affected claim count", () => {
    const html = render({
      repos: [
        repo({
          pending: true,
          pendingSince: "2026-10-10T10:00:00.000Z",
          affectedClaimCount: 3,
        }),
      ],
    });
    expect(html).toContain("pending validation since 2h ago");
    expect(html).toContain("3 claims");
  });

  it("shows processing as reconciling and a pending intent as queued", () => {
    const processing = repo({
      latestIntent: { ...repo().latestIntent!, state: "processing" },
    });
    expect(render({ repos: [processing] })).toContain("reconciling");
    const queued = repo({
      latestIntent: { ...repo().latestIntent!, state: "pending" },
    });
    expect(render({ repos: [queued] })).toContain("queued");
  });

  it("shows a failed row with attempts and the error code", () => {
    const html = render({ repos: [failedRepo] });
    expect(html).toContain("failed");
    expect(html).toContain("8/8");
    expect(html).toContain("max_attempts");
  });

  it("hides Retry and Diagnose from members and shows the read-only note", () => {
    const html = render({ repos: [failedRepo], viewer: MEMBER });
    expect(html).not.toContain("knowledge-repo-retry");
    expect(html).not.toContain("knowledge-repo-diagnose");
    expect(html).toContain("knowledge-repos-readonly-note");
  });

  it.each([
    ["org admin", ADMIN],
    ["platform admin", PLATFORM],
  ])(
    "shows Retry on failed rows only and Diagnose on all rows for a %s",
    (_n, viewer) => {
      const html = render({ repos: [failedRepo, repo()], viewer });
      expect(html.match(/knowledge-repo-retry/g)).toHaveLength(1);
      expect(html.match(/knowledge-repo-diagnose/g)).toHaveLength(2);
      expect(html).not.toContain("knowledge-repos-readonly-note");
    },
  );

  it("renders returned deliveries as a nested register under the diagnosed row", () => {
    const html = render({
      diagnose: {
        repoFullName: "example-org/example-repo",
        status: "success",
        deliveries: [
          {
            guid: "g1",
            event: "push",
            action: null,
            statusCode: 200,
            deliveredAt: "2026-10-10T08:30:00.000Z",
            redelivery: false,
          },
        ],
      },
    });
    expect(html).toContain("knowledge-repo-deliveries");
    expect(html).toContain("push");
    expect(html).toContain("200");
    expect(html).toContain("2026-10-10 08:30");
  });

  it("renders no deliveries register when nothing was diagnosed", () => {
    expect(render()).not.toContain("knowledge-repo-deliveries");
  });

  it("renders skeleton rows while loading", () => {
    const html = render({ status: "loading", repos: [] });
    expect(html).toContain("knowledge-repos-skeleton");
    expect(html).toContain("h-8");
  });

  it("renders an inline error with a retry action", () => {
    const html = render({ status: "error", repos: [], errorMessage: "boom" });
    expect(html).toContain("knowledge-repos-error");
    expect(html).toContain("boom");
    expect(html).toContain("Retry");
  });

  it("renders one sentence for an empty list", () => {
    const html = render({ repos: [] });
    expect(html).toContain("knowledge-repos-empty");
    expect(html).toContain("No repositories are onboarded yet.");
  });

  it("uses no cards, pills or colored left borders", () => {
    const html = render({ repos: [failedRepo, repo()] });
    // bg-card on the shared outline Button is a surface token, not a card.
    expect(html).not.toMatch(/rounded-full|border-l-|data-slot="card"/);
  });
});
