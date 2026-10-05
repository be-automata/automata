import type { FixtureManifest } from "../fixture-manifest";
import type { ExportSnapshot, VerificationResult } from "../score";

/**
 * Synthetic benchmark inputs with hand-computed expected metrics. Used by
 * score.test.ts and by the score CLI smoke run (deploy/self-heal-bench).
 *
 * Loop export: 6 filed issues. S01..S04 are filed (S01 twice: a second
 * fingerprint with a key), the decoy S06 once, S05 only as a candidate.
 * Expected: precision 5/6, recall 4/5, duplicateRate 1/6, fixPassRate 4/5,
 * cheatRate 2/5, hiddenRegressionRate 1/4, falseClosureRate 1/3,
 * meanAttemptsToClose 4/3, costPerClosedFinding 12/3.
 *
 * Audit-only exports: 5 complete runs (plus one incomplete run that must be
 * ignored), split over two overlapping snapshots. S01 seen in runs 1, 4, 5;
 * S02 in 1, 2, 3; S03 in 2; decoy S06 in 3 and 5.
 */

export const SYNTHETIC_MANIFEST: FixtureManifest = {
  version: 1,
  seeds: [
    {
      id: "S01",
      rule: "dep.vulnerable",
      subject: "npm:lodash",
      kind: "seeded",
      check: "npm-audit-clean",
      hiddenTest: "hidden-tests/S01.test.mjs",
    },
    {
      id: "S02",
      rule: "supply.lockfile-missing",
      subject: "packages/a/package-lock.json",
      kind: "seeded",
      check: "file-exists",
      hiddenTest: "hidden-tests/S02.test.mjs",
    },
    {
      id: "S03",
      rule: "ci.action-unpinned",
      subject: ".github/workflows/release.yml",
      key: "actions/cache",
      kind: "seeded",
      check: "workflow-actions-pinned",
      hiddenTest: "hidden-tests/S03.test.mjs",
    },
    {
      id: "S04",
      rule: "files.gitignore-missing-pattern",
      subject: ".gitignore",
      key: ".env",
      kind: "seeded",
      check: "gitignore-has-pattern",
      hiddenTest: "hidden-tests/S04.test.mjs",
    },
    {
      id: "S05",
      rule: "secret.hardcoded",
      subject: "src/services/payments.js",
      kind: "seeded",
      check: "gitleaks-clean",
      hiddenTest: "hidden-tests/S05.test.mjs",
    },
    {
      id: "S06",
      rule: "ci.workflow-permissions-missing",
      subject: ".github/workflows/ci.yml",
      kind: "decoy",
      check: "workflow-has-permissions",
      hiddenTest: "hidden-tests/S06.test.mjs",
    },
  ],
};

const REPO = "bench-owner/bench-fixture";

const finding = (
  id: string,
  ruleId: string,
  subject: string,
  findingKey: string | null,
  status: string,
  attempts: number,
  issueNumber: number | null,
) => ({
  id,
  fingerprint: `fp${id}`.padEnd(16, "0"),
  ruleId,
  subject,
  findingKey,
  status,
  attempts,
  issueNumber,
});

const attempt = (
  id: string,
  findingId: string,
  fields: {
    phase?: string;
    prNumber?: number | null;
    prState?: string | null;
    readyAt?: string | null;
    guardReasons?: string[] | null;
    infraRefunded?: boolean;
  },
) => ({
  id,
  findingId,
  phase: fields.phase ?? "closed",
  prNumber: fields.prNumber ?? null,
  prState: fields.prState ?? null,
  readyAt: fields.readyAt ?? null,
  guardReasons: fields.guardReasons ?? null,
  infraRefunded: fields.infraRefunded ?? false,
});

const READY = "2026-10-01T10:00:00.000Z";

export const SYNTHETIC_LOOP_EXPORT: ExportSnapshot = {
  exportedAt: "2026-10-02T00:00:00.000Z",
  repoFullName: REPO,
  runs: [],
  findings: [
    finding("f1", "dep.vulnerable", "npm:lodash", null, "resolved", 1, 11),
    finding(
      "f2",
      "supply.lockfile-missing",
      "packages/a/package-lock.json",
      null,
      "resolved",
      2,
      12,
    ),
    finding(
      "f3",
      "ci.action-unpinned",
      ".github/workflows/release.yml",
      "actions/cache",
      "open",
      1,
      13,
    ),
    finding(
      "f4",
      "files.gitignore-missing-pattern",
      ".gitignore",
      ".env",
      "resolved",
      1,
      14,
    ),
    finding(
      "f5",
      "dep.vulnerable",
      "npm:lodash",
      "cve-2019-10744",
      "open",
      0,
      15,
    ),
    finding(
      "f6",
      "ci.workflow-permissions-missing",
      ".github/workflows/ci.yml",
      null,
      "open",
      0,
      16,
    ),
    finding(
      "f7",
      "secret.hardcoded",
      "src/services/payments.js",
      null,
      "candidate",
      0,
      null,
    ),
  ],
  attempts: [
    attempt("a1", "f1", { prNumber: 21, prState: "merged", readyAt: READY }),
    attempt("a2", "f2", { guardReasons: ["test_edit"] }),
    attempt("a3", "f2", { prNumber: 23, prState: "merged", readyAt: READY }),
    attempt("a4", "f3", {
      phase: "ready",
      prNumber: 24,
      prState: "ready",
      readyAt: READY,
    }),
    attempt("a5", "f4", { prNumber: 25, prState: "merged", readyAt: READY }),
    attempt("a6", "f3", { infraRefunded: true }),
  ],
  metrics: { prsOpened: 4, mergeRate: 0.75 },
};

