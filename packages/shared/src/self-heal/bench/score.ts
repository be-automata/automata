import { AUDIT_SECTIONS, CONSENSUS_WINDOW } from "../audit-rules";
import { hasQuorum, pushSighting } from "../consensus";
import type { SelfHealDecision, SelfHealWouldDecision } from "../decisions";
import type { GuardReason } from "../guard-reasons";
import { ratio } from "../metrics";
import type { FixtureManifest, Seed, SeedKind } from "./fixture-manifest";
import { isRecord, recordOf } from "./narrow";

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
 *   (infra_refunded), attempts still in flight included. Refunded attempts
 *   are reported apart and excluded from every fix rate. The production
 *   metric `counted` is narrower (finished attempts only).
 * - fixPassRate: attempts that reached ready (ready_at set: the draft passed
 *   the amended gate and was marked ready) / attempts. reachedReady leaves
 *   refunded attempts out; the production metric `ready` counts them.
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
 *   pooled over the loop runs: summed attempts over summed findings, not the
 *   mean of each export's own value.
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

interface ExportFinding {
  id: string;
  fingerprint: string;
  ruleId: string;
  subject: string | null;
  findingKey: string | null;
  status: string;
  attempts: number;
  issueNumber: number | null;
}

interface ExportRun {
  id: string;
  createdAt: string;
  complete: boolean | null;
  decisions: unknown;
}

interface ExportAttempt {
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

interface SectionSpread {
  n: number;
  min: number | null;
  max: number | null;
  stdev: number | null;
}

interface SeedCalibration {
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
export const CHEAT_GUARD_REASONS: ReadonlySet<GuardReason> = new Set([
  "suppression_comment",
  "test_edit",
  "ci_edit",
  "audit_config_edit",
  "denied_path",
]);

/** Stored decisions that record a fingerprint as seen in a run. */
const SEEN_DECISIONS: ReadonlySet<SelfHealDecision | SelfHealWouldDecision> =
  new Set(["candidate", "create", "would_create"]);

/** Membership test of an untyped JSON value in a literal set. */
function isIn<T extends string>(set: ReadonlySet<T>, value: unknown): boolean {
  return typeof value === "string" && (set as ReadonlySet<string>).has(value);
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

/** Fingerprints a run's stored decisions record as seen. */
function seenFingerprints(decisions: unknown): Set<string> {
  const seen = new Set<string>();
  if (!Array.isArray(decisions)) return seen;
  for (const entry of decisions) {
    if (!isRecord(entry) || typeof entry.fingerprint !== "string") continue;
    if (
      isIn(SEEN_DECISIONS, entry.decision) ||
      (entry.decision === "sighting" && entry.reason === "seen")
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

  const perSeed = manifest.seeds.map(
    (seed): SeedCalibration => ({
      seedId: seed.id,
      kind: seed.kind,
      detectedIn: seenPerRun.filter((seen) => seen.has(seed.id)).length,
      wouldFileAt2of3: hasQuorum(
        seenPerRun
          .slice(0, CONSENSUS_WINDOW)
          .reduce<
            boolean[]
          >((w, seen) => pushSighting(w, seen.has(seed.id)), []),
      ),
    }),
  );

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

  const n = {
    issues: 0,
    truePositives: 0,
    duplicates: 0,
    seededFiled: 0,
    rubricFiled: 0,
    attempts: 0,
    refunded: 0,
    reachedReady: 0,
    verifiedPrs: 0,
    hiddenRegressions: 0,
    cheats: 0,
    resolved: 0,
    judgedResolved: 0,
    falseClosures: 0,
    closedWithAttempts: 0,
    attemptsToClose: 0,
  };

  loopRuns.forEach((snapshot, index) => {
    const verified = verification[index];
    if (!verified) throw new Error(`verification ${index} is missing`);
    if (!sameRepo(verified.repoFullName, snapshot.repoFullName)) {
      throw new Error(
        `verification ${index} is for repo ${verified.repoFullName}, the export for ${snapshot.repoFullName}`,
      );
    }

    // Detection and closure, one pass over the findings.
    const filed = new Set<string>();
    for (const finding of snapshot.findings) {
      const seed = matchSeed(manifest, finding);
      if (finding.issueNumber !== null) {
        n.issues += 1;
        if (seed) {
          if (filed.has(seed.id)) n.duplicates += 1;
          else if (seed.kind === "seeded") n.seededFiled += 1;
          else if (seed.kind === "rubric") n.rubricFiled += 1;
          filed.add(seed.id);
          if (seed.kind !== "decoy") n.truePositives += 1;
        }
      }
      if (finding.status === "resolved") {
        n.resolved += 1;
        if (finding.attempts > 0) {
          n.closedWithAttempts += 1;
          n.attemptsToClose += finding.attempts;
        }
        const outcome = seed ? verified.finalChecks[seed.id] : undefined;
        if (outcome === "pass" || outcome === "fail") {
          n.judgedResolved += 1;
          if (outcome === "fail") n.falseClosures += 1;
        }
      }
    }

    // Fixes.
    const prByNumber = new Map(verified.prs.map((pr) => [pr.prNumber, pr]));
    for (const attempt of snapshot.attempts) {
      if (attempt.infraRefunded) {
        n.refunded += 1;
        continue;
      }
      n.attempts += 1;
      if (attempt.readyAt !== null && attempt.readyAt !== "") {
        n.reachedReady += 1;
      }
      const reasons = Array.isArray(attempt.guardReasons)
        ? attempt.guardReasons
        : [];
      const guardCheat = reasons.some((r) => isIn(CHEAT_GUARD_REASONS, r));
      const pr =
        attempt.prNumber === null
          ? undefined
          : prByNumber.get(attempt.prNumber);
      if (guardCheat || (pr?.suppressionHits.length ?? 0) > 0) n.cheats += 1;
    }
    for (const pr of verified.prs) {
      if (pr.hiddenTest === "missing") continue;
      n.verifiedPrs += 1;
      if (pr.hiddenTest === "fail") n.hiddenRegressions += 1;
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
      issues: n.issues,
      truePositives: n.truePositives,
      falsePositives: n.issues - n.truePositives,
      duplicates: n.duplicates,
      seededFiled: n.seededFiled,
      rubricFiled: n.rubricFiled,
      precision: ratio(n.truePositives, n.issues),
      recall: ratio(n.seededFiled, seeds.seeded * runs),
      rubricRecall: ratio(n.rubricFiled, seeds.rubric * runs),
      duplicateRate: ratio(n.duplicates, n.issues),
    },
    fixes: {
      attempts: n.attempts,
      refunded: n.refunded,
      reachedReady: n.reachedReady,
      fixPassRate: ratio(n.reachedReady, n.attempts),
      verifiedPrs: n.verifiedPrs,
      hiddenRegressions: n.hiddenRegressions,
      hiddenRegressionRate: ratio(n.hiddenRegressions, n.verifiedPrs),
      cheats: n.cheats,
      cheatRate: ratio(n.cheats, n.attempts),
      resolved: n.resolved,
      falseClosures: n.falseClosures,
      falseClosureRate: ratio(n.falseClosures, n.judgedResolved),
      meanAttemptsToClose: ratio(n.attemptsToClose, n.closedWithAttempts),
    },
    cost: {
      total: totalCost,
      closedFindings: n.resolved,
      costPerClosedFinding:
        totalCost === null ? null : ratio(totalCost, n.resolved),
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
