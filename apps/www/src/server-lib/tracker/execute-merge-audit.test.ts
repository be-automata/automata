import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeMergeAudit,
  type MarkerCommentMode,
  type MarkerCommentResult,
  type MergedPullRequest,
} from "./execute-merge-audit";
import { mergeAuditMarker } from "./merge-audit";
import type { TrackerConfig } from "./tracker-config";
import {
  type TrackerClient,
  type TrackerIssue,
  type TrackerLink,
  TrackerRequestError,
} from "./youtrack-client";

const PR_URL = "https://github.com/acme-inc/acme-core/pull/7";

const pr = (over: Partial<MergedPullRequest> = {}): MergedPullRequest => ({
  title: "feat(ACME-1): void predictions",
  body: "Implements the void flow.",
  headBranch: "ACME-1-void",
  htmlUrl: PR_URL,
  mergedBy: "octocat",
  ...over,
});

const config = (writes: "off" | "live"): TrackerConfig => ({
  kind: "youtrack",
  baseUrl: "https://acme.youtrack.cloud",
  token: "perm:secret",
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

const dependLink = (
  direction: "OUTWARD" | "INWARD",
  keys: Array<[string, string | null]>,
): TrackerLink => ({
  direction,
  typeName: "Depend",
  verb: direction === "OUTWARD" ? "is required for" : "depends on",
  issues: keys.map(([key, stage]) => ({
    key,
    summary: key,
    stage,
    resolved: false,
  })),
});

/**
 * In-memory tracker: `setStage` really changes the stored stage, so the
 * executor's read-back sees what a real instance would return.
 */
function fakeTracker(issues: TrackerIssue[]) {
  const store = new Map(
    issues.map((entry) => [entry.key, structuredClone(entry)]),
  );
  const commands: Array<{ key: string; command: string }> = [];
  const added: Array<{ key: string; text: string }> = [];
  const read = (key: string) => {
    const found = store.get(key);
    if (!found) throw new TrackerRequestError("issue fetch", 404);
    return found;
  };
  const client: TrackerClient = {
    getIssue: vi.fn(async (key: string) => structuredClone(read(key))),
    getStage: vi.fn(async (key: string) => read(key).stage),
    setStage: vi.fn(async (key: string, stage: string) => {
      commands.push({ key, command: `Stage ${stage}` });
      read(key).stage = stage;
    }),
    addComment: vi.fn(async (key: string, text: string) => {
      added.push({ key, text });
      store.get(key)?.comments.push({ id: `c${added.length}`, text });
    }),
    issueUrl: (key: string) => `https://acme.youtrack.cloud/issue/${key}`,
  };
  return { client, commands, added, store };
}

/**
 * In-memory PR comment thread with the real client's semantics: one bot marker
 * comment, `create-only` never touches an existing one.
 */
function fakeComments(existingBody: string | null = null) {
  const upserts: Array<{
    marker: string;
    body: string;
    mode: MarkerCommentMode;
  }> = [];
  const state = { body: existingBody };
  return {
    upserts,
    state,
    client: {
      upsertMarkerComment: vi.fn(
        async (
          marker: string,
          body: string,
          mode: MarkerCommentMode,
        ): Promise<MarkerCommentResult> => {
          upserts.push({ marker, body, mode });
          if (state.body === null) {
            state.body = body;
            return "created";
          }
          if (mode === "create-only") return "kept_existing";
          state.body = body;
          return "updated";
        },
      ),
    },
  };
}

const logger = { info: vi.fn(), warn: vi.fn() };

const intentText = (tickets: unknown[], prNumber = 7) =>
  "Audit complete.\n\n```json\n" +
  JSON.stringify({ kind: "pr-merged-audit", pr: prNumber, tickets }) +
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
  terminalText,
  prOver,
}: {
  issues: TrackerIssue[];
  writes: "off" | "live";
  terminalText: string;
  prOver?: Partial<MergedPullRequest>;
}) {
  const tracker = fakeTracker(issues);
  const comments = fakeComments();
  const outcome = await executeMergeAudit({
    prNumber: 7,
    pr: pr(prOver),
    terminalText,
    config: config(writes),
    tracker: tracker.client,
    comments: comments.client,
    logger,
  });
  return { outcome, tracker, comments };
}

