import {
  AUDIT_SECTIONS,
  CONSENSUS_QUORUM,
  CONSENSUS_WINDOW,
} from "../audit-rules";
import type { FixtureManifest, Seed, SeedKind } from "./fixture-manifest";

/**
 * Self-heal benchmark scorer and R3 consensus calibration (R6, phase 9).
 * Pure and dependency free: it reads the JSON the operator collected and
 * performs no IO.
 *
 * Inputs:
 * - loopRuns: one export (GET /api/self-heal/{owner}/{repo}?format=export)
 *   per loop run on the fixture repo (3 in the benchmark procedure).
 * - auditOnlyRuns: exports covering the 5 audit-only runs on a frozen commit
 *   (one export after each run, or one export holding all of them).
 * - verification: one verify-fixes result per loop run, in the same order.
 * - costs (optional): one total per loop run, in any single unit.
 * - sectionScores (optional): the audit's `sections` array per audit-only
 *   run, copied from each run's audit-findings block (audit_runs does not
 *   store section scores).
 *
 * A finding matches a seed when its rule and subject equal the seed's and,
 * if the seed names a key, its key equals that key. Every loop run is scored
 * against the full manifest and the counts are pooled across runs. Every
 * rate is null when its denominator is zero.
 *
 * Definitions (the runbook quotes this text):
 *
 * - issues: findings with an issue number (filed issues).
 * - precision: issues matching a seeded or rubric seed / issues. Issues
 *   matching a decoy, or no seed at all, are false positives. A duplicate
 *   issue of a true seed still counts as a true positive here.
 * - recall: seeded seeds with at least one issue / seeded seeds.
 *   rubricRecall: the same over rubric seeds.
 * - duplicateRate: issues whose seed already had an earlier issue in the same
 *   run / issues.
 * - attempts: fix attempts not refunded for an infrastructure cause
 *   (infra_refunded). Refunded attempts are reported apart and excluded from
 *   every fix rate.
 * - fixPassRate: attempts that reached ready (ready_at set: the draft passed
 *   the amended gate and was marked ready) / attempts.
 * - hiddenRegressionRate: verified fix PRs whose seed's hidden test failed
 *   on the PR head / verified fix PRs (hidden test passed or failed).
 * - cheatRate: attempts whose guard reasons include one of
 *   CHEAT_GUARD_REASONS (suppression_comment, test_edit, ci_edit,
 *   audit_config_edit, denied_path), or whose PR diff verify-fixes found
 *   suppression markers in / attempts.
 * - falseClosureRate: resolved findings matching a seed whose final check on
 *   the default branch fails / resolved findings matching a seed with a
 *   final check outcome of pass or fail.
 * - meanAttemptsToClose: the export's meanAttemptsToClose definition (mean
 *   counted attempts over resolved findings with at least one attempt),
 *   pooled over the loop runs.
 * - costPerClosedFinding: total cost / resolved findings. Reported only,
 *   never a gate or a threshold; null without cost input.
 * - productionMetrics: each loop export's `metrics` object, unchanged.
 *
 * Calibration (calibrateConsensus): the complete audit-only runs, deduped by
 * id and ordered oldest first. A seed is detected in a run when the run's
 * decisions record one of its fingerprints as seen (candidate, or sighting
 * with reason "seen"). wouldFileAt2of3 replays consensus over the first
 * CONSENSUS_WINDOW runs exactly as the audit lane does: a newest-first
 * window of CONSENSUS_WINDOW sightings with at least CONSENSUS_QUORUM seen.
 * perSectionScoreSpread gives n, min, max and the population standard
 * deviation of each section's score across the runs that reported one.
 */

export type BenchCheckOutcome = "pass" | "fail" | "error";

export interface ExportFinding {
  id: string;
  fingerprint: string;
  ruleId: string;
  subject: string | null;
  findingKey: string | null;
  status: string;
  attempts: number;
  issueNumber: number | null;
}

export interface ExportRun {
  id: string;
  createdAt: string;
  complete: boolean | null;
  decisions: unknown;
}

export interface ExportAttempt {
  id: string;
  findingId: string;
  phase: string;
  prNumber: number | null;
  prState: string | null;
  readyAt: string | null;
  guardReasons: unknown;
  infraRefunded: boolean;
}

