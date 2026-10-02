import { describe, expect, it } from "vitest";

import {
  ALLOWED_STAGE_TARGETS,
  canonicalStage,
  decidePrimaryTransition,
  decideSiblingPromotion,
  formatScore,
  isBlockerNotice,
  isClearedIssue,
  isMergeRecord,
  isTerminalIssue,
  mergeAuditMarker,
  renderPrComment,
  renderTrackerComment,
  sanitizeInline,
  scoreCriteria,
  type TicketAuditResult,
} from "./merge-audit";
import type { MergeAuditCriterion } from "./parse-merge-audit-intent";
import type { TrackerIssue, TrackerLinkedIssue } from "./youtrack-client";

const criterion = (
  id: string,
  verdict: MergeAuditCriterion["verdict"],
  extra: Partial<MergeAuditCriterion> = {},
): MergeAuditCriterion => ({ id, text: `${id} text`, verdict, ...extra });

const linked = (
  key: string,
  stage: string | null,
  resolved = false,
): TrackerLinkedIssue => ({
  key,
  summary: `${key} summary`,
  stage,
  resolved,
});

const completeAudit = { taskComplete: true };

describe("stage vocabulary", () => {
  it("canonicalises case and whitespace, and rejects unknown stages", () => {
    expect(canonicalStage("to do")).toBe("To Do");
    expect(canonicalStage("  PR MERGED ")).toBe("PR Merged");
    expect(canonicalStage("staging (tf)")).toBe("Staging (TF)");
    expect(canonicalStage("Blocked")).toBeNull();
    expect(canonicalStage(null)).toBeNull();
  });

  it("the write allowlist is exactly three stages and never a terminal one", () => {
    expect([...ALLOWED_STAGE_TARGETS].sort()).toEqual([
      "In Progress",
      "PR Merged",
      "To Do",
    ]);
    for (const forbidden of [
      "Done",
      "Staging (TF)",
      "Won't do",
      "Backlog",
      "PR Review",
    ]) {
      expect(ALLOWED_STAGE_TARGETS as readonly string[]).not.toContain(
        forbidden,
      );
    }
  });

  it("terminal = resolved, Done, or Won't do", () => {
    expect(isTerminalIssue({ stage: "In Progress", resolved: true })).toBe(
      true,
    );
    expect(isTerminalIssue({ stage: "Done", resolved: false })).toBe(true);
    expect(isTerminalIssue({ stage: "won't do", resolved: false })).toBe(true);
    expect(isTerminalIssue({ stage: "PR Merged", resolved: false })).toBe(
      false,
    );
    expect(isTerminalIssue({ stage: null, resolved: false })).toBe(false);
  });
});

describe("isClearedIssue", () => {
  it.each([
    ["Backlog", false],
    ["To Do", false],
    ["In Progress", false],
    ["PR Review", false],
    ["PR Merged", true],
    ["Staging (TF)", true],
    ["Done", true],
    ["Won't do", true],
    [null, false],
  ])("%s → %s", (stage, cleared) => {
    expect(isClearedIssue({ stage, resolved: false })).toBe(cleared);
  });

  it("a resolved issue is cleared whatever its stage reads", () => {
    expect(isClearedIssue({ stage: "In Progress", resolved: true })).toBe(true);
  });
});

