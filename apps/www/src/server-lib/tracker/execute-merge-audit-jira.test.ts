import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeMergeAudit,
  type MarkerCommentMode,
  type MarkerCommentResult,
} from "./execute-merge-audit";
import type { JiraTrackerConfig } from "./tracker-config";
import {
  type TrackerClient,
  type TrackerIssue,
  TrackerRequestError,
  TrackerTransitionError,
} from "./youtrack-client";

const PR_URL = "https://github.com/acme-inc/acme-core/pull/7";
const DEFAULT_WORKFLOW = [
  "To Do",
  "In Progress",
  "Code Review",
  "Ready for QA",
  "Done",
];

const config = (writes: "off" | "live"): JiraTrackerConfig => ({
  kind: "jira",
  baseUrl: "https://acme.atlassian.net",
  username: "bot@acme.example",
  token: "jira-secret",
  projects: ["ACME"],
  writes,
});

const issue = (
  key: string,
  over: Partial<TrackerIssue> = {},
): TrackerIssue => ({
  key,
  summary: `${key} summary`,
  description: "",
  stage: "In Progress",
  resolved: false,
  links: [],
  comments: [],
  ...over,
});

/**
 * In-memory Jira: statuses move only through the transitions the workflow
 * offers, with the real client's no-match behaviour.
 */
function fakeJira(issues: TrackerIssue[], workflow = DEFAULT_WORKFLOW) {
  const store = new Map(
    issues.map((entry) => [entry.key, structuredClone(entry)]),
  );
  const transitions: Array<{ key: string; to: string }> = [];
  const added: Array<{ key: string; text: string }> = [];
  const read = (key: string) => {
    const found = store.get(key);
    if (!found) throw new TrackerRequestError("issue fetch", 404);
    return found;
  };
  const reachable = (key: string) =>
    workflow.filter((name) => name !== read(key).stage);
  const client: TrackerClient = {
    getIssue: vi.fn(async (key: string) => structuredClone(read(key))),
    getStage: vi.fn(async (key: string) => read(key).stage),
    listStageTargets: vi.fn(async (key: string) => reachable(key)),
    setStage: vi.fn(async (key: string, stage: string) => {
      const to = reachable(key).find(
        (name) => name.toLowerCase() === stage.toLowerCase(),
      );
      if (!to) throw new TrackerTransitionError(stage);
      transitions.push({ key, to });
      read(key).stage = to;
    }),
    addComment: vi.fn(async (key: string, text: string) => {
      added.push({ key, text });
      read(key).comments.push({ id: `c${added.length}`, text });
    }),
    issueUrl: (key: string) => `https://acme.atlassian.net/browse/${key}`,
  };
  return { client, transitions, added, store };
}

function fakeComments() {
  const upserts: Array<{ body: string; mode: MarkerCommentMode }> = [];
  let existing = false;
  return {
    upserts,
    client: {
      upsertMarkerComment: vi.fn(
        async (
          _marker: string,
          body: string,
          mode: MarkerCommentMode,
        ): Promise<MarkerCommentResult> => {
          upserts.push({ body, mode });
          if (!existing) {
            existing = true;
            return "created";
          }
          return mode === "create-only" ? "kept_existing" : "updated";
        },
      ),
    },
  };
}

const logger = { info: vi.fn(), warn: vi.fn() };

const intentText = (tickets: unknown[]) =>
  "Audit complete.\n\n```json\n" +
  JSON.stringify({ kind: "pr-merged-audit", pr: 7, tickets }) +
  "\n```";

const ticketAudit = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  acSource: "formal",
  criteria: [
    { id: "AC-1", text: "first", verdict: "met", evidence: "a.ts:1" },
    { id: "AC-2", text: "second", verdict: "not_met" },
  ],
  taskComplete: true,
  ...over,
});

async function run({
  issues,
  writes,
  audit = ticketAudit("ACME-1"),
  workflow,
}: {
  issues: TrackerIssue[];
  writes: "off" | "live";
  audit?: unknown;
  workflow?: string[];
}) {
  const tracker = fakeJira(issues, workflow);
  const comments = fakeComments();
  const outcome = await executeMergeAudit({
    prNumber: 7,
    pr: {
      title: "feat(ACME-1): void predictions",
      body: "Implements the void flow.",
      headBranch: "ACME-1-void",
      htmlUrl: PR_URL,
      mergedBy: "octocat",
    },
    terminalText: intentText([audit]),
    config: config(writes),
    tracker: tracker.client,
    comments: comments.client,
    logger,
  });
  return { outcome, tracker, comments };
}

/** ACME-1 blocks ACME-2; ACME-2 is in Backlog with ACME-1 as its only blocker. */
const blockedPair = (): TrackerIssue[] => [
  issue("ACME-1", {
    links: [
      {
        direction: "OUTWARD",
        typeName: "Blocks",
        verb: "blocks",
        issues: [
          { key: "ACME-2", summary: "next", stage: "Backlog", resolved: false },
        ],
      },
    ],
  }),
  issue("ACME-2", {
    stage: "Backlog",
    links: [
      {
        direction: "INWARD",
        typeName: "Blocks",
        verb: "is blocked by",
        issues: [
          {
            key: "ACME-1",
            summary: "this",
            stage: "In Progress",
            resolved: false,
          },
        ],
      },
    ],
  }),
];

