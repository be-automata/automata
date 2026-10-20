/**
 * Finding verifier — deterministic verify-before-block.
 *
 * Ported from orch-agents (`src/review/finding-verifier.ts` @ b337099). A
 * review skill must quote the verbatim source line(s) for every finding at or
 * above the blocking tolerance. This module re-reads the file AT THE REVIEWED
 * COMMIT and confirms the quoted text appears at `line ± QUOTE_LINE_TOLERANCE`.
 * A finding whose quote cannot be reproduced is de-fanged by
 * verify-before-block before the severity floor runs, so a hallucinated finding
 * can never block a PR on its own (a customer incident: a `[warning]` citing a
 * duplicated return that existed in no commit of the PR).
 *
 * Adaptation: legacy read the PR-head worktree from disk; here the control
 * plane has no checkout, so the file is read through an injected
 * {@link FileAtCommitReader} (the GitHub contents API at the reviewed commit in
 * www). A reader can report that it could NOT check a file (API outage, binary
 * content) — `unchecked` — which is deliberately distinct from "the file is not
 * there": an outage must never change a verdict.
 *
 * Matching is unchanged from legacy: whitespace-insensitive per line (both
 * sides trimmed), the quote's non-empty lines must appear CONSECUTIVELY,
 * starting within the tolerance window around the claimed line. Pure apart
 * from the injected reader.
 */

/** How far (in lines) the quote may start from the claimed `line`. */
export const QUOTE_LINE_TOLERANCE = 3;

export type FindingVerification =
  | "verified"
  | "quote-not-found"
  | "file-not-found"
  | "no-quote"
  | "unchecked";

export interface VerifiableFinding {
  /** Repo-relative path of the flagged file. */
  path: string;
  /** 1-based line the finding claims to be at. */
  line: number;
  /** Verbatim source line(s) the finding quotes. */
  quote?: string;
}

/** What a reader found for one path at the reviewed commit. */
export type FileAtCommit =
  | { kind: "content"; text: string }
  /** The path does not exist at that commit. */
  | { kind: "missing" }
  /** The reader could not tell (transient API failure, binary file). */
  | { kind: "unchecked"; reason: string };

export type FileAtCommitReader = (path: string) => Promise<FileAtCommit>;

export interface FindingVerificationResult {
  result: FindingVerification;
  /** Why the file could not be checked; set only for `unchecked`. */
  reason?: string;
}

/** Split into trimmed lines, dropping blank ones (whitespace-insensitive match). */
function significantLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * A repo-relative path the reader may be asked for. Absolute paths and any
 * `..` segment are refused: the legacy containment check, which kept a finding
 * from naming a file outside the reviewed tree.
 */
export function isRepoRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.startsWith("\\")) {
    return false;
  }
  return !path.split(/[\\/]/).some((segment) => segment === "..");
}

/**
 * Whether the quote's lines appear consecutively in `content`, starting within
 * `line ± QUOTE_LINE_TOLERANCE`. Blank FILE lines are skipped while matching
 * (they carry no signal after trimming), blank QUOTE lines were already dropped.
 */
export function quoteMatchesContent(
  finding: Pick<VerifiableFinding, "line" | "quote">,
  content: string,
): boolean {
  const quoteLines = significantLines(finding.quote ?? "");
  if (quoteLines.length === 0) return false;
  const fileLines = content.split("\n").map((l) => l.trim());
  const claimed = finding.line - 1;
  const from = Math.max(0, claimed - QUOTE_LINE_TOLERANCE);
  const to = Math.min(fileLines.length - 1, claimed + QUOTE_LINE_TOLERANCE);
  for (let start = from; start <= to; start++) {
    let matched = 0;
    let i = start;
    while (matched < quoteLines.length && i < fileLines.length) {
      const fileLine = fileLines[i] ?? "";
      if (fileLine.length === 0) {
        i++;
        continue;
      }
      if (fileLine !== quoteLines[matched]) break;
      matched++;
      i++;
    }
    if (matched === quoteLines.length) return true;
  }
  return false;
}

/**
 * Verify one finding's quote against the file at the reviewed commit.
 *
 *   - `no-quote`        — quote absent/blank (nothing to verify).
 *   - `file-not-found`  — path not repo-relative, or absent at that commit.
 *   - `unchecked`       — the reader could not check it (outage, binary).
 *   - `quote-not-found` — file read, quoted lines not found near the line.
 *   - `verified`        — quote reproduced at (or near) the claimed line.
 */
export async function verifyFindingQuote(
  finding: VerifiableFinding,
  readFile: FileAtCommitReader,
): Promise<FindingVerificationResult> {
  if (significantLines(finding.quote ?? "").length === 0) {
    return { result: "no-quote" };
  }
  if (!isRepoRelativePath(finding.path)) return { result: "file-not-found" };
  const file = await readFile(finding.path);
  if (file.kind === "missing") return { result: "file-not-found" };
  if (file.kind === "unchecked") {
    return { result: "unchecked", reason: file.reason };
  }
  return quoteMatchesContent(finding, file.text)
    ? { result: "verified" }
    : { result: "quote-not-found" };
}