describe("record matching", () => {
  const url = "https://github.com/acme-inc/acme-core/pull/41";

  it("matches the bot's own record line", () => {
    expect(
      isMergeRecord(`PR merged: ${url} (merged by octocat)\nStage: …`, url),
    ).toBe(true);
    expect(isMergeRecord(`Earlier text\nPR merged: ${url}`, url)).toBe(true);
  });

  it("does not match a pasted link or another PR sharing the prefix", () => {
    expect(isMergeRecord(`PR: ${url} please review`, url)).toBe(false);
    expect(isMergeRecord(`see PR merged: ${url}`, url)).toBe(false);
    expect(isMergeRecord(`PR merged: ${url}2 (merged by x)`, url)).toBe(false);
  });

  it("a URL with regex metacharacters is matched literally", () => {
    expect(
      isMergeRecord(
        "PR merged: https://githubXcom/o/r/pull/1",
        "https://github.com/o/r/pull/1",
      ),
    ).toBe(false);
  });

  it("blocker notices are matched on their phrase, with the same digit boundary", () => {
    expect(
      isBlockerNotice(
        `Blocker ACME-1 was merged via ${url}. Not promoted…`,
        url,
      ),
    ).toBe(true);
    expect(
      isBlockerNotice(
        `Auto-promoted: … ACME-1 merged via ${url} and no other…`,
        url,
      ),
    ).toBe(true);
    expect(isBlockerNotice(`merged via ${url}9`, url)).toBe(false);
    expect(isBlockerNotice(`PR: ${url}`, url)).toBe(false);
  });
});

describe("scoreCriteria", () => {
  it("scores met + half of partial over the verifiable criteria", () => {
    const score = scoreCriteria([
      criterion("AC-1", "met"),
      criterion("AC-2", "met"),
      criterion("AC-3", "met"),
      criterion("AC-4", "partial"),
      criterion("AC-5", "not_met"),
      criterion("UAT-1", "not_verifiable"),
    ]);
    expect(score).toMatchObject({
      notVerifiable: 1,
      verifiable: 5,
      points: 3.5,
      percent: 70,
      unacknowledgedMisses: 2,
    });
    expect(formatScore(score)).toBe(
      "3.5/5 verifiable criteria met (70%) · 1 not verifiable from code · 2 unacknowledged misses",
    );
  });

  it("an accepted miss still costs score but is not unacknowledged", () => {
    const score = scoreCriteria([
      criterion("AC-1", "not_met", { acceptedBy: "deferred to ACME-9" }),
      criterion("AC-2", "partial", { acceptedBy: "   " }),
    ]);
    expect(score.percent).toBe(25);
    // Whitespace-only acceptance is not acceptance.
    expect(score.unacknowledgedMisses).toBe(1);
  });

  it("has no percentage when nothing is verifiable from code", () => {
    const score = scoreCriteria([criterion("UAT-1", "not_verifiable")]);
    expect(score.percent).toBeNull();
    expect(formatScore(score)).toBe(
      "no criteria verifiable from code · 1 not verifiable from code",
    );
    expect(scoreCriteria([]).percent).toBeNull();
  });
});

