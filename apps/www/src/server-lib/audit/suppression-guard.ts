import {
  FIX_COMPANION_FILES,
  allowedFilesFor,
  denyExceptionsFor,
  isDeniedPath,
  normalizeFixPath,
  type FixPathContext,
} from "@terragon/shared/self-heal/fix-paths";
import {
  GUARD_REASONS,
  type GuardReason,
} from "@terragon/shared/self-heal/guard-reasons";

/**
 * The R4 suppression / scope guard (R4, R5, FENCE-01 www half) on the GitHub
 * compare diff of a gated fix commit. Pure: no IO. It runs before any pull
 * request exists, so a fix that games the finding (silencing the tool,
 * editing the tests or the CI that judge it, deleting the flagged code) or
 * that reaches a persistence path never becomes a proposal.
 *
 * The worker's pushed-diff check (09-10) is local and advisory for www; this
 * guard on GitHub's own compare is the authoritative path check. Every path
 * in FIX_DENY_PATHS is rejected whatever the plan lists, except the exact
 * workflow file a `ci.*` rule's plan names (shared isDeniedPath).
 */

/** GitHub's compare lists at most this many files. */
export const COMPARE_FILE_CAP = 300;

export { GUARD_REASONS, type GuardReason };
export type GuardFlag = "new_test_file";

/** The slice of a GitHub compare `files[]` entry the guard reads. */
export interface FixDiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

export interface EvaluateFixDiffInput {
  files: readonly FixDiffFile[];
  planFiles: readonly string[] | null;
  ruleId: string;
  subject: string | null;
  maxDiffLines: number;
  /** GitHub's compare stopped listing files (its 300-file cap). */
  truncated?: boolean;
}

export interface FixDiffVerdict {
  ok: boolean;
  rejections: GuardReason[];
  flags: GuardFlag[];
  /** Added + deleted lines, lockfiles excluded. */
  diffLines: number;
}

/**
 * Markers that silence a linter, type checker, scanner or coverage gate.
 * Matched case-insensitively on added lines only.
 */
const SUPPRESSION_RES: readonly RegExp[] = [
  /eslint-disable/i,
  /@ts-ignore/i,
  /@ts-nocheck/i,
  /@ts-expect-error/i,
  /\bnosec\b/i,
  /\bnoqa\b/i,
  /istanbul\s+ignore/i,
  /\bc8\s+ignore/i,
  /\bv8\s+ignore/i,
  /\bNOSONAR\b/i,
  /\bnolint\b/i,
  /biome-ignore/i,
  /pylint:\s*disable/i,
];

/** Test files by name or directory, across the common ecosystems. */
const TEST_FILE_RES: readonly RegExp[] = [
  /(^|\/)(__tests__|__test__|tests?|spec|e2e)\//i,
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(go|py|rb|exs?)$/i,
  /_spec\.rb$/i,
  /(Test|Tests|IT)\.(java|kt|cs|swift)$/,
];

/** CI definitions other than `.github/` (which is also deny-listed). */
const CI_FILE_RES: readonly RegExp[] = [
  /^\.github\/(workflows|actions)\//i,
  /^\.gitlab-ci\.ya?ml$/i,
  /^\.gitlab\//i,
  /^\.circleci\//i,
  /^\.buildkite\//i,
  /^azure-pipelines\.ya?ml$/i,
  /^bitbucket-pipelines\.ya?ml$/i,
  /^jenkinsfile$/i,
  /^\.travis\.ya?ml$/i,
  /^\.drone\.ya?ml$/i,
];

/**
 * Files that configure what the audits and their tools report, at any depth:
 * lint configs, scanner ignore lists, dependency-audit allowlists and the
 * repo's audit decision records.
 */
const AUDIT_CONFIG_BASENAME_RES: readonly RegExp[] = [
  /^\.eslintrc(\.[\w]+)?$/i,
  /^eslint\.config\.[cm]?[jt]s$/i,
  /^\.eslintignore$/i,
  /^biome\.jsonc?$/i,
  /^\.semgrep(ignore|\.ya?ml)?$/i,
  /^\.snyk$/i,
  /^\.trivyignore$/i,
  /^\.gitleaks(\.toml|ignore)$/i,
  /^\.bandit$/i,
  /^\.nsprc$/i,
  /^audit-ci\.jsonc?$/i,
  /^\.auditignore$/i,
  /^\.npmauditrc$/i,
  /^sonar-project\.properties$/i,
  /^\.codeclimate\.ya?ml$/i,
  /^\.golangci\.ya?ml$/i,
  /^\.flake8$/i,
  /^\.pylintrc$/i,
  /^\.coveragerc$/i,
];
const AUDIT_CONFIG_DIR_RE = /^docs\/audit-scores\//i;

