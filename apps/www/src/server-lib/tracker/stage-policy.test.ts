import { describe, expect, it } from "vitest";

import { decidePrimaryTransition } from "./merge-audit";
import {
  decideJiraPrimaryTransition,
  jiraStagePolicy,
  stagePolicyFor,
  youTrackStagePolicy,
} from "./stage-policy";
import type { TrackerIssue, TrackerLinkedIssue } from "./youtrack-client";

const complete = { taskComplete: true };
const remaining = { taskComplete: false, remaining: "EP-4 pending" };

const linked = (
  key: string,
  stage: string | null,
  resolved = false,
): TrackerLinkedIssue => ({ key, summary: key, stage, resolved });

describe("stagePolicyFor", () => {
  it("selects the policy by tracker kind", () => {
    expect(stagePolicyFor("youtrack")).toBe(youTrackStagePolicy);
    expect(stagePolicyFor("jira")).toBe(jiraStagePolicy);
  });

  it("YouTrack keeps its board rules and vocabulary", () => {
    expect(youTrackStagePolicy.decidePrimaryTransition).toBe(
      decidePrimaryTransition,
    );
    expect(youTrackStagePolicy.mergedTarget).toBe("PR Merged");
    expect(youTrackStagePolicy.dependLinkType).toBe("Depend");
    expect(youTrackStagePolicy.subtaskLinkType).toBe("Subtask");
    expect(youTrackStagePolicy.resolveTarget("PR Merged", null)).toEqual({
      stage: "PR Merged",
      fallback: false,
    });
  });

  it("Jira maps Depend → Blocks and never allows Done", () => {
    expect(jiraStagePolicy.dependLinkType).toBe("Blocks");
    expect(jiraStagePolicy.allowedTargets).not.toContain("Done");
  });
});

describe("decideJiraPrimaryTransition", () => {
  const decide = (
    stage: string | null,
    audit: { taskComplete: boolean; remaining?: string } | null,
    openSubtasks: TrackerLinkedIssue[] = [],
    resolved = false,
  ) => decideJiraPrimaryTransition({ stage, resolved, audit, openSubtasks });

  it("complete work → Ready for QA", () => {
    expect(decide("In Progress", complete).target).toBe("Ready for QA");
    expect(decide("Code Review", complete).target).toBe("Ready for QA");
    const fromTodo = decide("To Do", complete);
    expect(fromTodo.target).toBe("Ready for QA");
    expect(fromTodo.note).toContain("Merged straight from `To Do`");
  });

  it("work remaining (split across PRs) → Code Review, never QA or Done", () => {
    const decision = decide("In Progress", remaining);
    expect(decision.target).toBe("Code Review");
    expect(decision.note).toContain("EP-4 pending");
  });

  it("an open sub-task holds the ticket in review", () => {
    const decision = decide("In Progress", complete, [
      linked("ACME-4", "To Do"),
    ]);
    expect(decision.target).toBe("Code Review");
    expect(decision.note).toContain("open subtasks: ACME-4");
  });

  it("already in a review status with work remaining → unchanged", () => {
    for (const stage of ["Code Review", "In Review", "Ready for Review"]) {
      const decision = decide(stage, remaining);
      expect(decision.target).toBeNull();
      expect(decision.note).toContain("Held in");
    }
  });

  it("at or past QA, resolved, unaudited or status-less → unchanged", () => {
    expect(decide("Ready for QA", complete)).toEqual({
      target: null,
      note: "Already there, no move needed.",
    });
    expect(decide("Done", complete).target).toBeNull();
    expect(decide("In QA", complete).target).toBeNull();
    expect(decide("In Progress", complete, [], true).target).toBeNull();
    expect(decide("In Progress", null).note).toBe(
      "No audit was emitted for this ticket.",
    );
    expect(decide(null, complete).target).toBeNull();
  });
});

describe("jiraStagePolicy.resolveTarget", () => {
  const { resolveTarget } = jiraStagePolicy;

  it("prefers a Ready for QA transition", () => {
    expect(
      resolveTarget("Ready for QA", ["Code Review", "READY FOR QA", "Done"]),
    ).toEqual({ stage: "READY FOR QA", fallback: false });
  });

  it("falls back to a review status only when no QA transition exists", () => {
    expect(resolveTarget("Ready for QA", ["In Review", "Done"])).toEqual({
      stage: "In Review",
      fallback: true,
    });
    expect(resolveTarget("Ready for QA", ["Done", "Closed"])).toBeNull();
  });

  it("Code Review matches any review-ish status, never Done", () => {
    expect(resolveTarget("Code Review", ["Done", "Ready for Review"])).toEqual({
      stage: "Ready for Review",
      fallback: false,
    });
    expect(resolveTarget("Code Review", ["Done"])).toBeNull();
  });

  it("refuses a target outside its vocabulary and an unknown transition list", () => {
    expect(resolveTarget("Done", ["Done"])).toBeNull();
    expect(resolveTarget("Ready for QA", null)).toBeNull();
  });

  it("read-back compares the requested name case-insensitively", () => {
    expect(jiraStagePolicy.reached("ready for qa", "Ready for QA")).toBe(true);
    expect(jiraStagePolicy.reached("Code Review", "Ready for QA")).toBe(false);
    expect(jiraStagePolicy.reached(null, "Ready for QA")).toBe(false);
  });
});

describe("jiraStagePolicy.decideSiblingPromotion", () => {
  const sibling = (
    stage: string,
    blockers: TrackerLinkedIssue[],
  ): TrackerIssue => ({
    key: "ACME-2",
    summary: "next",
    description: "",
    stage,
    resolved: false,
    comments: [],
    links: [
      {
        direction: "INWARD",
        typeName: "Blocks",
        verb: "is blocked by",
        issues: blockers,
      },
    ],
  });

  it("promotes a Backlog issue whose last blocker merged", () => {
    expect(
      jiraStagePolicy.decideSiblingPromotion({
        mergedKey: "ACME-1",
        sibling: sibling("Backlog", [
          linked("ACME-1", "In Progress"),
          linked("ACME-5", "Ready for QA"),
        ]),
      }),
    ).toEqual({ promote: true, reason: "final blocker merged" });
  });

  it("holds when another blocker is still open", () => {
    const decision = jiraStagePolicy.decideSiblingPromotion({
      mergedKey: "ACME-1",
      sibling: sibling("Backlog", [
        linked("ACME-1", "In Progress"),
        linked("ACME-5", "Code Review"),
      ]),
    });
    expect(decision.promote).toBe(false);
    expect(decision.reason).toContain("ACME-5");
  });

  it("never promotes when the merged key is not a blocker", () => {
    expect(
      jiraStagePolicy.decideSiblingPromotion({
        mergedKey: "ACME-1",
        sibling: sibling("Backlog", [linked("ACME-7", "Done", true)]),
      }).promote,
    ).toBe(false);
  });
});
