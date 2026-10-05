import type { FixChangedRanges } from "@terragon/shared/model/audit-fix-attempts";

import { parseHunkRanges, rangesOverlap } from "./hunks";

/**
 * Regression detectors for merged self-heal fixes (R5). Pure: they read
 * commit data the sweep fetched and decide nothing beyond "this looks like
 * a revert" / "this human commit edits the lines the fix changed". A false
 * positive can only STOP the loop (a breaker narrows), never start or merge
 * anything (T-09-15-2).
 */

export interface RevertTarget {
  /** The merge commit on the default branch, when known. */
  mergeSha: string | null;
  prNumber: number;
  /** The PR title, when known (the platform renders it). */
  prTitle: string | null;
}

export interface RevertVerdict {
  reverted: boolean;
  revertSha?: string;
}

const REVERT_SUBJECT_RE = /^Revert "(.*)"(?:\s+\(#\d+\))?\s*$/;
const REVERTS_COMMIT_RE = /This reverts commit ([0-9a-f]{7,40})\b/gi;
const MIN_SHA_PREFIX = 7;

function subjectOf(message: string): string {
  return (message.split("\n", 1)[0] ?? "").trim();
}

function revertsCommit(message: string, mergeSha: string | null): boolean {
  if (mergeSha === null || mergeSha.length < MIN_SHA_PREFIX) return false;
  const full = mergeSha.toLowerCase();
  for (const match of message.matchAll(REVERTS_COMMIT_RE)) {
    const sha = (match[1] ?? "").toLowerCase();
    if (sha.length >= MIN_SHA_PREFIX && full.startsWith(sha)) return true;
  }
  return false;
}

function revertsPullRequest(message: string, prNumber: number): boolean {
  return new RegExp(`^Reverts [\\w.-]+/[\\w.-]+#${prNumber}\\b`, "m").test(
    message,
  );
}

function revertsTitle(subject: string, target: RevertTarget): boolean {
  const inner = REVERT_SUBJECT_RE.exec(subject)?.[1]?.trim();
  if (inner === undefined) return false;
  if (inner.startsWith(`Merge pull request #${target.prNumber} `)) return true;
  const title = target.prTitle?.trim();
  if (!title) return false;
  return inner === title || inner === `${title} (#${target.prNumber})`;
}

/**
 * A commit that reverts the merged fix: git's default message for the merge
 * sha ("This reverts commit <sha>"), GitHub's revert-PR body ("Reverts
 * owner/repo#N"), or a `Revert "<PR title>"` subject. A revert of a revert
 * puts the fix back, so it never counts.
 */
export function detectRevert(
  commits: ReadonlyArray<{ sha: string; message: string }>,
  target: RevertTarget,
): RevertVerdict {
  for (const commit of commits) {
    const subject = subjectOf(commit.message);
    if (subject.startsWith('Revert "Revert ')) continue;
    if (
      revertsCommit(commit.message, target.mergeSha) ||
      revertsPullRequest(commit.message, target.prNumber) ||
      revertsTitle(subject, target)
    ) {
      return { reverted: true, revertSha: commit.sha };
    }
  }
  return { reverted: false };
}

export interface FollowupCommit {
  sha: string;
  /** null when the commit is not linked to a GitHub user. */
  authorLogin: string | null;
  files: ReadonlyArray<{ filename: string; patch?: string }>;
}

/** A GitHub user that is an App or this platform's bot. */
export function isBotUser(
  user: { login?: string; type?: string } | null | undefined,
  botLogin: string,
): boolean {
  const login = user?.login?.toLowerCase();
  if (user?.type === "Bot") return true;
  if (login === undefined) return false;
  return login === botLogin.toLowerCase() || login.endsWith("[bot]");
}

/**
 * Non-bot commits whose edits (old-side hunk ranges: the lines as they
 * were after the merge) overlap a merged range of the same file. A
 * follow-up fix to the agent's own lines is the regression signal; the hunk
 * context lines make the match deliberately a little wide. Each sha once.
 */
export function findFollowupOverlaps(
  commitFiles: readonly FollowupCommit[],
  changedRanges: FixChangedRanges,
  botLogin: string,
): string[] {
  const merged = new Map(changedRanges.map((c) => [c.file, c.ranges]));
  const out: string[] = [];
  for (const commit of commitFiles) {
    const login = commit.authorLogin ?? undefined;
    if (isBotUser({ login }, botLogin)) continue;
    const touches = commit.files.some((file) => {
      const ranges = merged.get(file.filename);
      if (ranges === undefined) return false;
      return parseHunkRanges(file.patch, "old").some((edited) =>
        ranges.some((range) => rangesOverlap(edited, range)),
      );
    });
    if (touches && !out.includes(commit.sha)) out.push(commit.sha);
  }
  return out;
}