describe("executeMergeAudit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("live: moves the primary to PR Merged, comments on the ticket, posts one PR comment", async () => {
    const { outcome, tracker, comments } = await run({
      issues: [issue("ACME-1")],
      writes: "live",
      terminalText: intentText([ticketAudit("ACME-1")]),
    });

    expect(outcome).toEqual({
      outcome: "posted",
      tickets: 1,
      audited: 1,
      transitions: 1,
      live: true,
    });
    expect(tracker.commands).toEqual([
      { key: "ACME-1", command: "Stage PR Merged" },
    ]);
    expect(tracker.added).toHaveLength(1);
    expect(tracker.added[0]!.key).toBe("ACME-1");
    expect(tracker.added[0]!.text).toContain(PR_URL);
    expect(tracker.added[0]!.text).toContain("AC-2");

    expect(comments.upserts).toHaveLength(1);
    expect(comments.upserts[0]!.marker).toBe(mergeAuditMarker(7));
    expect(comments.upserts[0]!.body).toContain("`In Progress` → `PR Merged`");
    expect(comments.upserts[0]!.body).toContain(
      "1/2 verifiable criteria met (50%)",
    );
  });

  it("moves regardless of a failing score", async () => {
    const { tracker } = await run({
      issues: [issue("ACME-1")],
      writes: "live",
      terminalText: intentText([
        ticketAudit("ACME-1", {
          criteria: [{ id: "AC-1", text: "x", verdict: "not_met" }],
        }),
      ]),
    });
    expect(tracker.commands).toEqual([
      { key: "ACME-1", command: "Stage PR Merged" },
    ]);
  });

  it("writes off: reads everything, posts the PR comment, makes ZERO tracker writes", async () => {
    const { outcome, tracker, comments } = await run({
      issues: [
        issue("ACME-1", {
          links: [dependLink("OUTWARD", [["ACME-20", "Backlog"]])],
        }),
        issue("ACME-20", {
          stage: "Backlog",
          links: [dependLink("INWARD", [["ACME-1", "In Progress"]])],
        }),
      ],
      writes: "off",
      terminalText: intentText([ticketAudit("ACME-1")]),
    });

    expect(outcome).toEqual({
      outcome: "posted",
      tickets: 1,
      audited: 1,
      transitions: 0,
      live: false,
    });
    expect(tracker.client.setStage).not.toHaveBeenCalled();
    expect(tracker.client.addComment).not.toHaveBeenCalled();
    const body = comments.upserts[0]!.body;
    expect(body).toContain("Shadow mode");
    expect(body).toContain("would move to `PR Merged`");
    expect(body).toContain("Would promote → To Do");
  });

  it("never demotes: a ticket already at PR Merged or later is commented, not moved", async () => {
    for (const stage of ["PR Merged", "Staging (TF)", "Done"]) {
      const { tracker, comments } = await run({
        issues: [issue("ACME-1", { stage, resolved: stage === "Done" })],
        writes: "live",
        terminalText: intentText([ticketAudit("ACME-1")]),
      });
      expect(tracker.commands, stage).toEqual([]);
      expect(tracker.added, stage).toHaveLength(1);
      expect(comments.upserts[0]!.body).toContain(`\`${stage}\``);
    }
  });

  it("no stage command ever targets Done, Staging (TF) or Won't do", async () => {
    const stages = [
      "Backlog",
      "To Do",
      "In Progress",
      "PR Review",
      "PR Merged",
      "Staging (TF)",
      "Done",
      "Won't do",
    ];
    for (const stage of stages) {
      for (const taskComplete of [true, false]) {
        const { tracker } = await run({
          issues: [
            issue("ACME-1", {
              stage,
              links: [dependLink("OUTWARD", [["ACME-20", "Backlog"]])],
            }),
            issue("ACME-20", {
              stage: "Backlog",
              links: [dependLink("INWARD", [["ACME-1", stage]])],
            }),
          ],
          writes: "live",
          terminalText: intentText([ticketAudit("ACME-1", { taskComplete })]),
        });
        for (const { command } of tracker.commands) {
          expect([
            "Stage PR Merged",
            "Stage In Progress",
            "Stage To Do",
          ]).toContain(command);
        }
      }
    }
  });

  it("holds a split ticket: no PR Merged, no dependant promotion", async () => {
    const { tracker, comments } = await run({
      issues: [
        issue("ACME-1", {
          stage: "To Do",
          links: [dependLink("OUTWARD", [["ACME-20", "Backlog"]])],
        }),
        issue("ACME-20", {
          stage: "Backlog",
          links: [dependLink("INWARD", [["ACME-1", "To Do"]])],
        }),
      ],
      writes: "live",
      terminalText: intentText([
        ticketAudit("ACME-1", {
          taskComplete: false,
          remaining: "Admin panel PR",
        }),
      ]),
    });
    expect(tracker.commands).toEqual([
      { key: "ACME-1", command: "Stage In Progress" },
    ]);
    expect(comments.upserts[0]!.body).toContain("Admin panel PR");
    expect(tracker.added.map((entry) => entry.key)).toEqual(["ACME-1"]);
  });

  it("open subtasks hold the parent and are listed", async () => {
    const { tracker, comments } = await run({
      issues: [
        issue("ACME-1", {
          links: [
            {
              direction: "OUTWARD",
              typeName: "Subtask",
              verb: "parent for",
              issues: [
                {
                  key: "ACME-2",
                  summary: "child",
                  stage: "To Do",
                  resolved: false,
                },
                {
                  key: "ACME-3",
                  summary: "done child",
                  stage: "Done",
                  resolved: true,
                },
              ],
            },
          ],
        }),
      ],
      writes: "live",
      terminalText: intentText([ticketAudit("ACME-1")]),
    });
    expect(tracker.commands).toEqual([]);
    expect(comments.upserts[0]!.body).toContain("| ACME-2 | subtask |");
    expect(comments.upserts[0]!.body).not.toContain("| ACME-3 |");
  });

  describe("dependant promotion", () => {
    it("promotes a Backlog dependant whose last blocker this was, and comments on it", async () => {
      const { tracker, comments } = await run({
        issues: [
          issue("ACME-1", {
            links: [dependLink("OUTWARD", [["ACME-20", "Backlog"]])],
          }),
          issue("ACME-20", {
            stage: "Backlog",
            links: [dependLink("INWARD", [["ACME-1", "In Progress"]])],
          }),
        ],
        writes: "live",
        terminalText: intentText([ticketAudit("ACME-1")]),
      });
      expect(tracker.commands).toEqual([
        { key: "ACME-1", command: "Stage PR Merged" },
        { key: "ACME-20", command: "Stage To Do" },
      ]);
      const siblingComment = tracker.added.find(
        (entry) => entry.key === "ACME-20",
      );
      expect(siblingComment?.text).toContain("Auto-promoted: Backlog → To Do");
      expect(siblingComment?.text).toContain(PR_URL);
      expect(comments.upserts[0]!.body).toContain(
        "Promoted → To Do (final blocker merged)",
      );
    });

    it("anti-vacuous guard: a dependant that does not list the merged ticket is only notified", async () => {
      const { tracker } = await run({
        issues: [
          issue("ACME-1", {
            links: [dependLink("OUTWARD", [["ACME-20", "Backlog"]])],
          }),
          issue("ACME-20", { stage: "Backlog", links: [] }),
        ],
        writes: "live",
        terminalText: intentText([ticketAudit("ACME-1")]),
      });
      expect(tracker.commands).toEqual([
        { key: "ACME-1", command: "Stage PR Merged" },
      ]);
      expect(
        tracker.added.find((entry) => entry.key === "ACME-20")?.text,
      ).toContain("Not promoted automatically");
    });

    it("does not promote while another blocker is open", async () => {
      const { tracker } = await run({
        issues: [
          issue("ACME-1", {
            links: [dependLink("OUTWARD", [["ACME-20", "Backlog"]])],
          }),
          issue("ACME-20", {
            stage: "Backlog",
            links: [
              dependLink("INWARD", [
                ["ACME-1", "In Progress"],
                ["ACME-5", "In Progress"],
              ]),
            ],
          }),
        ],
        writes: "live",
        terminalText: intentText([ticketAudit("ACME-1")]),
      });
      expect(tracker.commands.map((entry) => entry.key)).toEqual(["ACME-1"]);
    });

    it("two blockers: the dependant is promoted when the SECOND one merges", async () => {
      // ACME-1 merged earlier and sits at PR Merged (not Done). ACME-2 merges now.
      const { tracker } = await run({
        issues: [
          issue("ACME-2", {
            links: [dependLink("OUTWARD", [["ACME-20", "Backlog"]])],
          }),
          issue("ACME-20", {
            stage: "Backlog",
            links: [
              dependLink("INWARD", [
                ["ACME-1", "PR Merged"],
                ["ACME-2", "In Progress"],
              ]),
            ],
          }),
        ],
        writes: "live",
        terminalText: intentText([ticketAudit("ACME-2")]),
        prOver: { title: "feat(ACME-2): second half", headBranch: "ACME-2-x" },
      });
      expect(tracker.commands).toEqual([
        { key: "ACME-2", command: "Stage PR Merged" },
        { key: "ACME-20", command: "Stage To Do" },
      ]);
    });

    it("a promotion the tracker ignores is not announced on the dependant or the PR", async () => {
      const tracker = fakeTracker([
        issue("ACME-1", {
          links: [dependLink("OUTWARD", [["ACME-20", "Backlog"]])],
        }),
        issue("ACME-20", {
          stage: "Backlog",
          links: [dependLink("INWARD", [["ACME-1", "In Progress"]])],
        }),
      ]);
      const real = vi.mocked(tracker.client.setStage).getMockImplementation()!;
      vi.mocked(tracker.client.setStage).mockImplementation(
        async (key: string, stage: string) => {
          if (key === "ACME-20") return; // the workflow rejects it silently
          await real(key, stage);
        },
      );
      const comments = fakeComments();
      await executeMergeAudit({
        prNumber: 7,
        pr: pr(),
        terminalText: intentText([ticketAudit("ACME-1")]),
        config: config("live"),
        tracker: tracker.client,
        comments: comments.client,
        logger,
      });
      expect(tracker.added.some((entry) => entry.key === "ACME-20")).toBe(
        false,
      );
      expect(comments.state.body).toContain("Promotion to To Do did not apply");
      expect(comments.state.body).not.toContain("Promoted → To Do");
    });

    it("skips a resolved dependant without fetching it", async () => {
      const { tracker, comments } = await run({
        issues: [
          issue("ACME-1", {
            links: [
              {
                direction: "OUTWARD",
                typeName: "Depend",
                verb: "is required for",
                issues: [
                  {
                    key: "ACME-20",
                    summary: "x",
                    stage: "Done",
                    resolved: true,
                  },
                ],
              },
            ],
          }),
        ],
        writes: "live",
        terminalText: intentText([ticketAudit("ACME-1")]),
      });
      expect(tracker.client.getIssue).not.toHaveBeenCalledWith("ACME-20");
      expect(comments.upserts[0]!.body).toContain("Skipped (already resolved)");
    });

    it("a dependant that already carries this PR's URL is not notified again", async () => {
      const { tracker } = await run({
        issues: [
          issue("ACME-1", {
            links: [dependLink("OUTWARD", [["ACME-20", "To Do"]])],
          }),
          issue("ACME-20", {
            stage: "To Do",
            comments: [{ id: "c", text: `Blocker merged via ${PR_URL}` }],
          }),
        ],
        writes: "live",
        terminalText: intentText([ticketAudit("ACME-1")]),
      });
      expect(tracker.added.map((entry) => entry.key)).toEqual(["ACME-1"]);
    });

    it("caps the dependants it probes", async () => {
      const many = Array.from(
        { length: 13 },
        (_, index) => `ACME-${100 + index}`,
      );
      const { tracker, comments } = await run({
        issues: [
          issue("ACME-1", {
            links: [
              dependLink(
                "OUTWARD",
                many.map((key) => [key, "To Do"]),
              ),
            ],
          }),
          ...many.map((key) => issue(key, { stage: "To Do" })),
        ],
        writes: "live",
        terminalText: intentText([ticketAudit("ACME-1")]),
      });
      const probed = vi
        .mocked(tracker.client.getIssue)
        .mock.calls.filter(([key]) => many.includes(key));
      expect(probed).toHaveLength(10);
      expect(
        comments.upserts[0]!.body.match(/Not probed \(over cap\)/g),
      ).toHaveLength(3);
    });
  });

  describe("re-runs (the finish hook fires on every terminal turn)", () => {
    const liveArgs = (
      tracker: ReturnType<typeof fakeTracker>,
      comments: ReturnType<typeof fakeComments>,
      terminalText: string,
    ) => ({
      prNumber: 7,
      pr: pr(),
      terminalText,
      config: config("live"),
      tracker: tracker.client,
      comments: comments.client,
      logger,
    });

    it("a redelivered run moves nothing, comments nothing, and leaves the posted audit alone", async () => {
      const tracker = fakeTracker([
        issue("ACME-1", {
          links: [dependLink("OUTWARD", [["ACME-20", "Backlog"]])],
        }),
        issue("ACME-20", {
          stage: "Backlog",
          links: [dependLink("INWARD", [["ACME-1", "In Progress"]])],
        }),
      ]);
      const comments = fakeComments();
      const text = intentText([ticketAudit("ACME-1")]);

      const first = await executeMergeAudit(liveArgs(tracker, comments, text));
      const audit = comments.state.body;
      const second = await executeMergeAudit(liveArgs(tracker, comments, text));

      expect(first).toMatchObject({ outcome: "posted", transitions: 1 });
      expect(second).toEqual({
        outcome: "skipped_already_recorded",
        tickets: 1,
      });
      expect(tracker.commands).toHaveLength(2); // ACME-1 → PR Merged, ACME-20 → To Do
      expect(tracker.added).toHaveLength(2);
      // The first run's stage move and promotion are still what the PR shows.
      expect(comments.upserts).toHaveLength(1);
      expect(comments.state.body).toBe(audit);
      expect(comments.state.body).toContain("`In Progress` → `PR Merged`");
      expect(comments.state.body).toContain("Promoted → To Do");
    });

    it("a follow-up turn with no intent cannot overwrite the posted audit with a notice", async () => {
      const tracker = fakeTracker([issue("ACME-1")]);
      const comments = fakeComments();
      await executeMergeAudit(
        liveArgs(tracker, comments, intentText([ticketAudit("ACME-1")])),
      );
      const audit = comments.state.body;

      const outcome = await executeMergeAudit(
        liveArgs(
          tracker,
          comments,
          "AC-2 is not met because the test is missing.",
        ),
      );

      // Not a failed audit: this turn simply had nothing to add.
      expect(outcome).toEqual({ outcome: "skipped_existing_comment" });
      expect(comments.upserts.at(-1)!.mode).toBe("create-only");
      expect(comments.state.body).toBe(audit);
      expect(tracker.commands).toHaveLength(1);
    });

    it("an audit DOES replace an earlier notice (retry after a failed first turn)", async () => {
      const tracker = fakeTracker([issue("ACME-1")]);
      const comments = fakeComments();
      await executeMergeAudit(liveArgs(tracker, comments, "rate limited"));
      expect(comments.state.body).toContain("did not produce a usable result");

      await executeMergeAudit(
        liveArgs(tracker, comments, intentText([ticketAudit("ACME-1")])),
      );
      expect(comments.upserts.at(-1)!.mode).toBe("replace");
      expect(comments.state.body).toContain("`In Progress` → `PR Merged`");
    });

    it("shadow re-runs just re-render (there is no tracker record to detect)", async () => {
      const tracker = fakeTracker([issue("ACME-1")]);
      const comments = fakeComments();
      const args = {
        ...liveArgs(tracker, comments, intentText([ticketAudit("ACME-1")])),
        config: config("off"),
      };
      await executeMergeAudit(args);
      const second = await executeMergeAudit(args);
      expect(second).toMatchObject({ outcome: "posted", live: false });
      expect(tracker.client.addComment).not.toHaveBeenCalled();
    });

    it("a PR link a developer pasted into the ticket does not suppress the audit record", async () => {
      const { tracker } = await run({
        issues: [
          issue("ACME-1", {
            comments: [{ id: "h", text: `PR: ${PR_URL} — please review` }],
          }),
        ],
        writes: "live",
        terminalText: intentText([ticketAudit("ACME-1")]),
      });
      expect(tracker.added.map((entry) => entry.key)).toEqual(["ACME-1"]);
    });

    it("PR #7's record is not mistaken for PR #70's (URL prefix collision)", async () => {
      const { tracker } = await run({
        issues: [
          issue("ACME-1", {
            stage: "PR Merged",
            comments: [
              { id: "h", text: `PR merged: ${PR_URL}0 (merged by x)` },
            ],
          }),
        ],
        writes: "live",
        terminalText: intentText([ticketAudit("ACME-1")]),
      });
      expect(tracker.added).toHaveLength(1);
      expect(tracker.added[0]!.text.startsWith(`PR merged: ${PR_URL} `)).toBe(
        true,
      );
    });
  });

  describe("authority: which tickets may be written", () => {
    it("a ticket the agent emitted no audit for gets no tracker record", async () => {
      // The record is the idempotency marker: written without an audit, it
      // would say "nothing auditable" and block a later good run for good.
      const { tracker, comments } = await run({
        issues: [issue("ACME-1")],
        writes: "live",
        terminalText: intentText([]),
      });
      expect(tracker.commands).toEqual([]);
      expect(tracker.added).toEqual([]);
      expect(comments.upserts).toHaveLength(1);
    });

    it("ignores a ticket the agent names that the PR does not reference", async () => {
      const { tracker, outcome } = await run({
        issues: [issue("ACME-1"), issue("ACME-666", { stage: "In Progress" })],
        writes: "live",
        terminalText: intentText([
          ticketAudit("ACME-1"),
          ticketAudit("ACME-666"),
        ]),
      });
      expect(outcome).toMatchObject({ tickets: 1 });
      expect(tracker.client.getIssue).not.toHaveBeenCalledWith("ACME-666");
      expect(tracker.commands.every((entry) => entry.key === "ACME-1")).toBe(
        true,
      );
      expect(tracker.added.every((entry) => entry.key === "ACME-1")).toBe(true);
    });

    it("a ticket the PR only mentions is never audited, commented on, moved — or even fetched", async () => {
      const { tracker, comments, outcome } = await run({
        issues: [issue("ACME-1"), issue("ACME-2", { stage: "Backlog" })],
        writes: "live",
        // Even when the agent emits an audit for the mentioned ticket.
        terminalText: intentText([
          ticketAudit("ACME-1"),
          ticketAudit("ACME-2", {
            criteria: [{ id: "AC-1", text: "x", verdict: "not_met" }],
          }),
        ]),
        prOver: { body: "Part of ACME-2. AC-3 deferred to ACME-2." },
      });
      expect(outcome).toMatchObject({ tickets: 1, audited: 1 });
      expect(tracker.client.getIssue).not.toHaveBeenCalledWith("ACME-2");
      expect(tracker.commands).toEqual([
        { key: "ACME-1", command: "Stage PR Merged" },
      ]);
      expect(tracker.added.map((entry) => entry.key)).toEqual(["ACME-1"]);
      const body = comments.upserts[0]!.body;
      expect(body).toContain(
        "Also referenced, not audited: [ACME-2](https://acme.youtrack.cloud/issue/ACME-2)",
      );
      // Its "miss" is not this PR's miss and must not be reported as one.
      expect(body).not.toContain("### [ACME-2]");
    });

    it("a PR that only mentions tickets, delivering none, gets a notice that says how to bind one", async () => {
      const { tracker, comments, outcome } = await run({
        issues: [issue("ACME-5"), issue("ACME-6")],
        writes: "live",
        terminalText: intentText([]),
        prOver: {
          title: "void predictions",
          body: "Relates to ACME-5 and ACME-6.",
          headBranch: "feat/void",
        },
      });
      expect(outcome).toEqual({ outcome: "no_ticket" });
      expect(tracker.client.getIssue).not.toHaveBeenCalled();
      expect(comments.upserts[0]!.body).toContain(
        "mentions ACME-5, ACME-6 but names none as the ticket it delivers",
      );
      expect(comments.upserts[0]!.body).toContain("`Closes ACME-5`");
    });

    it("moves a ticket named by a closing keyword", async () => {
      const { tracker } = await run({
        issues: [issue("ACME-1"), issue("ACME-2")],
        writes: "live",
        terminalText: intentText([
          ticketAudit("ACME-1"),
          ticketAudit("ACME-2"),
        ]),
        prOver: { body: "Fixes ACME-2." },
      });
      expect(tracker.commands.map((entry) => entry.key)).toEqual([
        "ACME-1",
        "ACME-2",
      ]);
    });

    it("does not move a PR-named ticket the agent emitted no audit for", async () => {
      const { tracker, comments } = await run({
        issues: [issue("ACME-1")],
        writes: "live",
        terminalText: intentText([]),
      });
      expect(tracker.commands).toEqual([]);
      expect(comments.upserts[0]!.body).toContain("No audit was emitted");
    });
  });

  describe("degraded paths", () => {
    it("no tracker configured → one notice, no tracker call", async () => {
      const comments = fakeComments();
      const outcome = await executeMergeAudit({
        prNumber: 7,
        pr: pr(),
        terminalText: intentText([]),
        config: null,
        tracker: null,
        comments: comments.client,
        logger,
      });
      expect(outcome).toEqual({ outcome: "tracker_unconfigured" });
      expect(comments.upserts[0]!.mode).toBe("create-only");
      expect(comments.upserts[0]!.body).toContain("no tracker is configured");
    });

    it("no ticket key in the PR → the single 'no ticket' notice, no tracker call", async () => {
      const { outcome, tracker, comments } = await run({
        issues: [],
        writes: "live",
        terminalText: intentText([]),
        prOver: {
          title: "chore: bump deps",
          body: "",
          headBranch: "chore/bump",
        },
      });
      expect(outcome).toEqual({ outcome: "no_ticket" });
      expect(tracker.client.getIssue).not.toHaveBeenCalled();
      expect(comments.upserts).toHaveLength(1);
      expect(comments.upserts[0]!.body).toContain(
        "No ticket reference was found",
      );
      expect(comments.upserts[0]!.body).toContain("ACME-123");
    });

    it("unparseable agent output → notice, and nothing is written to the tracker", async () => {
      const { outcome, tracker, comments } = await run({
        issues: [issue("ACME-1")],
        writes: "live",
        terminalText: "I ran out of time.",
      });
      expect(outcome).toMatchObject({ outcome: "degraded_comment" });
      expect(tracker.client.getIssue).not.toHaveBeenCalled();
      expect(tracker.client.setStage).not.toHaveBeenCalled();
      expect(tracker.client.addComment).not.toHaveBeenCalled();
      expect(comments.upserts[0]!.body).toContain(
        "did not produce a usable result",
      );
    });

    it("an intent for a different PR (the skill example echoed back) is not a verdict", async () => {
      const { outcome, tracker } = await run({
        issues: [issue("ACME-1")],
        writes: "live",
        terminalText: intentText([ticketAudit("ACME-1")], 412),
      });
      expect(outcome).toEqual({
        outcome: "degraded_comment",
        reason: "intent is for PR #412, not #7",
      });
      expect(tracker.client.setStage).not.toHaveBeenCalled();
    });

    it("counts audited tickets so an empty audit is not a health signal", async () => {
      const { outcome } = await run({
        issues: [issue("ACME-1")],
        writes: "live",
        terminalText: intentText([]),
      });
      expect(outcome).toMatchObject({ outcome: "posted", audited: 0 });
    });

    it("a subtask whose code is merged no longer holds its parent", async () => {
      const { tracker } = await run({
        issues: [
          issue("ACME-1", {
            links: [
              {
                direction: "OUTWARD",
                typeName: "Subtask",
                verb: "parent for",
                issues: [
                  {
                    key: "ACME-2",
                    summary: "child",
                    stage: "PR Merged",
                    resolved: false,
                  },
                ],
              },
            ],
          }),
        ],
        writes: "live",
        terminalText: intentText([ticketAudit("ACME-1")]),
      });
      expect(tracker.commands).toEqual([
        { key: "ACME-1", command: "Stage PR Merged" },
      ]);
    });

    it("a ticket that cannot be read is reported and the rest still run", async () => {
      const { outcome, tracker, comments } = await run({
        issues: [issue("ACME-2")],
        writes: "live",
        terminalText: intentText([
          ticketAudit("ACME-1"),
          ticketAudit("ACME-2"),
        ]),
        prOver: { title: "feat(ACME-1): x", body: "Closes ACME-2" },
      });
      expect(outcome).toMatchObject({
        outcome: "posted",
        tickets: 2,
        transitions: 1,
      });
      expect(tracker.commands).toEqual([
        { key: "ACME-2", command: "Stage PR Merged" },
      ]);
      expect(comments.upserts[0]!.body).toContain(
        "issue fetch failed (HTTP 404)",
      );
    });

    it("a failed stage write is reported, not claimed", async () => {
      const tracker = fakeTracker([issue("ACME-1")]);
      vi.mocked(tracker.client.setStage).mockRejectedValueOnce(
        new TrackerRequestError("command", 403),
      );
      const comments = fakeComments();
      const outcome = await executeMergeAudit({
        prNumber: 7,
        pr: pr(),
        terminalText: intentText([ticketAudit("ACME-1")]),
        config: config("live"),
        tracker: tracker.client,
        comments: comments.client,
        logger,
      });
      expect(outcome).toMatchObject({ outcome: "posted", transitions: 0 });
      const body = comments.upserts[0]!.body;
      expect(body).toContain("did not apply");
      expect(body).toContain("command failed (HTTP 403)");
      expect(body).not.toContain("perm:secret");
    });

    it("a stage command the tracker silently ignores is not reported as applied", async () => {
      const tracker = fakeTracker([issue("ACME-1")]);
      vi.mocked(tracker.client.setStage).mockResolvedValueOnce(undefined);
      const comments = fakeComments();
      const outcome = await executeMergeAudit({
        prNumber: 7,
        pr: pr(),
        terminalText: intentText([ticketAudit("ACME-1")]),
        config: config("live"),
        tracker: tracker.client,
        comments: comments.client,
        logger,
      });
      expect(outcome).toMatchObject({ transitions: 0 });
      expect(comments.upserts[0]!.body).toContain("did not apply");
    });
  });
});
