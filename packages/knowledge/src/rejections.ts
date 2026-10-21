// ENG-02: an owner's rejection holds until the evidence they saw, or the change proposed, differs.
// Op ids embed the merge revision, so a rejection is matched by fingerprints, never by op id: an
// unrelated merge mints a new op id for the same disagreement but leaves its fingerprint unchanged.
// Pure and fs-free (part of the core surface): the caller supplies the rejections, the engine never
// reads a store.
import type { DraftOp, DraftOpKind } from "./claims";

/**
 * A prior owner rejection, as the caller supplies it to reconcile.
 *
 * Pass only the LATEST rejection per (claimId, op), loaded from the signed decision ledger through the
 * ADR-001 org-scoped accessor, never from request input: the engine cannot verify where a rejection came
 * from. Drop a rejection once a later reconcile saw the claim fresh, otherwise a restore-then-delete
 * cycle would stay suppressed.
 */
export interface RejectedOp {
  /** The id of the op the owner rejected. */
  opId: string;
  claimId: string;
  op: DraftOpKind;
  /** The rejected op's evidenceFingerprint. */
  evidenceFingerprint: string;
  /** The rejected op's proposalFingerprint (update/reverify only). */
  proposalFingerprint?: string;
}

/**
 * An op a prior rejection still covers. Observable, never silently dropped: kept on the draft for audit
 * and the digest.
 */
export interface SuppressedOp {
  claimId: string;
  op: DraftOpKind;
  rejectedOpId: string;
  evidenceFingerprint: string;
}

export type RejectionCandidate = Pick<
  DraftOp,
  "claimId" | "op" | "evidenceFingerprint" | "proposalFingerprint"
>;

/**
 * True when the rejection still covers the op: same claim, same op kind and the same evidence. When both
 * carry a proposal fingerprint they must agree too; evidence equality alone is the gate otherwise. An op
 * without an evidence fingerprint is never suppressed.
 */
export function matchesRejection(
  op: RejectionCandidate,
  r: RejectedOp,
): boolean {
  if (op.evidenceFingerprint === undefined) return false;
  return (
    op.claimId === r.claimId &&
    op.op === r.op &&
    op.evidenceFingerprint === r.evidenceFingerprint &&
    (op.proposalFingerprint === undefined ||
      r.proposalFingerprint === undefined ||
      op.proposalFingerprint === r.proposalFingerprint)
  );
}

/** The first rejection that still covers the op, or undefined. */
export function findRejection(
  op: RejectionCandidate,
  rejected: readonly RejectedOp[],
): RejectedOp | undefined {
  return rejected.find((r) => matchesRejection(op, r));
}