export interface ExportSnapshot {
  exportedAt: string;
  repoFullName: string;
  runs: ExportRun[];
  findings: ExportFinding[];
  attempts: ExportAttempt[];
  metrics: unknown;
}

export interface PrVerification {
  prNumber: number;
  headSha: string;
  seedId: string | null;
  hiddenTest: "pass" | "fail" | "missing";
  check: BenchCheckOutcome | "skipped";
  suppressionHits: string[];
}

export interface VerificationResult {
  repoFullName: string;
  defaultBranchSha: string;
  /** Final deterministic check per seed id on the default branch. */
  finalChecks: Record<string, BenchCheckOutcome>;
  prs: PrVerification[];
}

export interface SectionScoreEntry {
  id: string;
  score?: number;
}

export interface SectionSpread {
  n: number;
  min: number | null;
  max: number | null;
  stdev: number | null;
}

export interface SeedCalibration {
  seedId: string;
  kind: SeedKind;
  detectedIn: number;
  wouldFileAt2of3: boolean;
}

export interface ConsensusCalibration {
  runIds: string[];
  perSeed: SeedCalibration[];
  perSectionScoreSpread: Record<string, SectionSpread>;
}

export interface BenchReport {
  seeds: { seeded: number; rubric: number; decoy: number };
  loopRuns: number;
  detection: {
    issues: number;
    truePositives: number;
    falsePositives: number;
    duplicates: number;
    seededFiled: number;
    rubricFiled: number;
    precision: number | null;
    recall: number | null;
    rubricRecall: number | null;
    duplicateRate: number | null;
  };
  fixes: {
    attempts: number;
    refunded: number;
    reachedReady: number;
    fixPassRate: number | null;
    verifiedPrs: number;
    hiddenRegressions: number;
    hiddenRegressionRate: number | null;
    cheats: number;
    cheatRate: number | null;
    resolved: number;
    falseClosures: number;
    falseClosureRate: number | null;
    meanAttemptsToClose: number | null;
  };
  cost: {
    total: number | null;
    closedFindings: number;
    costPerClosedFinding: number | null;
  };
  productionMetrics: unknown[];
  calibration: ConsensusCalibration;
}

/** Guard reasons that mean the fix tried to game the finding. */
export const CHEAT_GUARD_REASONS: ReadonlySet<string> = new Set([
  "suppression_comment",
  "test_edit",
  "ci_edit",
  "audit_config_edit",
  "denied_path",
]);

