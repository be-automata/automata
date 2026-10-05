import { getAuditRule } from "@terragon/shared/self-heal/audit-rules";
import { describe, expect, it } from "vitest";

import type { ParsedFinding } from "./parse-audit-findings";
import {
  COMMENT_MARKER_RE,
  FINDING_LABELS,
  FINDING_MARKER_RE,
  commentMarker,
  findingMarker,
  renderAuditComment,
  renderIssueBody,
  renderIssueTitle,
  sanitizeAgentText,
  type AuditCommentKind,
} from "./render-issue";

const FP = "0123456789abcdef";

function finding(overrides: Partial<ParsedFinding> = {}): ParsedFinding {
  return {
    rule: "supply.lockfile-missing",
    subject: "pnpm-lock.yaml",
    severity: "medium",
    section: "supply-chain",
    title: "Lockfile missing",
    files: ["pnpm-lock.yaml"],
    plan: "Generate the lockfile.",
    acceptance: "Lockfile exists.",
    effort: "S",
    fingerprint: FP,
    ...overrides,
  };
}

function body(f: ParsedFinding, ruleId = f.rule): string {
  const rule = getAuditRule(ruleId);
  if (!rule) throw new Error("rule missing");
  return renderIssueBody({
    audit: "security-audit",
    fingerprint: FP,
    finding: f,
    rule,
  });
}

describe("markers", () => {
  it("puts the finding marker on line 1 and matches only there", () => {
    const text = body(finding());
    expect(text.split("\n")[0]).toBe(findingMarker(FP));
    expect(FINDING_MARKER_RE.exec(text)?.[1]).toBe(FP);
    expect(FINDING_MARKER_RE.test(`intro\n${findingMarker(FP)}`)).toBe(false);
  });
});

