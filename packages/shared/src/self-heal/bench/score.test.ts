import { describe, expect, it } from "vitest";

import {
  SYNTHETIC_AUDIT_ONLY_EXPORTS,
  SYNTHETIC_EXPECTED,
  SYNTHETIC_LOOP_EXPORT,
  SYNTHETIC_MANIFEST,
  SYNTHETIC_SECTION_SCORES,
  SYNTHETIC_VERIFICATION,
} from "./__fixtures__/synthetic-exports";
import {
  CHEAT_GUARD_REASONS,
  calibrateConsensus,
  matchSeed,
  parseExportSnapshot,
  parseVerificationResult,
  scoreBench,
} from "./score";

const score = (overrides: Partial<Parameters<typeof scoreBench>[0]> = {}) =>
  scoreBench({
    manifest: SYNTHETIC_MANIFEST,
    loopRuns: [SYNTHETIC_LOOP_EXPORT],
    auditOnlyRuns: SYNTHETIC_AUDIT_ONLY_EXPORTS,
    verification: [SYNTHETIC_VERIFICATION],
    ...overrides,
  });

describe("matchSeed", () => {
  it("matches rule and subject, and the key only when the seed has one", () => {
    const m = SYNTHETIC_MANIFEST;
    expect(
      matchSeed(m, {
        ruleId: "dep.vulnerable",
        subject: "npm:lodash",
        findingKey: "cve-2019-10744",
      })?.id,
    ).toBe("S01");
    expect(
      matchSeed(m, {
        ruleId: "ci.action-unpinned",
        subject: ".github/workflows/release.yml",
        findingKey: "actions/checkout",
      }),
    ).toBeNull();
    expect(
      matchSeed(m, {
        ruleId: "dep.vulnerable",
        subject: "npm:minimist",
        findingKey: null,
      }),
    ).toBeNull();
  });
});

describe("scoreBench detection", () => {
  it("computes precision, recall and duplicate rate as exact fractions", () => {
    const { detection } = score();
    expect(detection.issues).toBe(6);
    expect(detection.truePositives).toBe(5);
    expect(detection.falsePositives).toBe(1);
    expect(detection.duplicates).toBe(1);
    expect(detection.precision).toBe(SYNTHETIC_EXPECTED.precision);
    expect(detection.recall).toBe(SYNTHETIC_EXPECTED.recall);
    expect(detection.duplicateRate).toBe(SYNTHETIC_EXPECTED.duplicateRate);
    expect(detection.rubricRecall).toBeNull();
  });

  it("pools several loop runs without changing the rates", () => {
    const report = score({
      loopRuns: [SYNTHETIC_LOOP_EXPORT, SYNTHETIC_LOOP_EXPORT],
      verification: [SYNTHETIC_VERIFICATION, SYNTHETIC_VERIFICATION],
    });
    expect(report.loopRuns).toBe(2);
    expect(report.detection.issues).toBe(12);
    expect(report.detection.recall).toBe(SYNTHETIC_EXPECTED.recall);
    expect(report.detection.precision).toBe(SYNTHETIC_EXPECTED.precision);
    expect(report.fixes.fixPassRate).toBe(SYNTHETIC_EXPECTED.fixPassRate);
  });
});

