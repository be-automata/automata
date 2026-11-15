/**
 * The one definition of the self-heal fix-branch name, shared by `@terragon/shared`,
 * www and the worker.
 *
 * Dependency-free on purpose (no imports at all): any plane and the deploy tsx
 * scripts can load it without alias resolution, and the three planes cannot drift
 * because there is one copy.
 */

/** Every fix branch starts with this; the git-broker ref fence accepts nothing else. */
export const FIX_BRANCH_PREFIX = "automata/fix-";

export const FIX_FINGERPRINT_RE = /^[0-9a-f]{8,}$/;

export interface FixBranchNameInput {
  issueNumber: number;
  fingerprint: string;
  attemptNo: number;
}

function assertPositiveInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`fix run ${what} must be a positive integer, got ${value}`);
  }
}

/** `automata/fix-<issue>-<fp8>-a<attempt>` — one branch per attempt. */
export function fixBranchName({
  issueNumber,
  fingerprint,
  attemptNo,
}: FixBranchNameInput): string {
  assertPositiveInteger(issueNumber, "issue number");
  assertPositiveInteger(attemptNo, "attempt number");
  if (!FIX_FINGERPRINT_RE.test(fingerprint)) {
    throw new Error("fix run fingerprint must be lowercase hex (>= 8 chars)");
  }
  return `${FIX_BRANCH_PREFIX}${issueNumber}-${fingerprint.slice(0, 8)}-a${attemptNo}`;
}
