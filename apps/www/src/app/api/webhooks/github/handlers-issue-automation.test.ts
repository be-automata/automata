import { beforeEach, describe, expect, it, vi } from "vitest";

import * as github from "@/lib/github";
import { getIssueAutomationsForRepo } from "@terragon/shared/model/automations";
import { runIssueAutomation } from "@/server-lib/automations";
import {
  clearFindingFixReady,
  markFindingFixReady,
} from "@/server-lib/audit/mark-fix-ready";
import { createSelfHealOctokit } from "@/server-lib/audit/self-heal-octokit";
import type { Automation } from "@terragon/shared/db/types";

import {
  handleIssueEvent,
  handleSelfHealIssueUnready,
  type IssueEvent,
  type IssueUnreadyEvent,
} from "./handlers";

vi.mock("@terragon/shared/model/automations", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@terragon/shared/model/automations")
  >()),
  getIssueAutomationsForRepo: vi.fn(),
}));
vi.mock("@/server-lib/automations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server-lib/automations")>()),
  runIssueAutomation: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/server-lib/audit/mark-fix-ready", () => ({
  markFindingFixReady: vi.fn(() =>
    Promise.resolve({ outcome: "marked", fingerprint: "abcdef0123456789" }),
  ),
  clearFindingFixReady: vi.fn(() =>
    Promise.resolve({ outcome: "cleared", fingerprint: "abcdef0123456789" }),
  ),
}));
vi.mock("@/server-lib/audit/self-heal-octokit", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server-lib/audit/self-heal-octokit")
  >()),
  createSelfHealOctokit: vi.fn(),
}));
vi.mock("@/server-lib/review/bot-login", () => ({
  resolveBotLogin: () => "terragon-app[bot]",
}));
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));
vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  getOctokitForApp: vi.fn(),
  getOctokitForUser: vi.fn(),
  getOctokitForUserOrThrow: vi.fn(),
  getOctokitForBackground: vi.fn(),
  getGitHubTokenForBackground: vi.fn(),
  getIsIssueAuthor: vi.fn(() => Promise.resolve(false)),
  getIssueAuthorGitHubUsername: vi.fn(),
  getIsPRAuthor: vi.fn(),
  updateGitHubPR: vi.fn(),
}));

const REPO = "owner/repo";
const BOT = "terragon-app[bot]";

const OCTOKIT_FACTORIES = [
  github.getOctokitForApp,
  github.getOctokitForUser,
  github.getOctokitForUserOrThrow,
  github.getOctokitForBackground,
  github.getGitHubTokenForBackground,
  github.getIsIssueAuthor,
  github.getIssueAuthorGitHubUsername,
  github.getIsPRAuthor,
  createSelfHealOctokit,
];

function automation(over: Partial<Automation> = {}): Automation {
  return {
    id: "auto-1",
    userId: "user-1",
    organizationId: "org-1",
    repoFullName: REPO,
    triggerType: "issue",
    triggerConfig: {
      filter: { includeAllAuthors: true },
      on: { open: true },
    },
    action: { type: "user_message", config: { message: {} } },
    ...over,
  } as unknown as Automation;
}

function auditFixAutomation(): Automation {
  return automation({
    triggerConfig: {
      filter: { labels: ["automata:auto-fix"] },
      on: { labeled: true },
    },
    action: {
      type: "skill_message",
      config: { skillName: "audit-fix" },
    },
  } as unknown as Partial<Automation>);
}

function issueEvent({
  action,
  labels = [],
  added,
  author = "octocat",
}: {
  action: "opened" | "labeled";
  labels?: string[];
  added?: string;
  author?: string;
}): IssueEvent {
  return {
    action,
    issue: {
      number: 42,
      user: { login: author },
      labels: labels.map((name) => ({ name })),
    },
    ...(added ? { label: { name: added } } : {}),
    repository: { full_name: REPO, owner: { login: "owner" } },
  } as unknown as IssueEvent;
}