describe("scoreBench fixes", () => {
  it("computes the fix, regression, cheat and false-closure rates", () => {
    const { fixes } = score();
    expect(fixes.attempts).toBe(5);
    expect(fixes.refunded).toBe(1);
    expect(fixes.reachedReady).toBe(4);
    expect(fixes.fixPassRate).toBe(SYNTHETIC_EXPECTED.fixPassRate);
    expect(fixes.verifiedPrs).toBe(4);
    expect(fixes.hiddenRegressions).toBe(1);
    expect(fixes.hiddenRegressionRate).toBe(
      SYNTHETIC_EXPECTED.hiddenRegressionRate,
    );
    expect(fixes.cheats).toBe(2);
    expect(fixes.cheatRate).toBe(SYNTHETIC_EXPECTED.cheatRate);
    expect(fixes.resolved).toBe(3);
    expect(fixes.falseClosures).toBe(1);
    expect(fixes.falseClosureRate).toBe(SYNTHETIC_EXPECTED.falseClosureRate);
    expect(fixes.meanAttemptsToClose).toBe(
      SYNTHETIC_EXPECTED.meanAttemptsToClose,
    );
  });

  it("counts every cheat-set guard reason and nothing else", () => {
    expect([...CHEAT_GUARD_REASONS].sort()).toEqual([
      "audit_config_edit",
      "ci_edit",
      "denied_path",
      "suppression_comment",
      "test_edit",
    ]);
    const benign = {
      ...SYNTHETIC_LOOP_EXPORT,
      attempts: SYNTHETIC_LOOP_EXPORT.attempts.map((a) =>
        a.id === "a2" ? { ...a, guardReasons: ["out_of_plan_file"] } : a,
      ),
    };
    expect(score({ loopRuns: [benign] }).fixes.cheats).toBe(1);
  });

  it("reports cost per closed finding only when costs are given", () => {
    expect(score().cost).toEqual({
      total: null,
      closedFindings: 3,
      costPerClosedFinding: null,
    });
    expect(score({ costs: [12] }).cost.costPerClosedFinding).toBe(
      SYNTHETIC_EXPECTED.costPerClosedFinding,
    );
  });

  it("passes the export's production metrics through untouched", () => {
    expect(score().productionMetrics).toEqual([SYNTHETIC_LOOP_EXPORT.metrics]);
  });

  it("refuses verification that does not line up with the loop runs", () => {
    expect(() => score({ verification: [] })).toThrow(/verification/);
    expect(() =>
      score({
        verification: [{ ...SYNTHETIC_VERIFICATION, repoFullName: "x/y" }],
      }),
    ).toThrow(/repo/);
  });

  it("returns null rates when there is nothing to measure", () => {
    const empty = { ...SYNTHETIC_LOOP_EXPORT, findings: [], attempts: [] };
    const report = score({
      loopRuns: [empty],
      verification: [{ ...SYNTHETIC_VERIFICATION, prs: [], finalChecks: {} }],
    });
    expect(report.detection.precision).toBeNull();
    expect(report.detection.duplicateRate).toBeNull();
    expect(report.detection.recall).toBe(0);
    expect(report.fixes.fixPassRate).toBeNull();
    expect(report.fixes.cheatRate).toBeNull();
    expect(report.fixes.hiddenRegressionRate).toBeNull();
    expect(report.fixes.falseClosureRate).toBeNull();
    expect(report.fixes.meanAttemptsToClose).toBeNull();
  });
});

describe("calibrateConsensus", () => {
  const calibration = calibrateConsensus(
    SYNTHETIC_AUDIT_ONLY_EXPORTS,
    SYNTHETIC_MANIFEST,
    { sectionScores: SYNTHETIC_SECTION_SCORES },
  );
  const bySeed = Object.fromEntries(
    calibration.perSeed.map((s) => [s.seedId, s]),
  );

  it("uses the complete runs once each, oldest first", () => {
    expect(calibration.runIds).toEqual([
      "run-1",
      "run-2",
      "run-3",
      "run-4",
      "run-5",
    ]);
  });

  it("counts detections and applies 2-of-3 over the first three runs", () => {
    expect(bySeed.S01).toMatchObject({ detectedIn: 3, wouldFileAt2of3: false });
    expect(bySeed.S02).toMatchObject({ detectedIn: 3, wouldFileAt2of3: true });
    expect(bySeed.S03).toMatchObject({ detectedIn: 1, wouldFileAt2of3: false });
    expect(bySeed.S04).toMatchObject({ detectedIn: 0, wouldFileAt2of3: false });
    expect(bySeed.S06).toMatchObject({
      kind: "decoy",
      detectedIn: 2,
      wouldFileAt2of3: false,
    });
  });

  it("reports the per-section score spread", () => {
    const sensitive = calibration.perSectionScoreSpread["sensitive-files"];
    expect(sensitive?.n).toBe(5);
    expect(sensitive?.min).toBe(80);
    expect(sensitive?.max).toBe(100);
    expect(sensitive?.stdev).toBeCloseTo(Math.sqrt(40), 10);
    expect(calibration.perSectionScoreSpread["secret-detection"]).toEqual({
      n: 5,
      min: 100,
      max: 100,
      stdev: 0,
    });
    expect(calibration.perSectionScoreSpread["supply-chain"]).toEqual({
      n: 0,
      min: null,
      max: null,
      stdev: null,
    });
  });

  it("is part of the bench report", () => {
    expect(score().calibration.perSeed).toHaveLength(6);
  });
});

describe("input parsing", () => {
  it("round-trips the synthetic export and verification through JSON", () => {
    const snapshot = parseExportSnapshot(
      JSON.parse(JSON.stringify(SYNTHETIC_LOOP_EXPORT)),
    );
    expect(snapshot.findings).toHaveLength(7);
    expect(snapshot.attempts[0]?.readyAt).toBe("2026-10-01T10:00:00.000Z");
    const verification = parseVerificationResult(
      JSON.parse(JSON.stringify(SYNTHETIC_VERIFICATION)),
    );
    expect(verification.prs).toHaveLength(4);
  });

  it("rejects an export without the ledger arrays", () => {
    expect(() => parseExportSnapshot({ repoFullName: "a/b" })).toThrow(
      /findings/,
    );
    expect(() =>
      parseVerificationResult({ repoFullName: "a/b", prs: "x" }),
    ).toThrow(/prs/);
  });
});