describe("decidePrimaryTransition", () => {
  const base = {
    resolved: false,
    audit: completeAudit,
    openSubtasks: [],
  };

  it.each(["In Progress", "PR Review"])("%s → PR Merged", (stage) => {
    expect(decidePrimaryTransition({ ...base, stage }).target).toBe(
      "PR Merged",
    );
  });

  it.each(["Backlog", "To Do"])(
    "%s → PR Merged, naming the skipped stages",
    (stage) => {
      const decision = decidePrimaryTransition({ ...base, stage });
      expect(decision.target).toBe("PR Merged");
      expect(decision.note).toContain("skipped");
      expect(decision.note).toContain(stage);
    },
  );

  it("moves regardless of score — the decision never reads the criteria", () => {
    const decision = decidePrimaryTransition({
      ...base,
      stage: "In Progress",
      audit: { taskComplete: true },
    });
    expect(decision.target).toBe("PR Merged");
  });

  it.each(["PR Merged", "Staging (TF)", "Done", "Won't do"])(
    "never demotes or re-moves a ticket already at %s",
    (stage) => {
      expect(decidePrimaryTransition({ ...base, stage }).target).toBeNull();
    },
  );

  it("never moves a resolved ticket, and says it is resolved rather than naming a stage it 'reached'", () => {
    const decision = decidePrimaryTransition({
      ...base,
      stage: "In Progress",
      resolved: true,
    });
    expect(decision.target).toBeNull();
    expect(decision.note).toContain("already resolved");
    expect(decision.note).not.toContain("reached");
  });

  it("the agent's `remaining` text is sanitised before it reaches a comment", () => {
    const decision = decidePrimaryTransition({
      ...base,
      stage: "In Progress",
      audit: {
        taskComplete: false,
        remaining:
          "@acme-inc/everyone\n## Approved\n<!-- automata:pr-merged-audit:7 --> " +
          "x".repeat(400),
      },
    });
    expect(decision.note).not.toMatch(/@acme-inc/);
    expect(decision.note).not.toContain("\n");
    expect(decision.note).not.toContain("<!--");
    expect(decision.note.length).toBeLessThan(260);
  });

  it("an empty `remaining` falls back to a generic reason", () => {
    const decision = decidePrimaryTransition({
      ...base,
      stage: "In Progress",
      audit: { taskComplete: false, remaining: "   " },
    });
    expect(decision.note).toContain("work remaining on this ticket");
  });

  it("an unknown stage name from the tracker is rendered inert", () => {
    const decision = decidePrimaryTransition({
      ...base,
      stage: "x` @admin\n## hi",
    });
    expect(decision.note).not.toMatch(/@admin/);
    expect(decision.note).not.toContain("\n");
  });

  it("leaves a ticket with an unknown stage alone", () => {
    expect(
      decidePrimaryTransition({ ...base, stage: "Blocked" }).target,
    ).toBeNull();
    expect(decidePrimaryTransition({ ...base, stage: null }).target).toBeNull();
  });

  it("does not move a ticket the agent emitted no audit for", () => {
    const decision = decidePrimaryTransition({
      ...base,
      stage: "In Progress",
      audit: null,
    });
    expect(decision.target).toBeNull();
    expect(decision.note).toContain("No audit");
  });

  it("holds a split ticket: In Progress stays put", () => {
    const decision = decidePrimaryTransition({
      ...base,
      stage: "In Progress",
      audit: { taskComplete: false, remaining: "Admin panel PR" },
    });
    expect(decision.target).toBeNull();
    expect(decision.note).toContain("Admin panel PR");
  });

  it("holds a split ticket: Backlog / To Do are nudged to In Progress only", () => {
    for (const stage of ["Backlog", "To Do"]) {
      const decision = decidePrimaryTransition({
        ...base,
        stage,
        audit: { taskComplete: false },
      });
      expect(decision.target).toBe("In Progress");
    }
  });

  it("open subtasks hold the parent even when the agent says complete", () => {
    const decision = decidePrimaryTransition({
      ...base,
      stage: "PR Review",
      openSubtasks: [linked("ACME-11", "To Do")],
    });
    expect(decision.target).toBeNull();
    expect(decision.note).toContain("ACME-11");
  });

  it("every reachable target is in the allowlist", () => {
    const stages = [
      "Backlog",
      "To Do",
      "In Progress",
      "PR Review",
      "PR Merged",
      "Staging (TF)",
      "Done",
      "Won't do",
      "Blocked",
      null,
    ];
    const audits = [null, { taskComplete: true }, { taskComplete: false }];
    for (const stage of stages) {
      for (const audit of audits) {
        for (const resolved of [true, false]) {
          for (const openSubtasks of [[], [linked("ACME-2", "To Do")]]) {
            const { target } = decidePrimaryTransition({
              stage,
              audit,
              resolved,
              openSubtasks,
            });
            if (target !== null) {
              expect(ALLOWED_STAGE_TARGETS).toContain(target);
            }
          }
        }
      }
    }
  });
});