function expectNoOctokit(): void {
  for (const factory of OCTOKIT_FACTORIES) {
    expect(factory).not.toHaveBeenCalled();
  }
}

describe("handleIssueAutomation — label filters and the self-heal trigger", () => {
  let logs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("legacy all-authors + opened runs the pinned call object", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue([automation()]);
    await handleIssueEvent(issueEvent({ action: "opened" }));
    expect(runIssueAutomation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runIssueAutomation).mock.calls[0]![0]).toEqual({
      automationId: "auto-1",
      userId: "user-1",
      issueEventAction: "opened",
      repoFullName: REPO,
      issueNumber: 42,
      source: "automated",
    });
  });

  it("legacy config ignores a labeled event", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue([automation()]);
    await handleIssueEvent(
      issueEvent({ action: "labeled", labels: ["bug"], added: "bug" }),
    );
    expect(runIssueAutomation).not.toHaveBeenCalled();
    expect(
      logs.some((l) => l.includes("not configured to trigger on labeled")),
    ).toBe(true);
  });

  it("labels filter matches case-insensitively and requires every label", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue([
      automation({
        triggerConfig: {
          filter: { includeAllAuthors: true, labels: ["Bug", "p1"] },
          on: { open: true },
        },
      }),
    ]);
    await handleIssueEvent(
      issueEvent({ action: "opened", labels: ["bug", "P1", "extra"] }),
    );
    expect(runIssueAutomation).toHaveBeenCalledTimes(1);

    vi.mocked(runIssueAutomation).mockClear();
    logs.length = 0;
    await handleIssueEvent(issueEvent({ action: "opened", labels: ["bug"] }));
    expect(runIssueAutomation).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("labels filter not satisfied"))).toBe(
      true,
    );
  });

  it("excludeLabels skips an opened issue carrying automata:finding", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue([
      automation({
        triggerConfig: {
          filter: {
            includeAllAuthors: true,
            excludeLabels: ["automata:finding"],
          },
          on: { open: true },
        },
      }),
    ]);
    await handleIssueEvent(
      issueEvent({ action: "opened", labels: ["Automata:Finding"] }),
    );
    expect(runIssueAutomation).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("labels filter not satisfied"))).toBe(
      true,
    );
  });

  it("excludeLabels skips a labeled event too", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue([
      automation({
        triggerConfig: {
          filter: {
            includeAllAuthors: true,
            labels: ["bug"],
            excludeLabels: ["wontfix"],
          },
          on: { labeled: true },
        },
      }),
    ]);
    await handleIssueEvent(
      issueEvent({
        action: "labeled",
        labels: ["bug", "wontfix"],
        added: "bug",
      }),
    );
    expect(runIssueAutomation).not.toHaveBeenCalled();
  });

  it("on.labeled fires only when the added label is a filter label", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue([
      automation({
        triggerConfig: {
          filter: { includeAllAuthors: true, labels: ["bug"] },
          on: { labeled: true },
        },
      }),
    ]);
    await handleIssueEvent(
      issueEvent({ action: "labeled", labels: ["bug", "docs"], added: "docs" }),
    );
    expect(runIssueAutomation).not.toHaveBeenCalled();

    await handleIssueEvent(
      issueEvent({ action: "labeled", labels: ["BUG"], added: "BUG" }),
    );
    expect(runIssueAutomation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runIssueAutomation).mock.calls[0]![0]).toEqual({
      automationId: "auto-1",
      userId: "user-1",
      issueEventAction: "labeled",
      repoFullName: REPO,
      issueNumber: 42,
      source: "automated",
    });
  });

  it("audit-fix + automata:auto-fix only marks the finding, with zero GitHub calls (RES-21)", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue([
      auditFixAutomation(),
    ]);
    const started = Date.now();
    await handleIssueEvent(
      issueEvent({
        action: "labeled",
        labels: ["automata:finding", "automata:auto-fix"],
        added: "automata:auto-fix",
        author: BOT,
      }),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(markFindingFixReady).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markFindingFixReady).mock.calls[0]![0]).toMatchObject({
      organizationId: "org-1",
      repoFullName: REPO,
      issueNumber: 42,
      issueAuthorLogin: BOT,
      botLogin: BOT,
    });
    expect(runIssueAutomation).not.toHaveBeenCalled();
    expectNoOctokit();
    expect(
      logs.some(
        (l) =>
          l.startsWith("[self-heal] v=1 org=org-1 repo=owner/repo") &&
          l.includes("decision=claim reason=marked"),
      ),
    ).toBe(true);
  });

  it("audit-fix ignores a non-filter label added to a ledger issue", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue([
      auditFixAutomation(),
    ]);
    await handleIssueEvent(
      issueEvent({
        action: "labeled",
        labels: ["automata:auto-fix", "documentation"],
        added: "documentation",
        author: BOT,
      }),
    );
    expect(markFindingFixReady).not.toHaveBeenCalled();
    expect(runIssueAutomation).not.toHaveBeenCalled();
    expectNoOctokit();
  });

  it("audit-fix passes a human author through for the DB to reject", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue([
      auditFixAutomation(),
    ]);
    vi.mocked(markFindingFixReady).mockResolvedValueOnce({
      outcome: "author_not_bot",
      fingerprint: "abcdef0123456789",
    });
    await handleIssueEvent(
      issueEvent({
        action: "labeled",
        labels: ["automata:auto-fix"],
        added: "automata:auto-fix",
        author: "mallory",
      }),
    );
    expect(runIssueAutomation).not.toHaveBeenCalled();
    expectNoOctokit();
    expect(logs.some((l) => l.includes("reason=author_not_bot"))).toBe(true);
  });
});