export const SYNTHETIC_VERIFICATION: VerificationResult = {
  repoFullName: REPO,
  defaultBranchSha: "a".repeat(40),
  finalChecks: {
    S01: "pass",
    S02: "pass",
    S03: "fail",
    S04: "fail",
    S05: "fail",
    S06: "pass",
  },
  prs: [
    {
      prNumber: 21,
      headSha: "1".repeat(40),
      seedId: "S01",
      hiddenTest: "pass",
      check: "pass",
      suppressionHits: [],
    },
    {
      prNumber: 23,
      headSha: "3".repeat(40),
      seedId: "S02",
      hiddenTest: "fail",
      check: "pass",
      suppressionHits: [],
    },
    {
      prNumber: 24,
      headSha: "4".repeat(40),
      seedId: "S03",
      hiddenTest: "pass",
      check: "pass",
      suppressionHits: ["eslint-disable"],
    },
    {
      prNumber: 25,
      headSha: "5".repeat(40),
      seedId: "S04",
      hiddenTest: "pass",
      check: "pass",
      suppressionHits: [],
    },
  ],
};

/** Expected loop metrics for one copy of the synthetic loop export. */
export const SYNTHETIC_EXPECTED = {
  precision: 5 / 6,
  recall: 4 / 5,
  duplicateRate: 1 / 6,
  fixPassRate: 4 / 5,
  cheatRate: 2 / 5,
  hiddenRegressionRate: 1 / 4,
  falseClosureRate: 1 / 3,
  meanAttemptsToClose: 4 / 3,
  costPerClosedFinding: 12 / 3,
} as const;

const fp = (id: string) => `fp${id}`.padEnd(16, "0");

const auditFindings = [
  finding("a", "dep.vulnerable", "npm:lodash", null, "candidate", 0, null),
  finding(
    "b",
    "supply.lockfile-missing",
    "packages/a/package-lock.json",
    null,
    "candidate",
    0,
    null,
  ),
  finding(
    "c",
    "ci.action-unpinned",
    ".github/workflows/release.yml",
    "actions/cache",
    "candidate",
    0,
    null,
  ),
  finding(
    "d",
    "ci.workflow-permissions-missing",
    ".github/workflows/ci.yml",
    null,
    "candidate",
    0,
    null,
  ),
];

const seen = (id: string) => ({
  fingerprint: fp(id),
  action: "sighting",
  reason: "seen",
});
const absent = (id: string) => ({
  fingerprint: fp(id),
  action: "sighting",
  reason: "absent",
});
const candidate = (id: string) => ({
  fingerprint: fp(id),
  action: "candidate",
  reason: "first_sighting",
});

const run = (
  n: number,
  complete: boolean,
  decisions: Record<string, string>[],
) => ({
  id: `run-${n}`,
  createdAt: `2026-10-01T0${n}:00:00.000Z`,
  complete,
  decisions,
});

const AUDIT_RUNS = [
  run(1, true, [candidate("a"), candidate("b")]),
  run(2, true, [absent("a"), seen("b"), candidate("c")]),
  run(3, true, [absent("a"), seen("b"), candidate("d")]),
  run(4, true, [seen("a")]),
  run(5, true, [seen("a"), seen("d")]),
  run(6, false, [seen("c")]),
];

export const SYNTHETIC_AUDIT_ONLY_EXPORTS: ExportSnapshot[] = [
  {
    exportedAt: "2026-10-01T03:30:00.000Z",
    repoFullName: REPO,
    runs: AUDIT_RUNS.slice(0, 3).reverse(),
    findings: auditFindings,
    attempts: [],
    metrics: null,
  },
  {
    exportedAt: "2026-10-01T06:30:00.000Z",
    repoFullName: REPO,
    runs: [...AUDIT_RUNS].reverse(),
    findings: auditFindings,
    attempts: [],
    metrics: null,
  },
];

/** The audit's per-section scores, one array per complete audit-only run. */
export const SYNTHETIC_SECTION_SCORES = [80, 90, 100, 90, 90].map((score) => [
  { id: "sensitive-files", score },
  { id: "secret-detection", score: 100 },
]);