describe("decideSiblingPromotion", () => {
  const sibling = (
    stage: string | null,
    blockers: TrackerLinkedIssue[],
    direction: "INWARD" | "OUTWARD" = "INWARD",
  ): TrackerIssue => ({
    key: "ACME-20",
    summary: "dependent",
    description: "",
    stage,
    resolved: false,
    comments: [],
    links: [
      { direction, typeName: "Depend", verb: "depends on", issues: blockers },
    ],
  });

  it("promotes a Backlog sibling whose only blocker just merged", () => {
    expect(
      decideSiblingPromotion({
        mergedKey: "ACME-1",
        sibling: sibling("Backlog", [linked("ACME-1", "PR Merged")]),
      }),
    ).toEqual({ promote: true, reason: "final blocker merged" });
  });

  it("promotes when every OTHER blocker is terminal", () => {
    const decision = decideSiblingPromotion({
      mergedKey: "ACME-1",
      sibling: sibling("backlog", [
        linked("ACME-1", "In Progress"),
        linked("ACME-2", "Done"),
        linked("ACME-3", "In Progress", true),
      ]),
    });
    expect(decision.promote).toBe(true);
  });

  it("does not promote while another blocker is still unmerged", () => {
    const decision = decideSiblingPromotion({
      mergedKey: "ACME-1",
      sibling: sibling("Backlog", [
        linked("ACME-1", "PR Merged"),
        linked("ACME-2", "In Progress"),
      ]),
    });
    expect(decision.promote).toBe(false);
    expect(decision.reason).toContain("ACME-2");
  });

  it("a blocker at PR Merged or Staging (TF) counts as cleared", () => {
    for (const stage of ["PR Merged", "Staging (TF)"]) {
      expect(
        decideSiblingPromotion({
          mergedKey: "ACME-2",
          sibling: sibling("Backlog", [
            linked("ACME-1", stage),
            linked("ACME-2", "In Progress"),
          ]),
        }).promote,
      ).toBe(true);
    }
  });

  it("anti-vacuous guard: the merged key must be among the sibling's blockers", () => {
    const decision = decideSiblingPromotion({
      mergedKey: "ACME-1",
      sibling: sibling("Backlog", [linked("ACME-2", "Done")]),
    });
    expect(decision.promote).toBe(false);
    expect(decision.reason).toContain("not listed among its blockers");
  });

  it("anti-vacuous guard also covers a sibling with no blockers at all", () => {
    expect(
      decideSiblingPromotion({
        mergedKey: "ACME-1",
        sibling: sibling("Backlog", []),
      }).promote,
    ).toBe(false);
  });

  it("a wrong link direction never promotes", () => {
    const decision = decideSiblingPromotion({
      mergedKey: "ACME-1",
      sibling: sibling("Backlog", [linked("ACME-1", "PR Merged")], "OUTWARD"),
    });
    expect(decision.promote).toBe(false);
  });

  it.each(["To Do", "In Progress", "PR Review", "Done", null])(
    "only a Backlog sibling is promoted (not %s)",
    (stage) => {
      expect(
        decideSiblingPromotion({
          mergedKey: "ACME-1",
          sibling: sibling(stage, [linked("ACME-1", "PR Merged")]),
        }).promote,
      ).toBe(false);
    },
  );
});

