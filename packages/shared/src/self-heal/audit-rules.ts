/**
 * The closed audit rule vocabulary (phase 8). This is the ONLY rule source:
 * the audit skill lists exactly these ids, the findings parser drops any other
 * id, and the worker implements exactly these check kinds. Changing a rule
 * therefore needs a skill re-push AND a worker deploy.
 *
 * `publicSafe: false` rules (secrets, committed sensitive files) must never be
 * disclosed in a public issue; the decide step enforces that.
 *
 * This module imports nothing so any package or client can use it.
 */

export const AUDIT_IDS = ["security-audit"] as const;
export type AuditId = (typeof AUDIT_IDS)[number];

export const AUDIT_SECTIONS = {
  "security-audit": [
    "sensitive-files",
    "secret-detection",
    "dependency-security",
    "supply-chain",
    "security-automation",
  ],
} as const satisfies Record<AuditId, readonly string[]>;

export const AUDIT_CHECK_KINDS = [
  "npm-audit-clean",
  "workflow-actions-pinned",
  "workflow-has-permissions",
  "file-exists",
  "path-untracked",
  "gitignore-has-pattern",
  "gitleaks-clean",
] as const;
export type AuditCheckKind = (typeof AUDIT_CHECK_KINDS)[number];

export interface AuditRule {
  id: string;
  audit: AuditId;
  section: string;
  title: string;
  checkKind: "script" | "rubric";
  check: AuditCheckKind | null;
  subjectKind: "path" | "npm";
  publicSafe: boolean;
  checkDescription: string;
}

export const AUDIT_RULES: readonly AuditRule[] = [
  {
    id: "dep.vulnerable",
    audit: "security-audit",
    section: "dependency-security",
    title: "Vulnerable dependency",
    checkKind: "script",
    check: "npm-audit-clean",
    subjectKind: "npm",
    publicSafe: true,
    checkDescription:
      "The package has no advisory at or above the configured severity in the package manager audit.",
  },
  {
    id: "supply.lockfile-missing",
    audit: "security-audit",
    section: "supply-chain",
    title: "Lockfile missing",
    checkKind: "script",
    check: "file-exists",
    subjectKind: "path",
    publicSafe: true,
    checkDescription: "A dependency lockfile exists at the subject path.",
  },
  {
    id: "ci.action-unpinned",
    audit: "security-audit",
    section: "security-automation",
    title: "Workflow action not pinned to a commit SHA",
    checkKind: "script",
    check: "workflow-actions-pinned",
    subjectKind: "path",
    publicSafe: true,
    checkDescription:
      "The named action is referenced by full commit SHA in the workflow (key is the action name).",
  },
  {
    id: "ci.workflow-permissions-missing",
    audit: "security-audit",
    section: "security-automation",
    title: "Workflow has no explicit permissions block",
    checkKind: "script",
    check: "workflow-has-permissions",
    subjectKind: "path",
    publicSafe: true,
    checkDescription:
      "The workflow file declares a top-level permissions block.",
  },
  {
    id: "ci.security-policy-missing",
    audit: "security-audit",
    section: "security-automation",
    title: "Security policy missing",
    checkKind: "script",
    check: "file-exists",
    subjectKind: "path",
    publicSafe: true,
    checkDescription: "A security policy file exists at the subject path.",
  },
  {
    id: "files.gitignore-missing-pattern",
    audit: "security-audit",
    section: "sensitive-files",
    title: "Sensitive-file pattern missing from .gitignore",
    checkKind: "script",
    check: "gitignore-has-pattern",
    subjectKind: "path",
    publicSafe: true,
    checkDescription:
      "The .gitignore contains the literal pattern (key is the pattern).",
  },
  {
    id: "files.sensitive-committed",
    audit: "security-audit",
    section: "sensitive-files",
    title: "Sensitive file committed",
    checkKind: "script",
    check: "path-untracked",
    subjectKind: "path",
    publicSafe: false,
    checkDescription: "The subject path is not tracked by git.",
  },
  {
    id: "secret.hardcoded",
    audit: "security-audit",
    section: "secret-detection",
    title: "Hardcoded secret",
    checkKind: "script",
    check: "gitleaks-clean",
    subjectKind: "path",
    publicSafe: false,
    checkDescription: "A secret scan of the subject path reports no leak.",
  },
  {
    id: "automation.review-process",
    audit: "security-audit",
    section: "security-automation",
    title: "No automated review process",
    checkKind: "rubric",
    check: null,
    subjectKind: "path",
    publicSafe: true,
    checkDescription:
      "Judged against the audit rubric; there is no deterministic script.",
  },
];

export function getAuditRule(id: string): AuditRule | undefined {
  return AUDIT_RULES.find((rule) => rule.id === id);
}

/** Findings are confirmed by agreement across the last N runs. */
export const CONSENSUS_WINDOW = 3;
/** Runs in the window that must agree for a finding to count. */
export const CONSENSUS_QUORUM = 2;
/** Consecutive passing checks required before a finding closes. */
export const CLOSE_CONSECUTIVE_PASSES = 2;
/** Cap on findings accepted from a single audit run. */
export const MAX_FINDINGS_PER_RUN = 25;
/** Version of the audit findings payload schema. */
export const AUDIT_FINDINGS_SCHEMA_VERSION = 1;