const LOCKFILES: ReadonlySet<string> = new Set(FIX_COMPANION_FILES.lockfiles);

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isLockfile(path: string): boolean {
  return LOCKFILES.has(basename(path));
}

function isTestFile(path: string): boolean {
  return TEST_FILE_RES.some((re) => re.test(path));
}

function isCiFile(path: string): boolean {
  return CI_FILE_RES.some((re) => re.test(path));
}

function isAuditConfig(path: string): boolean {
  return (
    AUDIT_CONFIG_DIR_RE.test(path) ||
    AUDIT_CONFIG_BASENAME_RES.some((re) => re.test(basename(path)))
  );
}

function addedLines(patch: string): string[] {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

function removedLines(patch: string): string[] {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---"))
    .map((line) => line.slice(1));
}

/**
 * The file's added lines carry a suppression marker. Lockfiles are exempt; a
 * file without a patch, or with an untrustworthy path, has nothing to scan.
 */
export function hasSuppressionMarker(
  file: Pick<FixDiffFile, "filename" | "patch">,
): boolean {
  const path = normalizeFixPath(file.filename);
  return (
    path !== null &&
    file.patch !== undefined &&
    !isLockfile(path) &&
    addedLines(file.patch).some((line) =>
      SUPPRESSION_RES.some((re) => re.test(line)),
    )
  );
}

/** A blank or comment-only line (a removed comment is not removed code). */
function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === "" ||
    /^(\/\/|#|\/\*|\*|\*\/|<!--|--|;)/.test(trimmed) ||
    trimmed.endsWith("*/")
  );
}

/** Removed or rewritten without a replacement line for the flagged code. */
function deletesCode(file: FixDiffFile): boolean {
  if (file.status === "removed") return true;
  if (file.additions > 0 || file.deletions === 0) return false;
  if (file.patch === undefined) return true;
  return removedLines(file.patch).some((line) => !isCommentOrBlank(line));
}

export function evaluateFixDiff(input: EvaluateFixDiffInput): FixDiffVerdict {
  const ctx: FixPathContext = {
    ruleId: input.ruleId,
    planFiles: input.planFiles,
  };
  const planned = new Set(
    (input.planFiles ?? [])
      .map(normalizeFixPath)
      .filter((p): p is string => p !== null),
  );
  const allowed = new Set(allowedFilesFor(input.planFiles));
  const ciExceptions = new Set(denyExceptionsFor(ctx));
  const subject =
    input.subject === null ? null : normalizeFixPath(input.subject);

  const reasons = new Set<GuardReason>();
  const flags = new Set<GuardFlag>();
  let diffLines = 0;

  if (input.truncated) reasons.add("patch_unavailable");

  for (const file of input.files) {
    const path = normalizeFixPath(file.filename);
    const previous =
      file.previous_filename !== undefined
        ? normalizeFixPath(file.previous_filename)
        : undefined;
    // An untrustworthy spelling on either side is a denied path.
    const sides = [file.filename, file.previous_filename].filter(
      (p): p is string => p !== undefined,
    );
    const denied = sides.some((p) => isDeniedPath(p, ctx));
    if (denied) reasons.add("denied_path");
    if (path === null || previous === null) continue;
    const touched = previous !== undefined ? [path, previous] : [path];

    const lockfile = isLockfile(path);
    if (!lockfile) diffLines += file.additions + file.deletions;

    let categorised = denied;
    const added = file.status === "added";
    // A new test is welcome; any change to an existing one is not.
    if (touched.some(isTestFile)) {
      if (added && previous === undefined) {
        flags.add("new_test_file");
        categorised = true;
      } else {
        reasons.add("test_edit");
        categorised = true;
      }
    }
    if (touched.some((p) => isCiFile(p) && !ciExceptions.has(p))) {
      reasons.add("ci_edit");
      categorised = true;
    }
    if (touched.some(isAuditConfig)) {
      reasons.add("audit_config_edit");
      categorised = true;
    }

    const flagged =
      planned.has(path) ||
      (previous !== undefined && planned.has(previous)) ||
      (subject !== null && touched.includes(subject));
    if (flagged && deletesCode(file)) reasons.add("deleted_flagged_code");

    if (!categorised && !touched.every((p) => allowed.has(p))) {
      reasons.add("out_of_plan_file");
    }

    if (file.patch !== undefined) {
      if (hasSuppressionMarker(file)) reasons.add("suppression_comment");
    } else if (!lockfile && file.status !== "removed" && file.additions > 0) {
      // Added lines GitHub would not show us cannot be scanned.
      reasons.add("patch_unavailable");
    }
  }

  if (diffLines > input.maxDiffLines) reasons.add("diff_too_large");

  const rejections = GUARD_REASONS.filter((reason) => reasons.has(reason));
  return {
    ok: rejections.length === 0,
    rejections,
    flags: [...flags],
    diffLines,
  };
}
