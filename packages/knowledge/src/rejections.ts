// ENG-02: an owner's rejection holds until the evidence they saw differs.
// Op ids embed the merge revision, so a rejection is matched by fingerprints, never by op id: an
// unrelated merge mints a new op id for the same disagreement but leaves its fingerprint unchanged.
// Pure and fs-free (part of the core surface): the caller supplies the rejections, the engine never
// reads a store.
import type { DraftOp, DraftOpKind } from "./claims";

/**
 * A prior owner rejection, as the caller supplies it to reconcile.
 *
 * Pass only the LATEST rejection per claim, loaded from the signed decision ledger through the
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
  /** The rejected op's locatedEvidence: lets a later merge that does not touch a pin's file still match it. */
  locatedEvidence?: string[];
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
  "claimId" | "evidenceFingerprint"
>;

/**
 * True when the rejection still covers the op: same claim and the same evidence. The op kind is not part of
 * the match: the evidence fingerprint is what the owner saw, and the same evidence can surface as another
 * kind on a later merge (a rejected update on a file the next merge's diffs do not touch comes back as a
 * "no diff" review). The proposal is not part of it either: an update is suppressed before the model is
 * asked, so there is no proposal to compare. An op without an evidence fingerprint is never suppressed.
 */
export function matchesRejection(
  op: RejectionCandidate,
  r: RejectedOp,
): boolean {
  return (
    op.evidenceFingerprint !== undefined &&
    op.claimId === r.claimId &&
    op.evidenceFingerprint === r.evidenceFingerprint
  );
}

/** The first rejection that still covers the op, or undefined. */
export function findRejection(
  op: RejectionCandidate,
  rejected: readonly RejectedOp[],
): RejectedOp | undefined {
  return rejected.find((r) => matchesRejection(op, r));
}

/**
 * The rejection a decision ledger records for an op, or undefined for an op that carries no evidence
 * fingerprint (an auto repin is never rejectable). The one mapping from op to rejection, so the ledger
 * writer and reconcile cannot drift apart.
 */
export function rejectionOf(op: DraftOp): RejectedOp | undefined {
  if (op.evidenceFingerprint === undefined) return undefined;
  return {
    opId: op.id,
    claimId: op.claimId,
    op: op.op,
    evidenceFingerprint: op.evidenceFingerprint,
    ...(op.locatedEvidence ? { locatedEvidence: op.locatedEvidence } : {}),
  };
}