describe("executeMergeAudit with a Jira tracker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shadow: reports the Ready for QA move and the dependant, writes nothing", async () => {
    const { outcome, tracker, comments } = await run({
      issues: blockedPair(),
      writes: "off",
      workflow: [...DEFAULT_WORKFLOW, "Backlog"],
    });
    expect(outcome).toEqual({
      outcome: "posted",
      tickets: 1,
      audited: 1,
      transitions: 0,
      live: false,
    });
    expect(tracker.transitions).toEqual([]);
    expect(tracker.added).toEqual([]);
    expect(tracker.client.setStage).not.toHaveBeenCalled();
    const body = comments.upserts[0]!.body;
    expect(body).toContain("Shadow mode");
    expect(body).toContain("would move to `Ready for QA`");
    expect(body).toContain("https://acme.atlassian.net/browse/ACME-1");
    expect(body).toContain("Would promote → To Do (final blocker merged)");
  });

  it("live: complete → Ready for QA, ticket record, dependant promoted", async () => {
    const { outcome, tracker, comments } = await run({
      issues: blockedPair(),
      writes: "live",
    });
    expect(outcome).toEqual({
      outcome: "posted",
      tickets: 1,
      audited: 1,
      transitions: 1,
      live: true,
    });
    expect(tracker.transitions).toEqual([
      { key: "ACME-1", to: "Ready for QA" },
      { key: "ACME-2", to: "To Do" },
    ]);
    expect(tracker.added.map((entry) => entry.key)).toEqual([
      "ACME-2",
      "ACME-1",
    ]);
    expect(tracker.added[1]!.text).toContain(`PR merged: ${PR_URL}`);
    expect(tracker.added[1]!.text).toContain(
      "Stage: In Progress → Ready for QA.",
    );
    const body = comments.upserts[0]!.body;
    expect(body).toContain("`In Progress` → `Ready for QA`");
    expect(body).toContain("Promoted → To Do (final blocker merged)");
  });

  it("live: work remaining → Code Review, dependants left alone", async () => {
    const { tracker, comments } = await run({
      issues: blockedPair(),
      writes: "live",
      audit: ticketAudit("ACME-1", {
        taskComplete: false,
        remaining: "Part 2 of 2 pending",
      }),
    });
    expect(tracker.transitions).toEqual([{ key: "ACME-1", to: "Code Review" }]);
    expect(tracker.store.get("ACME-2")!.stage).toBe("Backlog");
    expect(comments.upserts[0]!.body).toContain("Part 2 of 2 pending");
  });

  it("live: no QA status in the workflow → falls back to a review status", async () => {
    const { tracker, comments } = await run({
      issues: [issue("ACME-1")],
      writes: "live",
      workflow: ["To Do", "In Progress", "In Review", "Done"],
    });
    expect(tracker.transitions).toEqual([{ key: "ACME-1", to: "In Review" }]);
    expect(comments.upserts[0]!.body).toContain(
      "No `Ready for QA` transition exists; moved to `In Review` instead.",
    );
  });

  it("live: fallback to review is not completion → no dependant probe", async () => {
    const { tracker, comments } = await run({
      issues: blockedPair(),
      writes: "live",
      workflow: ["Backlog", "To Do", "In Progress", "In Review", "Done"],
    });
    expect(tracker.transitions).toEqual([{ key: "ACME-1", to: "In Review" }]);
    expect(tracker.store.get("ACME-2")!.stage).toBe("Backlog");
    expect(tracker.added.map((entry) => entry.key)).toEqual(["ACME-1"]);
    const body = comments.upserts[0]!.body;
    expect(body).not.toContain("ACME-2");
    expect(body).toContain(
      "No `Ready for QA` transition exists; moved to `In Review` instead.",
    );
  });

  it("live: a case variant of the QA status is the target, not a fallback", async () => {
    const { tracker, comments } = await run({
      issues: blockedPair(),
      writes: "live",
      workflow: ["Backlog", "To Do", "In Progress", "READY FOR QA", "Done"],
    });
    expect(tracker.transitions).toEqual([
      { key: "ACME-1", to: "READY FOR QA" },
      { key: "ACME-2", to: "To Do" },
    ]);
    expect(comments.upserts[0]!.body).not.toContain("transition exists");
  });

  it("live: no acceptable transition → nothing written to the status, error reported", async () => {
    const { outcome, tracker, comments } = await run({
      issues: [issue("ACME-1")],
      writes: "live",
      workflow: ["To Do", "In Progress", "Done"],
    });
    expect(tracker.client.setStage).not.toHaveBeenCalled();
    expect(tracker.store.get("ACME-1")!.stage).toBe("In Progress");
    expect(outcome).toMatchObject({ outcome: "posted", transitions: 0 });
    expect(comments.upserts[0]!.body).toContain(
      "Tracker error: no transition to Ready for QA is available",
    );
  });
});
