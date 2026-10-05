import type { AuditFindingRow } from "@terragon/shared/model/audit-findings";
import { describe, expect, it } from "vitest";

import {
  decideAuditActions,
  planHash,
  type AuditAction,
  type CheckOutcome,
  type DecideAuditActionsInput,
  type IssueSnapshot,
} from "./decide-audit-actions";
import type { ParsedFinding } from "./parse-audit-findings";

const RUN_ID = "run-42";

function finding(over: Partial<ParsedFinding> = {}): ParsedFinding {
  return {
    rule: "supply.lockfile-missing",
    subject: "pnpm-lock.yaml",
    severity: "medium",
    section: "supply-chain",
    title: "Lockfile missing",
    files: [],
    plan: "plan",
    acceptance: "acceptance",
    effort: "S",
    fingerprint: "aaaaaaaaaaaaaaaa",
    ...over,
  };
}

function rubricFinding(over: Partial<ParsedFinding> = {}): ParsedFinding {
  return finding({
    rule: "automation.review-process",
    section: "security-automation",
    fingerprint: "bbbbbbbbbbbbbbbb",
    ...over,
  });
}

function row(over: Partial<AuditFindingRow> = {}): AuditFindingRow {
  const base: AuditFindingRow = {
    id: "row-a",
    organizationId: "org",
    repoFullName: "o/r",
    fingerprint: "aaaaaaaaaaaaaaaa",
    audit: "security-audit",
    ruleId: "supply.lockfile-missing",
    section: "supply-chain",
    severity: "medium",
    checkKind: "script",
    title: "t",
    subject: "pnpm-lock.yaml",
    findingKey: null,
    planMd: null,
    acceptanceMd: null,
    planFiles: null,
    planHash: planHash(finding()),
    issueNumber: null,
    status: "candidate",
    recentSightings: [],
    consecutiveCheckPasses: 0,
    lastCheckOutcome: null,
    absentCount: 0,
    attempts: 0,
    lastAttemptAt: null,
    activeThreadId: null,
    activeAttemptId: null,
    prNumber: null,
    autoFixLabeled: false,
    fixReadyAt: null,
    lastSeenRunId: null,
    lastReopenedAt: null,
    lastDecision: null,
    lastDecisionReason: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  return { ...base, ...over };
}

function openRow(over: Partial<AuditFindingRow> = {}): AuditFindingRow {
  return row({
    status: "open",
    issueNumber: 7,
    recentSightings: [true, true],
    ...over,
  });
}

function rubricRow(over: Partial<AuditFindingRow> = {}): AuditFindingRow {
  return openRow({
    id: "row-b",
    fingerprint: "bbbbbbbbbbbbbbbb",
    ruleId: "automation.review-process",
    section: "security-automation",
    checkKind: "rubric",
    planHash: planHash(rubricFinding()),
    ...over,
  });
}

function gh(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return { state: "open", stateReason: null, labels: [], ...over };
}

function run(
  over: Partial<DecideAuditActionsInput> & {
    checks?: Record<string, CheckOutcome> | null;
    complete?: boolean;
    issuesMap?: Record<number, IssueSnapshot> | null;
  } = {},
): ReturnType<typeof decideAuditActions> {
  const { checks, complete, issuesMap, ...rest } = over;
  const checkResults =
    checks === null
      ? null
      : new Map<string, CheckOutcome>(Object.entries(checks ?? {}));
  const issues =
    issuesMap === null
      ? null
      : new Map<number, IssueSnapshot>(
          Object.entries(issuesMap ?? {}).map(([k, v]) => [Number(k), v]),
        );
  return decideAuditActions({
    run: { id: RUN_ID, complete: complete ?? true, checkResults },
    audit: "security-audit",
    findings: [],
    ledger: [],
    issues,
    pendingCreateFingerprints: new Set(),
    settings: {
      minSeverity: "low",
      maxOpenIssues: 5,
      maxAttempts: 2,
      autoLabel: true,
      absentAudits: 2,
    },
    isPublicRepo: false,
    openIssueCount: 0,
    ...rest,
  });
}

function kinds(actions: AuditAction[]): string[] {
  return actions.map((a) => a.kind).sort();
}

function find<K extends AuditAction["kind"]>(
  actions: AuditAction[],
  kind: K,
): Extract<AuditAction, { kind: K }> | undefined {
  return actions.find((a): a is Extract<AuditAction, { kind: K }> => {
    return a.kind === kind;
  });
}

describe("decideAuditActions", () => {
  it("1. new finding records a candidate and does not create", () => {
    const r = run({ findings: [finding()] });
    const a = find(r.actions, "record_candidate");
    expect(a?.sightings).toEqual([true]);
    expect(find(r.actions, "create_issue")).toBeUndefined();
    expect(r.skipped.consensus_pending).toBe(1);
  });

  it("2. rubric candidate with quorum is filed as needs_human with the approve label", () => {
    const r = run({
      findings: [rubricFinding()],
      ledger: [
        row({
          id: "row-b",
          fingerprint: "bbbbbbbbbbbbbbbb",
          ruleId: "automation.review-process",
          checkKind: "rubric",
          recentSightings: [false, true],
        }),
      ],
    });
    const c = find(r.actions, "create_issue");
    expect(c?.status).toBe("needs_human");
    expect(c?.labels).toContain("needs-human-review");
    expect(c?.labels).not.toContain("automata:auto-fix");
    expect(c?.autoFix).toBe(false);
  });

  it("3. script candidate with a failing check is filed open; auto-fix follows autoLabel", () => {
    const base = {
      findings: [finding()],
      ledger: [row({ recentSightings: [true] })],
      checks: { aaaaaaaaaaaaaaaa: "fail" as const },
    };
    const on = find(run(base).actions, "create_issue");
    expect(on?.status).toBe("open");
    expect(on?.autoFix).toBe(true);
    expect(on?.labels).toContain("automata:auto-fix");
    const off = find(
      run({
        ...base,
        settings: {
          minSeverity: "low",
          maxOpenIssues: 5,
          maxAttempts: 2,
          autoLabel: false,
          absentAudits: 2,
        },
      }).actions,
      "create_issue",
    );
    expect(off?.autoFix).toBe(false);
    expect(off?.labels).not.toContain("automata:auto-fix");
  });

  it("4. missing check results block the create", () => {
    const r = run({
      findings: [finding()],
      ledger: [row({ recentSightings: [true] })],
      checks: null,
    });
    expect(r.skipped.checks_missing).toBe(1);
    expect(find(r.actions, "create_issue")).toBeUndefined();
    expect(find(r.actions, "record_sighting")).toBeDefined();
  });

  it("5. a passing check disagrees with the finding", () => {
    const r = run({
      findings: [finding()],
      ledger: [row({ recentSightings: [true] })],
      checks: { aaaaaaaaaaaaaaaa: "pass" },
    });
    expect(r.skipped.check_disagrees).toBe(1);
    expect(find(r.actions, "create_issue")).toBeUndefined();
  });

  it("6. open cap limits creates, highest severity first", () => {
    const capped = run({
      findings: [finding()],
      ledger: [row({ recentSightings: [true] })],
      checks: { aaaaaaaaaaaaaaaa: "fail" },
      openIssueCount: 5,
    });
    expect(capped.skipped.open_cap).toBe(1);
    expect(find(capped.actions, "create_issue")).toBeUndefined();
    expect(find(capped.actions, "record_sighting")).toBeDefined();

    const lowF = finding({ severity: "low" });
    const highF = finding({
      severity: "high",
      fingerprint: "cccccccccccccccc",
    });
    const one = run({
      findings: [lowF, highF],
      ledger: [
        row({ recentSightings: [true] }),
        row({
          id: "row-c",
          fingerprint: "cccccccccccccccc",
          recentSightings: [true],
        }),
      ],
      checks: { aaaaaaaaaaaaaaaa: "fail", cccccccccccccccc: "fail" },
      openIssueCount: 4,
    });
    const creates = one.actions.filter((a) => a.kind === "create_issue");
    expect(creates).toHaveLength(1);
    expect(find(one.actions, "create_issue")?.fingerprint).toBe(
      "cccccccccccccccc",
    );
  });

  it("7. below minimum severity: skipped, no ledger action", () => {
    const r = run({
      findings: [finding({ severity: "low" })],
      settings: {
        minSeverity: "medium",
        maxOpenIssues: 5,
        maxAttempts: 2,
        autoLabel: true,
        absentAudits: 2,
      },
    });
    expect(r.skipped.below_severity).toBe(1);
    expect(r.actions).toEqual([]);
  });

  it("8. public repo filters non-public-safe rules only", () => {
    const secret = finding({
      rule: "secret.hardcoded",
      section: "secret-detection",
    });
    const pub = run({ findings: [secret], isPublicRepo: true });
    expect(pub.skipped.public_repo_filtered).toBe(1);
    expect(pub.actions).toEqual([]);
    const priv = run({ findings: [secret], isPublicRepo: false });
    expect(find(priv.actions, "record_candidate")).toBeDefined();
  });

  it("9. plan drift updates the issue; unchanged does not; both record a sighting", () => {
    const drift = run({
      findings: [finding({ plan: "new plan" })],
      ledger: [openRow()],
      issuesMap: { 7: gh() },
      checks: { aaaaaaaaaaaaaaaa: "error" },
    });
    expect(kinds(drift.actions)).toEqual(["record_sighting", "update_issue"]);
    const same = run({
      findings: [finding()],
      ledger: [openRow()],
      issuesMap: { 7: gh() },
      checks: { aaaaaaaaaaaaaaaa: "error" },
    });
    expect(kinds(same.actions)).toEqual(["record_sighting"]);
  });

  it("10. script issue closes only on the second consecutive pass", () => {
    const first = run({
      ledger: [openRow({ consecutiveCheckPasses: 0 })],
      issuesMap: { 7: gh() },
      checks: { aaaaaaaaaaaaaaaa: "pass" },
    });
    const rc = find(first.actions, "record_check");
    expect(rc?.consecutivePasses).toBe(1);
    expect(find(first.actions, "close_issue")).toBeUndefined();
    const second = run({
      ledger: [openRow({ consecutiveCheckPasses: 1 })],
      issuesMap: { 7: gh() },
      checks: { aaaaaaaaaaaaaaaa: "pass" },
    });
    expect(find(second.actions, "close_issue")?.alreadyClosed).toBe(false);
  });

  it("11. an issue closed on GitHub still needs two passes, then close_issue alreadyClosed", () => {
    const closed = gh({ state: "closed", stateReason: "completed" });
    const first = run({
      ledger: [openRow()],
      issuesMap: { 7: closed },
      checks: { aaaaaaaaaaaaaaaa: "pass" },
    });
    expect(find(first.actions, "record_check")?.consecutivePasses).toBe(1);
    const second = run({
      ledger: [openRow({ consecutiveCheckPasses: 1 })],
      issuesMap: { 7: closed },
      checks: { aaaaaaaaaaaaaaaa: "pass" },
    });
    expect(find(second.actions, "close_issue")?.alreadyClosed).toBe(true);
  });

  it("12. closed issue with a failing check is reopened and the streak reset", () => {
    const r = run({
      ledger: [openRow({ consecutiveCheckPasses: 1 })],
      issuesMap: { 7: gh({ state: "closed", stateReason: "completed" }) },
      checks: { aaaaaaaaaaaaaaaa: "fail" },
    });
    expect(find(r.actions, "reopen_issue")).toBeDefined();
    const rc = find(r.actions, "record_check");
    expect(rc?.consecutivePasses).toBe(0);
  });

  it("13. the LLM's absence never closes a script issue", () => {
    const r = run({
      findings: [],
      ledger: [openRow()],
      issuesMap: { 7: gh() },
      checks: { aaaaaaaaaaaaaaaa: "fail" },
    });
    expect(find(r.actions, "close_issue")).toBeUndefined();
    expect(find(r.actions, "record_absence")).toBeUndefined();
  });

  it("14. H4-01 a check error moves nothing", () => {
    const r = run({
      ledger: [openRow({ consecutiveCheckPasses: 1 })],
      issuesMap: { 7: gh({ state: "closed", stateReason: "completed" }) },
      checks: { aaaaaaaaaaaaaaaa: "error" },
    });
    expect(r.actions).toEqual([]);
  });

  it("15. H4-01 an incomplete run makes no progress at all", () => {
    const r = run({
      complete: false,
      findings: [finding()],
      ledger: [
        openRow({ consecutiveCheckPasses: 1 }),
        rubricRow({ absentCount: 1 }),
        row({ id: "row-d", fingerprint: "dddddddddddddddd" }),
      ],
      issuesMap: { 7: gh() },
      checks: { aaaaaaaaaaaaaaaa: "pass" },
    });
    expect(r.actions).toEqual([]);
    expect(r.skipped.incomplete_audit_no_progress).toBeGreaterThanOrEqual(1);
  });

  it("16. rubric issue absent for absentAudits complete runs becomes needs-human", () => {
    const below = run({
      ledger: [rubricRow({ absentCount: 0 })],
      issuesMap: { 7: gh() },
    });
    expect(find(below.actions, "record_absence")?.absentCount).toBe(1);
    const at = run({
      ledger: [rubricRow({ absentCount: 1 })],
      issuesMap: { 7: gh() },
    });
    expect(find(at.actions, "mark_needs_human")?.reason).toBe("rubric_absent");
  });

  it("17. wontfix and not_planned suppress; suppressed rows never reopen", () => {
    const wontfix = run({
      ledger: [openRow()],
      issuesMap: { 7: gh({ labels: ["automata:wontfix"] }) },
      checks: { aaaaaaaaaaaaaaaa: "fail" },
    });
    expect(wontfix.actions).toEqual([
      { kind: "mark_suppressed", findingId: "row-a", reason: "wontfix_label" },
    ]);
    const np = run({
      ledger: [openRow()],
      issuesMap: { 7: gh({ state: "closed", stateReason: "not_planned" }) },
      checks: { aaaaaaaaaaaaaaaa: "fail" },
    });
    expect(np.actions).toEqual([
      {
        kind: "mark_suppressed",
        findingId: "row-a",
        reason: "closed_not_planned",
      },
    ]);
    const suppressed = run({
      ledger: [openRow({ status: "suppressed" })],
      issuesMap: { 7: gh({ state: "closed", stateReason: "completed" }) },
      checks: { aaaaaaaaaaaaaaaa: "fail" },
    });
    expect(suppressed.actions).toEqual([]);
  });

  it("18. attempts cap marks needs-human; below cap comments once per attempt count", () => {
    const base = {
      issuesMap: { 7: gh() },
      checks: { aaaaaaaaaaaaaaaa: "fail" as const },
    };
    const cap = run({
      ...base,
      ledger: [openRow({ attempts: 2, lastCheckOutcome: "fail" })],
    });
    expect(find(cap.actions, "mark_needs_human")?.reason).toBe("attempts_cap");
    const comment = run({
      ...base,
      ledger: [openRow({ attempts: 1, lastCheckOutcome: "fail" })],
    });
    expect(find(comment.actions, "comment_still_present")?.attempts).toBe(1);
    const done = run({
      ...base,
      ledger: [
        openRow({
          attempts: 1,
          lastCheckOutcome: "fail",
          lastDecision: "still_present:1",
        }),
      ],
    });
    expect(done.actions).toEqual([]);
  });

  it("19. H4-01 unknown issue state disables every GitHub-dependent decision", () => {
    const reopenCase = run({
      ledger: [openRow()],
      issuesMap: null,
      checks: { aaaaaaaaaaaaaaaa: "fail" },
    });
    expect(find(reopenCase.actions, "reopen_issue")).toBeUndefined();
    expect(reopenCase.skipped.issues_unknown).toBe(1);

    const cap = run({
      ledger: [openRow({ attempts: 2, lastCheckOutcome: "fail" })],
      issuesMap: null,
      checks: { aaaaaaaaaaaaaaaa: "fail" },
    });
    expect(find(cap.actions, "mark_needs_human")).toBeUndefined();

    const suppress = run({
      ledger: [openRow()],
      issuesMap: null,
      checks: { aaaaaaaaaaaaaaaa: "fail" },
    });
    expect(find(suppress.actions, "mark_suppressed")).toBeUndefined();

    const promotable = {
      findings: [finding()],
      ledger: [row({ recentSightings: [true] })],
      issuesMap: null,
      checks: { aaaaaaaaaaaaaaaa: "fail" as const },
    };
    expect(find(run(promotable).actions, "create_issue")).toBeDefined();
    const blocked = run({
      ...promotable,
      pendingCreateFingerprints: new Set(["zzzzzzzzzzzzzzzz"]),
    });
    expect(find(blocked.actions, "create_issue")).toBeUndefined();
    expect(blocked.skipped.issues_unknown).toBe(1);
  });

  it("20. a create already pending for the fingerprint is not repeated", () => {
    const r = run({
      findings: [finding()],
      ledger: [row({ recentSightings: [true] })],
      checks: { aaaaaaaaaaaaaaaa: "fail" },
      pendingCreateFingerprints: new Set(["aaaaaaaaaaaaaaaa"]),
    });
    expect(r.skipped.create_pending).toBe(1);
    expect(find(r.actions, "create_issue")).toBeUndefined();
  });

  it("21. a paused issue is never reopened or commented", () => {
    const r = run({
      ledger: [openRow({ attempts: 1 })],
      issuesMap: {
        7: gh({
          state: "closed",
          stateReason: "completed",
          labels: ["automata:paused"],
        }),
      },
      checks: { aaaaaaaaaaaaaaaa: "fail" },
    });
    expect(r.actions).toEqual([]);
    expect(r.skipped.paused).toBe(1);
  });

  it("22. at most one comment-bearing action per finding, each carrying the run id", () => {
    const scenarios = [
      run({
        ledger: [openRow({ attempts: 2 })],
        issuesMap: { 7: gh() },
        checks: { aaaaaaaaaaaaaaaa: "fail" },
      }),
      run({
        ledger: [openRow({ attempts: 1 })],
        issuesMap: { 7: gh() },
        checks: { aaaaaaaaaaaaaaaa: "fail" },
      }),
      run({
        ledger: [openRow()],
        issuesMap: { 7: gh({ state: "closed", stateReason: "completed" }) },
        checks: { aaaaaaaaaaaaaaaa: "fail" },
      }),
      run({
        ledger: [openRow({ consecutiveCheckPasses: 1 })],
        issuesMap: { 7: gh() },
        checks: { aaaaaaaaaaaaaaaa: "pass" },
      }),
    ];
    for (const s of scenarios) {
      const bearing = s.actions.filter((a) => "commentMarkerId" in a);
      expect(bearing).toHaveLength(1);
      for (const a of bearing) {
        if ("commentMarkerId" in a) {
          expect(a.commentMarkerId).toContain(RUN_ID);
        }
      }
    }
  });

  it("23. is deterministic under input shuffling", () => {
    const fa = finding({ plan: "changed" });
    const fb = rubricFinding();
    const ledger = [
      openRow(),
      rubricRow({ absentCount: 0 }),
      row({ id: "row-c", fingerprint: "cccccccccccccccc" }),
    ];
    const common = {
      issuesMap: { 7: gh() },
      checks: { aaaaaaaaaaaaaaaa: "pass" as const },
    };
    const one = run({ ...common, findings: [fa, fb], ledger });
    const two = run({
      ...common,
      findings: [fb, fa],
      ledger: [...ledger].reverse(),
    });
    const norm = (actions: AuditAction[]): string[] =>
      actions.map((a) => JSON.stringify(a)).sort();
    expect(norm(two.actions)).toEqual(norm(one.actions));
    expect(two.skipped).toEqual(one.skipped);
  });
});