describe("rendering", () => {
  const result = (over: Partial<TicketAuditResult> = {}): TicketAuditResult => {
    const criteria = [
      criterion("AC-1", "met", { evidence: "src/a.ts:10" }),
      criterion("AC-2", "partial", {
        acceptedBy: "test deferred to ACME-901",
        followUp: "ACME-901",
      }),
      criterion("AC-3", "not_met"),
      criterion("UAT-1", "not_verifiable"),
    ];
    return {
      key: "ACME-812",
      url: "https://acme.youtrack.cloud/issue/ACME-812",
      summary: "Void predictions",
      stageBefore: "In Progress",
      stageAfter: "PR Merged",
      decision: {
        target: "PR Merged",
        note: "`Done` still needs production evidence.",
      },
      transitionApplied: true,
      audit: {
        key: "ACME-812",
        acSource: "formal",
        criteria,
        taskComplete: true,
      },
      linked: [],
      errors: [],
      ...over,
    };
  };

  it("the marker is unique per PR", () => {
    expect(mergeAuditMarker(7)).toBe("<!-- automata:pr-merged-audit:7 -->");
    expect(mergeAuditMarker(7)).not.toBe(mergeAuditMarker(70));
  });

  it("the PR comment starts with the marker and carries score, table and misses", () => {
    const body = renderPrComment({
      prNumber: 7,
      results: [result()],
      live: true,
      truncatedKeys: false,
    });
    expect(body.startsWith(mergeAuditMarker(7))).toBe(true);
    expect(body).toContain(
      "[ACME-812](https://acme.youtrack.cloud/issue/ACME-812)",
    );
    expect(body).toContain("**Stage:** `In Progress` → `PR Merged`");
    expect(body).toContain("1.5/3 verifiable criteria met (50%)");
    expect(body).toContain("| AC\u20111 | AC-1 text | ✅ met | src/a.ts:10 |");
    expect(body).toContain("| ❌ **not met** |");
    expect(body).toContain("| 🟡 **partially met** |");
    expect(body).toContain("| ➖ not verifiable |");
    expect(body).toContain(
      'AC-2 — partially met — accepted: "test deferred to ACME-901" → follow-up ACME-901',
    );
    expect(body).toContain("AC-3 — not met — **not acknowledged**");
    expect(body).not.toContain("Shadow mode");
  });

  it("shadow mode says so and words the move as hypothetical", () => {
    const body = renderPrComment({
      prNumber: 7,
      results: [
        result({ transitionApplied: false, stageAfter: "In Progress" }),
      ],
      live: false,
      truncatedKeys: true,
    });
    expect(body).toContain("Shadow mode — no tracker writes were made");
    expect(body).toContain("would move to `PR Merged`");
    expect(body).toContain("more tickets than are audited automatically");
  });

  it("reports a move that did not apply instead of claiming it", () => {
    const body = renderPrComment({
      prNumber: 7,
      results: [
        result({
          transitionApplied: false,
          stageAfter: "In Progress",
          errors: ["command failed (HTTP 403)"],
        }),
      ],
      live: true,
      truncatedKeys: false,
    });
    expect(body).toContain("did not apply");
    expect(body).toContain("Tracker error: command failed (HTTP 403)");
  });

  it("flags a fallback audit and a ticket with no audit", () => {
    const fallback = result();
    const body = renderPrComment({
      prNumber: 7,
      results: [
        { ...fallback, audit: { ...fallback.audit!, acSource: "fallback" } },
        result({ key: "ACME-2", audit: null }),
      ],
      live: true,
      truncatedKeys: false,
    });
    expect(body).toContain("no formal acceptance criteria");
    expect(body).toContain("_No audit was emitted for this ticket._");
  });

  it("untrusted text cannot break the table, forge the marker, or page anyone", () => {
    const hostile = criterion("AC-1", "not_met", {
      text: "a | b\n<!-- automata:pr-merged-audit:7 --> @everyone @org/team",
      evidence: "x | y",
    });
    const body = renderPrComment({
      prNumber: 7,
      results: [
        result({
          summary: "s <!-- x --> @admin",
          audit: {
            key: "ACME-812",
            acSource: "formal",
            criteria: [hostile],
            taskComplete: true,
          },
        }),
      ],
      live: true,
      truncatedKeys: false,
    });
    // Exactly one marker: the real one on line 1.
    expect(body.split("<!-- automata:pr-merged-audit:7 -->")).toHaveLength(2);
    expect(body).not.toMatch(/@everyone|@org\/team|@admin/);
    expect(body).toContain("a \\| b");
    expect(
      body.split("\n").filter((line) => line.startsWith("| AC\u20111")),
    ).toHaveLength(1);
  });

  it("angle-bracket text survives rendering instead of being eaten as an HTML tag", () => {
    // Seen on a real ticket: `--send <sha>` rendered as `--send`.
    expect(sanitizeInline("healthy after --send <sha> (UAT-2)", 100)).toBe(
      "healthy after --send &lt;sha> (UAT-2)",
    );
    expect(sanitizeInline("<!-- automata:pr-merged-audit:7 -->", 100)).toBe(
      "&lt;!-- automata:pr-merged-audit:7 -->",
    );
    expect(sanitizeInline("<script>alert(1)</script>", 100)).not.toContain("<");
  });

  it("sanitizeInline leaves no live link or image from untrusted text", () => {
    expect(sanitizeInline("[sign in](https://evil.example)", 100)).toBe(
      "\\[sign in\\](https://evil.example)",
    );
    expect(sanitizeInline("![x](https://evil.example/p.png)", 100)).toBe(
      "!\\[x\\](https://evil.example/p.png)",
    );
  });

  it("sanitizeInline truncates and collapses whitespace", () => {
    expect(sanitizeInline("a\n\n  b\tc", 100)).toBe("a b c");
    expect(sanitizeInline("x".repeat(50), 10)).toHaveLength(10);
    expect(sanitizeInline("mail user@example.com", 100)).toContain("@​");
  });

  it("an unchanged stage is said once, not three times", () => {
    const body = renderPrComment({
      prNumber: 7,
      results: [
        result({
          stageBefore: "PR Merged",
          stageAfter: "PR Merged",
          transitionApplied: false,
          decision: decidePrimaryTransition({
            stage: "PR Merged",
            resolved: false,
            audit: { taskComplete: true },
            openSubtasks: [],
          }),
        }),
      ],
      live: true,
      truncatedKeys: false,
    });
    expect(body).toContain(
      "**Stage:** `PR Merged` (unchanged) — Already there, no move needed.",
    );
  });

  it("mentioned-only tickets are one linked line, after the audits", () => {
    const body = renderPrComment({
      prNumber: 7,
      results: [result()],
      live: true,
      truncatedKeys: false,
      referenced: [
        { key: "ACME-824", url: "https://yt.example.com/issue/ACME-824" },
        { key: "ACME-840", url: "https://yt.example.com/issue/ACME-840" },
      ],
    });
    expect(body).toContain(
      "Also referenced, not audited: [ACME-824](https://yt.example.com/issue/ACME-824), [ACME-840](https://yt.example.com/issue/ACME-840)",
    );
    expect(body.indexOf("Also referenced")).toBeGreaterThan(
      body.indexOf("### [ACME-812]"),
    );
  });

  it("the tracker comment leads with the PR URL and lists misses only", () => {
    const text = renderTrackerComment({
      prUrl: "https://github.com/acme-inc/acme-core/pull/7",
      mergedBy: "octocat",
      result: result(),
    });
    expect(text.split("\n")[0]).toBe(
      "PR merged: https://github.com/acme-inc/acme-core/pull/7 (merged by octocat)",
    );
    expect(text).toContain("Stage: In Progress → PR Merged.");
    expect(text).toContain("- [ ] AC-2 — partially met");
    expect(text).toContain(
      "- [ ] AC-3 — not met: AC-3 text (not acknowledged in the PR)",
    );
    expect(text).not.toContain("AC-1");
    expect(text).not.toContain("UAT-1 —");
    expect(text.split("\n").length).toBeLessThanOrEqual(15);
  });

  it("the tracker comment for a clean audit is short and says so", () => {
    const criteria = [criterion("AC-1", "met")];
    const text = renderTrackerComment({
      prUrl: "https://github.com/o/r/pull/1",
      mergedBy: null,
      result: result({
        audit: {
          key: "ACME-812",
          acSource: "formal",
          criteria,
          taskComplete: true,
        },
      }),
    });
    expect(text).toContain("All criteria verifiable from code are met.");
    expect(text).not.toContain("merged by");
  });

  it("the tracker comment never claims a stage change that did not happen", () => {
    const text = renderTrackerComment({
      prUrl: "https://github.com/o/r/pull/1",
      mergedBy: null,
      result: result({
        stageAfter: "Done",
        stageBefore: "Done",
        transitionApplied: false,
        decision: {
          target: null,
          note: "Merged after the ticket reached `Done`.",
        },
      }),
    });
    const stageLine = text.split("\n")[1];
    expect(stageLine).toBe(
      "Stage: Done (unchanged). Merged after the ticket reached Done.",
    );
  });
});