describe("sanitizeAgentText", () => {
  it("neutralises mentions", () => {
    expect(sanitizeAgentText("@octocat please look")).toBe(
      "`@octocat` please look",
    );
    expect(sanitizeAgentText("ping @org/team now")).toBe(
      "ping `@org/team` now",
    );
  });

  it("neutralises closing keywords", () => {
    const out = sanitizeAgentText("this fixes #12 and Closes owner/repo#3");
    expect(out).not.toMatch(/fixes #12/i);
    expect(out).not.toMatch(/closes owner\/repo#3/i);
    expect(out).toContain("issue 12");
  });

  it("strips comment delimiters", () => {
    const out = sanitizeAgentText("a <!-- hidden --> b");
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("-->");
  });

  it("keeps 10 urls", () => {
    const text = Array.from(
      { length: 15 },
      (_, i) => `https://example.com/${i}`,
    ).join(" ");
    const out = sanitizeAgentText(text);
    expect(out.match(/https:\/\/example\.com/g)).toHaveLength(10);
    expect(out).toContain("[link removed]");
  });

  it("redacts tokens", () => {
    const out = sanitizeAgentText(`token ghp_${"a".repeat(36)} end`);
    expect(out).not.toContain("ghp_a");
  });

  it("defuses code fences from agent text", () => {
    expect(sanitizeAgentText("```\nx")).not.toMatch(/^```/m);
  });
});

describe("renderIssueBody", () => {
  it("truncates a huge plan with a visible marker", () => {
    const text = body(finding({ plan: "x".repeat(70_000) }));
    expect(text.length).toBeLessThanOrEqual(30_000);
    expect(text).toContain("plan truncated");
    expect(text.indexOf("plan truncated")).toBeLessThan(
      text.indexOf("## Files"),
    );
  });

  it("renders the rubric acceptance line", () => {
    const text = body(
      finding({ rule: "automation.review-process" }),
      "automation.review-process",
    );
    expect(text).toContain("Rubric-only: a person confirms resolution");
  });

  it("renders the script check description", () => {
    expect(body(finding())).toContain(
      getAuditRule("supply.lockfile-missing")?.checkDescription,
    );
  });

  it("has the required sections and footer", () => {
    const text = body(finding());
    for (const h of ["## Finding", "## Plan", "## Files", "## Acceptance"]) {
      expect(text).toContain(h);
    }
    expect(text).toContain("Do not edit the first line.");
  });

  it("renders a bounded single-line title", () => {
    const title = renderIssueTitle({
      audit: "security-audit",
      finding: { title: `a\nb ${"z".repeat(500)}` },
    });
    expect(title.startsWith("[security-audit] a b")).toBe(true);
    expect(title).not.toContain("\n");
    expect(title.length).toBeLessThanOrEqual(200);
  });
});

describe("labels (LABEL-01)", () => {
  it("uses needs-human-approve and no legacy names", () => {
    expect(FINDING_LABELS.needsHumanApprove).toBe("needs-human-approve");
    const values = Object.values(FINDING_LABELS).map((v) =>
      typeof v === "function" ? v("security-audit") : v,
    );
    for (const v of values) {
      expect(v).not.toContain("automata:needs-human");
      expect(v).not.toBe("bug");
      expect(v).not.toBe("enhancement");
    }
  });
});

describe("renderAuditComment", () => {
  const kinds: AuditCommentKind[] = [
    "reopened_check_failed",
    "closed_check_passed",
    "still_present",
    "needs_human_attempts_cap",
    "needs_human_rubric_absent",
    "fix_attempt_rejected",
    "fix_draft_withdrawn",
    "fix_draft_no_repo_ci",
  ];
  it.each(kinds)("%s leads with a matching marker and is inert", (kind) => {
    const text = renderAuditComment(kind, {
      fingerprint: FP,
      runId: "run-1",
      attempts: 2,
      maxAttempts: 2,
    });
    const [first = "", ...rest] = text.split("\n");
    expect(first).toBe(commentMarker({ fp: FP, kind, runId: "run-1" }));
    const m = COMMENT_MARKER_RE.exec(first);
    expect(m?.slice(1)).toEqual([FP, kind, "run-1"]);
    const visible = rest.join("\n");
    expect(visible).not.toContain("@");
    expect(visible).not.toMatch(/\b(clos|fix|resolv)\w*/i);
    expect(text).not.toContain("automata:needs-human");
  });

  it("names the label on needs-human comments", () => {
    const text = renderAuditComment("needs_human_attempts_cap", {
      fingerprint: FP,
      runId: "r",
      attempts: 2,
      maxAttempts: 2,
    });
    expect(text).toContain("needs-human-approve");
  });

  it("lists only known rejection reasons and states the branch outcome", () => {
    const deleted = renderAuditComment("fix_attempt_rejected", {
      fingerprint: FP,
      runId: "r",
      attempts: 1,
      maxAttempts: 3,
      reasons: ["test_edit", "denied_path", "<script>"],
    });
    expect(deleted).toContain("attempt 1 of 3");
    expect(deleted).toContain("changed or deleted an existing test");
    expect(deleted).toContain("protected path");
    expect(deleted).not.toContain("<script>");
    expect(deleted).toContain("branch was deleted");
    const kept = renderAuditComment("fix_attempt_rejected", {
      fingerprint: FP,
      runId: "r",
      reasons: ["open_failed"],
      keptBranch: "automata/fix-1-abcdef01-a1",
    });
    expect(kept).toContain("`automata/fix-1-abcdef01-a1` is kept");
    const draft = renderAuditComment("fix_attempt_rejected", {
      fingerprint: FP,
      runId: "r",
      reasons: ["ci_failed"],
      draftNumber: 501,
    });
    expect(draft).toContain("CI failed on the draft pull request");
    expect(draft).toContain("#501 was withdrawn");
  });

  it("states whether a withdrawn draft counts and names the no-CI label", () => {
    const counted = renderAuditComment("fix_draft_withdrawn", {
      fingerprint: FP,
      runId: "r",
      reasons: ["ci_failed"],
      counted: true,
    });
    expect(counted).toContain("counts against the limit");
    const refunded = renderAuditComment("fix_draft_withdrawn", {
      fingerprint: FP,
      runId: "r",
      reasons: ["ci_infra"],
      counted: false,
    });
    expect(refunded).toContain("does not count against the limit");
    expect(
      renderAuditComment("fix_draft_no_repo_ci", {
        fingerprint: FP,
        runId: "r",
      }),
    ).toContain("needs-human-approve");
  });
});