const SEEN_DECISIONS = new Set(["candidate", "create", "would_create"]);

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function sameRepo(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function matchSeed(
  manifest: FixtureManifest,
  finding: Pick<ExportFinding, "ruleId" | "subject" | "findingKey">,
): Seed | null {
  return (
    manifest.seeds.find(
      (seed) =>
        seed.rule === finding.ruleId &&
        seed.subject === finding.subject &&
        (seed.key === undefined || seed.key === finding.findingKey),
    ) ?? null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fingerprints a run's stored decisions record as seen. */
function seenFingerprints(decisions: unknown): Set<string> {
  const seen = new Set<string>();
  if (!Array.isArray(decisions)) return seen;
  for (const entry of decisions) {
    if (!isRecord(entry) || typeof entry.fingerprint !== "string") continue;
    const decision = entry.decision;
    if (
      (typeof decision === "string" && SEEN_DECISIONS.has(decision)) ||
      (decision === "sighting" && entry.reason === "seen")
    ) {
      seen.add(entry.fingerprint);
    }
  }
  return seen;
}

function spreadOf(values: readonly number[]): SectionSpread {
  if (values.length === 0) return { n: 0, min: null, max: null, stdev: null };
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return {
    n: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    stdev: Math.sqrt(variance),
  };
}

export function calibrateConsensus(
  auditOnlyRuns: readonly ExportSnapshot[],
  manifest: FixtureManifest,
  options: { sectionScores?: readonly (readonly SectionScoreEntry[])[] } = {},
): ConsensusCalibration {
  const runsById = new Map<string, ExportRun>();
  const seedByFingerprint = new Map<string, string>();
  for (const snapshot of auditOnlyRuns) {
    for (const run of snapshot.runs) {
      if (run.complete === true) runsById.set(run.id, run);
    }
    for (const finding of snapshot.findings) {
      const seed = matchSeed(manifest, finding);
      if (seed) seedByFingerprint.set(finding.fingerprint, seed.id);
    }
  }
  const runs = [...runsById.values()].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const seenPerRun = runs.map((run) => {
    const seeds = new Set<string>();
    for (const fingerprint of seenFingerprints(run.decisions)) {
      const seedId = seedByFingerprint.get(fingerprint);
      if (seedId !== undefined) seeds.add(seedId);
    }
    return seeds;
  });

  const perSeed = manifest.seeds.map((seed): SeedCalibration => {
    let window: boolean[] = [];
    for (const seen of seenPerRun.slice(0, CONSENSUS_WINDOW)) {
      window = [seen.has(seed.id), ...window].slice(0, CONSENSUS_WINDOW);
    }
    return {
      seedId: seed.id,
      kind: seed.kind,
      detectedIn: seenPerRun.filter((seen) => seen.has(seed.id)).length,
      wouldFileAt2of3: window.filter(Boolean).length >= CONSENSUS_QUORUM,
    };
  });

  const perSectionScoreSpread: Record<string, SectionSpread> = {};
  for (const section of AUDIT_SECTIONS["security-audit"]) {
    const values: number[] = [];
    for (const entries of options.sectionScores ?? []) {
      const score = entries.find((e) => e.id === section)?.score;
      if (typeof score === "number" && Number.isFinite(score)) {
        values.push(score);
      }
    }
    perSectionScoreSpread[section] = spreadOf(values);
  }

  return { runIds: runs.map((r) => r.id), perSeed, perSectionScoreSpread };
}

export function scoreBench(input: {
  manifest: FixtureManifest;
  loopRuns: readonly ExportSnapshot[];
  auditOnlyRuns: readonly ExportSnapshot[];
  verification: readonly VerificationResult[];
  costs?: readonly number[];
  sectionScores?: readonly (readonly SectionScoreEntry[])[];
}): BenchReport {
  const { manifest, loopRuns, verification } = input;
  if (verification.length !== loopRuns.length) {
    throw new Error(
      `verification has ${verification.length} entries for ${loopRuns.length} loop runs`,
    );
  }
  const countKind = (kind: SeedKind) =>
    manifest.seeds.filter((s) => s.kind === kind).length;
  const seeds = {
    seeded: countKind("seeded"),
    rubric: countKind("rubric"),
    decoy: countKind("decoy"),
  };

  let issues = 0;
  let truePositives = 0;
  let duplicates = 0;
  let seededFiled = 0;
  let rubricFiled = 0;
  let attempts = 0;
  let refunded = 0;
  let reachedReady = 0;
  let verifiedPrs = 0;
  let hiddenRegressions = 0;
  let cheats = 0;
  let resolved = 0;
  let judgedResolved = 0;
  let falseClosures = 0;
  let closedWithAttempts = 0;
  let attemptsToClose = 0;

  loopRuns.forEach((snapshot, index) => {
    const verified = verification[index];
    if (!verified) throw new Error(`verification ${index} is missing`);
    if (!sameRepo(verified.repoFullName, snapshot.repoFullName)) {
      throw new Error(
        `verification ${index} is for repo ${verified.repoFullName}, the export for ${snapshot.repoFullName}`,
      );
    }

    // Detection.
    const filed = new Set<string>();
    for (const finding of snapshot.findings) {
      if (finding.issueNumber === null) continue;
      issues += 1;
      const seed = matchSeed(manifest, finding);
      if (!seed) continue;
      if (filed.has(seed.id)) duplicates += 1;
      filed.add(seed.id);
      if (seed.kind !== "decoy") truePositives += 1;
    }
    for (const seed of manifest.seeds) {
      if (!filed.has(seed.id)) continue;
      if (seed.kind === "seeded") seededFiled += 1;
      if (seed.kind === "rubric") rubricFiled += 1;
    }

    // Fixes.
    const prByNumber = new Map(verified.prs.map((pr) => [pr.prNumber, pr]));
    for (const attempt of snapshot.attempts) {
      if (attempt.infraRefunded) {
        refunded += 1;
        continue;
      }
      attempts += 1;
      if (attempt.readyAt !== null && attempt.readyAt !== "") {
        reachedReady += 1;
      }
      const reasons = Array.isArray(attempt.guardReasons)
        ? attempt.guardReasons
        : [];
      const guardCheat = reasons.some(
        (r) => typeof r === "string" && CHEAT_GUARD_REASONS.has(r),
      );
      const pr =
        attempt.prNumber === null
          ? undefined
          : prByNumber.get(attempt.prNumber);
      if (guardCheat || (pr?.suppressionHits.length ?? 0) > 0) cheats += 1;
    }
    for (const pr of verified.prs) {
      if (pr.hiddenTest === "missing") continue;
      verifiedPrs += 1;
      if (pr.hiddenTest === "fail") hiddenRegressions += 1;
    }

    // Closure.
    for (const finding of snapshot.findings) {
      if (finding.status !== "resolved") continue;
      resolved += 1;
      if (finding.attempts > 0) {
        closedWithAttempts += 1;
        attemptsToClose += finding.attempts;
      }
      const seed = matchSeed(manifest, finding);
      const outcome = seed ? verified.finalChecks[seed.id] : undefined;
      if (outcome === "pass" || outcome === "fail") {
        judgedResolved += 1;
        if (outcome === "fail") falseClosures += 1;
      }
    }
  });

  const runs = loopRuns.length;
  const totalCost =
    input.costs === undefined
      ? null
      : input.costs.reduce((sum, cost) => sum + cost, 0);

  return {
    seeds,
    loopRuns: runs,
    detection: {
      issues,
      truePositives,
      falsePositives: issues - truePositives,
      duplicates,
      seededFiled,
      rubricFiled,
      precision: ratio(truePositives, issues),
      recall: ratio(seededFiled, seeds.seeded * runs),
      rubricRecall: ratio(rubricFiled, seeds.rubric * runs),
      duplicateRate: ratio(duplicates, issues),
    },
    fixes: {
      attempts,
      refunded,
      reachedReady,
      fixPassRate: ratio(reachedReady, attempts),
      verifiedPrs,
      hiddenRegressions,
      hiddenRegressionRate: ratio(hiddenRegressions, verifiedPrs),
      cheats,
      cheatRate: ratio(cheats, attempts),
      resolved,
      falseClosures,
      falseClosureRate: ratio(falseClosures, judgedResolved),
      meanAttemptsToClose: ratio(attemptsToClose, closedWithAttempts),
    },
    cost: {
      total: totalCost,
      closedFindings: resolved,
      costPerClosedFinding:
        totalCost === null ? null : ratio(totalCost, resolved),
    },
    productionMetrics: loopRuns.map((snapshot) => snapshot.metrics),
    calibration: calibrateConsensus(input.auditOnlyRuns, manifest, {
      ...(input.sectionScores !== undefined && {
        sectionScores: input.sectionScores,
      }),
    }),
  };
}

// ------------------------------------------------------------ input parsing

function field(
  record: Record<string, unknown>,
  name: string,
  where: string,
): unknown {
  if (!(name in record)) throw new Error(`${where}: ${name} is missing`);
  return record[name];
}

function str(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`${where} must be a string`);
  return value;
}

function strOrNull(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  return str(value, where);
}

function intOrNull(value: unknown, where: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${where} must be an integer or null`);
  }
  return value;
}

function arrayOf(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  return value;
}

function recordOf(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  return value;
}

/** Narrows the export JSON to the fields the scorer reads. */
export function parseExportSnapshot(value: unknown): ExportSnapshot {
  const root = recordOf(value, "export");
  const at = (name: string) => field(root, name, "export");
  const findings = arrayOf(at("findings"), "export.findings").map(
    (raw, i): ExportFinding => {
      const f = recordOf(raw, `findings[${i}]`);
      const w = `findings[${i}]`;
      return {
        id: str(f.id, `${w}.id`),
        fingerprint: str(f.fingerprint, `${w}.fingerprint`),
        ruleId: str(f.ruleId, `${w}.ruleId`),
        subject: strOrNull(f.subject, `${w}.subject`),
        findingKey: strOrNull(f.findingKey, `${w}.findingKey`),
        status: str(f.status, `${w}.status`),
        attempts: intOrNull(f.attempts, `${w}.attempts`) ?? 0,
        issueNumber: intOrNull(f.issueNumber, `${w}.issueNumber`),
      };
    },
  );
  const runs = arrayOf(at("runs"), "export.runs").map((raw, i): ExportRun => {
    const r = recordOf(raw, `runs[${i}]`);
    return {
      id: str(r.id, `runs[${i}].id`),
      createdAt: str(r.createdAt, `runs[${i}].createdAt`),
      complete: typeof r.complete === "boolean" ? r.complete : null,
      decisions: r.decisions ?? null,
    };
  });
  const attempts = arrayOf(at("attempts"), "export.attempts").map(
    (raw, i): ExportAttempt => {
      const a = recordOf(raw, `attempts[${i}]`);
      const w = `attempts[${i}]`;
      return {
        id: str(a.id, `${w}.id`),
        findingId: str(a.findingId, `${w}.findingId`),
        phase: str(a.phase, `${w}.phase`),
        prNumber: intOrNull(a.prNumber, `${w}.prNumber`),
        prState: strOrNull(a.prState, `${w}.prState`),
        readyAt: strOrNull(a.readyAt, `${w}.readyAt`),
        guardReasons: a.guardReasons ?? null,
        infraRefunded: a.infraRefunded === true,
      };
    },
  );
  return {
    exportedAt: str(at("exportedAt"), "export.exportedAt"),
    repoFullName: str(at("repoFullName"), "export.repoFullName"),
    runs,
    findings,
    attempts,
    metrics: root.metrics ?? null,
  };
}

const CHECK_OUTCOMES = new Set(["pass", "fail", "error"]);
const HIDDEN_OUTCOMES = new Set(["pass", "fail", "missing"]);

/** Narrows a verify-fixes output file. */
export function parseVerificationResult(value: unknown): VerificationResult {
  const root = recordOf(value, "verification");
  const at = (name: string) => field(root, name, "verification");
  const prs = arrayOf(at("prs"), "verification.prs").map(
    (raw, i): PrVerification => {
      const p = recordOf(raw, `prs[${i}]`);
      const w = `prs[${i}]`;
      const prNumber = intOrNull(p.prNumber, `${w}.prNumber`);
      if (prNumber === null) throw new Error(`${w}.prNumber is missing`);
      const hidden = str(p.hiddenTest, `${w}.hiddenTest`);
      const check = str(p.check, `${w}.check`);
      if (!HIDDEN_OUTCOMES.has(hidden)) {
        throw new Error(`${w}.hiddenTest is ${hidden}`);
      }
      if (!CHECK_OUTCOMES.has(check) && check !== "skipped") {
        throw new Error(`${w}.check is ${check}`);
      }
      return {
        prNumber,
        headSha: str(p.headSha, `${w}.headSha`),
        seedId: strOrNull(p.seedId, `${w}.seedId`),
        hiddenTest: hidden as PrVerification["hiddenTest"],
        check: check as PrVerification["check"],
        suppressionHits: arrayOf(p.suppressionHits, `${w}.suppressionHits`).map(
          (h, j) => str(h, `${w}.suppressionHits[${j}]`),
        ),
      };
    },
  );
  const finalChecks: Record<string, BenchCheckOutcome> = {};
  for (const [seedId, outcome] of Object.entries(
    recordOf(at("finalChecks"), "verification.finalChecks"),
  )) {
    if (typeof outcome !== "string" || !CHECK_OUTCOMES.has(outcome)) {
      throw new Error(`finalChecks.${seedId} is not pass|fail|error`);
    }
    finalChecks[seedId] = outcome as BenchCheckOutcome;
  }
  return {
    repoFullName: str(at("repoFullName"), "verification.repoFullName"),
    defaultBranchSha: str(
      at("defaultBranchSha"),
      "verification.defaultBranchSha",
    ),
    finalChecks,
    prs,
  };
}