describe("handleSelfHealIssueUnready (R7)", () => {
  let logs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  function unready(
    action: "closed" | "unlabeled",
    removed?: string,
  ): IssueUnreadyEvent {
    return {
      action,
      issue: { number: 42, user: { login: BOT }, labels: [] },
      ...(removed ? { label: { name: removed } } : {}),
      repository: { full_name: REPO, owner: { login: "owner" } },
    } as unknown as IssueUnreadyEvent;
  }

  it("removing the trigger label clears readiness in the automation's org, with zero GitHub calls", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue([
      auditFixAutomation(),
      automation(),
    ]);
    await handleSelfHealIssueUnready(unready("unlabeled", "Automata:Auto-Fix"));
    expect(clearFindingFixReady).toHaveBeenCalledTimes(1);
    expect(vi.mocked(clearFindingFixReady).mock.calls[0]![0]).toMatchObject({
      organizationId: "org-1",
      repoFullName: REPO,
      issueNumber: 42,
    });
    expect(runIssueAutomation).not.toHaveBeenCalled();
    expectNoOctokit();
    expect(
      logs.some((l) =>
        l.includes("decision=skip reason=unready_unlabeled_cleared"),
      ),
    ).toBe(true);
  });

  it("removing another label changes nothing", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue([
      auditFixAutomation(),
    ]);
    await handleSelfHealIssueUnready(unready("unlabeled", "documentation"));
    expect(clearFindingFixReady).not.toHaveBeenCalled();
    expectNoOctokit();
  });

  it("closing the issue clears readiness; a non-audit-fix automation is ignored", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue([
      auditFixAutomation(),
    ]);
    await handleSelfHealIssueUnready(unready("closed"));
    expect(clearFindingFixReady).toHaveBeenCalledTimes(1);
    expectNoOctokit();

    vi.mocked(clearFindingFixReady).mockClear();
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue([automation()]);
    await handleSelfHealIssueUnready(unready("closed"));
    expect(clearFindingFixReady).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockRejectedValue(new Error("db"));
    await expect(
      handleSelfHealIssueUnready(unready("closed")),
    ).resolves.toBeUndefined();
  });
});
