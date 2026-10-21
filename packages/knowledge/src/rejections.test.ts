import { describe, expect, it } from "vitest";

import {
  findRejection,
  matchesRejection,
  type RejectedOp,
  type RejectionCandidate,
} from "./rejections";

const FP = "0123456789abcdef";
const OTHER_FP = "fedcba9876543210";
const REJECTED: RejectedOp = {
  opId: "conflict:billing-faq/trial-length@007a8a0bbf45",
  claimId: "trial-length",
  op: "conflict",
  evidenceFingerprint: FP,
};
const CANDIDATE: RejectionCandidate = {
  claimId: "trial-length",
  op: "conflict",
  evidenceFingerprint: FP,
};

describe("matchesRejection", () => {
  it.each<[string, RejectionCandidate, RejectedOp, boolean]>([
    ["same claim, op and evidence", CANDIDATE, REJECTED, true],
    [
      "different claim",
      { ...CANDIDATE, claimId: "seat-price" },
      REJECTED,
      false,
    ],
    ["different op kind", { ...CANDIDATE, op: "review" }, REJECTED, false],
    [
      "different evidence fingerprint",
      { ...CANDIDATE, evidenceFingerprint: OTHER_FP },
      REJECTED,
      false,
    ],
    [
      "candidate without an evidence fingerprint",
      { claimId: "trial-length", op: "conflict" },
      REJECTED,
      false,
    ],
    [
      "both proposal fingerprints, different",
      { ...CANDIDATE, op: "update", proposalFingerprint: FP },
      { ...REJECTED, op: "update", proposalFingerprint: OTHER_FP },
      false,
    ],
    [
      "both proposal fingerprints, equal",
      { ...CANDIDATE, op: "update", proposalFingerprint: FP },
      { ...REJECTED, op: "update", proposalFingerprint: FP },
      true,
    ],
    [
      "only the candidate has a proposal fingerprint",
      { ...CANDIDATE, op: "update", proposalFingerprint: FP },
      { ...REJECTED, op: "update" },
      true,
    ],
    [
      "only the rejection has a proposal fingerprint",
      { ...CANDIDATE, op: "update" },
      { ...REJECTED, op: "update", proposalFingerprint: FP },
      true,
    ],
  ])("%s -> %s", (_name, candidate, rejected, expected) => {
    expect(matchesRejection(candidate, rejected)).toBe(expected);
  });
});

describe("findRejection", () => {
  it("returns the first matching rejection", () => {
    const second: RejectedOp = { ...REJECTED, opId: "second" };
    const foreign: RejectedOp = { ...REJECTED, claimId: "seat-price" };
    expect(findRejection(CANDIDATE, [foreign, REJECTED, second])).toBe(
      REJECTED,
    );
  });

  it("returns undefined when nothing matches or the list is empty", () => {
    expect(
      findRejection(CANDIDATE, [{ ...REJECTED, op: "retract" }]),
    ).toBeUndefined();
    expect(findRejection(CANDIDATE, [])).toBeUndefined();
  });
});
