import { describe, expect, it } from "vitest";

import {
  MinimizationError,
  assertAdminLogTarget,
  assertIntentFields,
  assertPinFields,
  assertStatement,
  assertStoredProposal,
} from "./knowledge-minimize";

const SENTINEL = "SENTINEL-VALUE-123";
const SHA40 = "a".repeat(40);

function validProposal(): Record<string, unknown> {
  return {
    id: "op:docs/billing@abc123",
    claimId: "billing.limit",
    op: "update",
    auto: false,
    before: "The limit is 14.",
    after: "The limit is 15.",
    why: "line one\nline two",
    evidence: ["repo://acme/billing.ts#L1-L2"],
    newEvidence: ["repo://acme/billing.ts#L3-L4"],
    newEvidenceHash: ["x:0123456789abcdef", "0123456789abcdef"],
    score: 0.5,
    sourceValues: [{ uri: "doc://acme/limits", values: ["14", "v2.3"] }],
    evidenceFingerprint: "0123456789abcdef",
    locatedEvidence: ["repo://acme/billing.ts#L1-L2"],
    proposalFingerprint: "fedcba9876543210",
  };
}

function expectRejected(run: () => unknown, path: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MinimizationError);
  expect((caught as MinimizationError).path).toBe(path);
  expect(String(caught)).not.toContain(SENTINEL);
}

describe("assertStoredProposal", () => {
  it("accepts a full valid proposal", () => {
    const input = validProposal();
    expect(assertStoredProposal(input)).toEqual(input);
  });

  it("refuses non-objects", () => {
    expectRejected(() => assertStoredProposal("x"), "proposal");
    expectRejected(() => assertStoredProposal(null), "proposal");
  });

  it("refuses unknown keys without echoing the value", () => {
    expectRejected(
      () => assertStoredProposal({ ...validProposal(), rawText: SENTINEL }),
      "proposal.rawText",
    );
  });

  it("bounds statements", () => {
    expect(() =>
      assertStoredProposal({ ...validProposal(), before: "x".repeat(1000) }),
    ).not.toThrow();
    expectRejected(
      () =>
        assertStoredProposal({
          ...validProposal(),
          before: SENTINEL + "x".repeat(1001),
        }),
      "proposal.before",
    );
  });

  it("bounds snippets to 4 lines of 200 chars", () => {
    expect(() =>
      assertStoredProposal({ ...validProposal(), why: "a\nb\nc\nd" }),
    ).not.toThrow();
    expectRejected(
      () =>
        assertStoredProposal({
          ...validProposal(),
          why: `${SENTINEL}\nb\nc\nd\ne`,
        }),
      "proposal.why",
    );
    expectRejected(
      () =>
        assertStoredProposal({
          ...validProposal(),
          why: SENTINEL + "y".repeat(201),
        }),
      "proposal.why",
    );
  });

  it.each([
    ["evidenceFingerprint", SENTINEL],
    ["proposalFingerprint", "0123456789ABCDEF"],
  ])("requires %s to be a hash", (key, bad) => {
    expectRejected(
      () => assertStoredProposal({ ...validProposal(), [key]: bad }),
      `proposal.${key}`,
    );
  });

  it("validates newEvidenceHash entries", () => {
    expectRejected(
      () =>
        assertStoredProposal({
          ...validProposal(),
          newEvidenceHash: ["0123456789ABCDEF"],
        }),
      "proposal.newEvidenceHash[0]",
    );
  });

  it("validates evidence URIs and list size", () => {
    expectRejected(
      () =>
        assertStoredProposal({
          ...validProposal(),
          evidence: [`repo://a b ${SENTINEL}`],
        }),
      "proposal.evidence[0]",
    );
    expectRejected(
      () =>
        assertStoredProposal({
          ...validProposal(),
          evidence: [`repo://a\n${SENTINEL}`],
        }),
      "proposal.evidence[0]",
    );
    expectRejected(
      () =>
        assertStoredProposal({
          ...validProposal(),
          evidence: Array.from({ length: 33 }, () => "repo://a/b"),
        }),
      "proposal.evidence",
    );
  });

  it("validates sourceValues", () => {
    expectRejected(
      () =>
        assertStoredProposal({
          ...validProposal(),
          sourceValues: [
            { uri: "doc://a/b", values: [`has space ${SENTINEL}`] },
          ],
        }),
      "proposal.sourceValues[0].values[0]",
    );
    expectRejected(
      () =>
        assertStoredProposal({
          ...validProposal(),
          sourceValues: [{ uri: "doc://a/b", values: ["x".repeat(65)] }],
        }),
      "proposal.sourceValues[0].values[0]",
    );
    expectRejected(
      () =>
        assertStoredProposal({
          ...validProposal(),
          sourceValues: [{ uri: "doc://a/b", values: ["1"], extra: SENTINEL }],
        }),
      "proposal.sourceValues[0].extra",
    );
  });

  it.each([1.5, Number.NaN, SENTINEL])("refuses score %s", (score) => {
    expectRejected(
      () => assertStoredProposal({ ...validProposal(), score }),
      "proposal.score",
    );
  });

  it("refuses a non-boolean auto and missing required keys", () => {
    expectRejected(
      () => assertStoredProposal({ ...validProposal(), auto: SENTINEL }),
      "proposal.auto",
    );
    const missing = validProposal();
    delete missing["why"];
    expectRejected(() => assertStoredProposal(missing), "proposal.why");
  });
});

describe("assertStatement", () => {
  it("bounds length, lines and emptiness", () => {
    expect(assertStatement("x".repeat(1000), "s")).toHaveLength(1000);
    expectRejected(() => assertStatement("", "s"), "s");
    expectRejected(() => assertStatement("a\nb\nc\nd\ne", "s"), "s");
  });
});

describe("assertPinFields", () => {
  const pin = { uri: "repo://acme/a.ts#L1", hash: "x:0123456789abcdef" };
  it("accepts 40- and 64-hex revisions", () => {
    expect(() => assertPinFields({ ...pin, observedRev: SHA40 })).not.toThrow();
    expect(() =>
      assertPinFields({ ...pin, observedRev: "b".repeat(64) }),
    ).not.toThrow();
  });
  it("refuses other revisions", () => {
    expectRejected(
      () => assertPinFields({ ...pin, observedRev: SENTINEL }),
      "pin.observedRev",
    );
  });
});

describe("assertIntentFields", () => {
  const intent = {
    repoFullName: "acme/docs",
    defaultBranch: "main",
    targetSha: SHA40,
  };
  it("accepts a valid intent", () => {
    expect(assertIntentFields(intent)).toEqual(intent);
    expect(
      assertIntentFields({ ...intent, lastErrorCode: "clone_failed" })
        .lastErrorCode,
    ).toBe("clone_failed");
  });
  it("refuses bad branch and error code", () => {
    expectRejected(
      () => assertIntentFields({ ...intent, defaultBranch: `a ${SENTINEL}` }),
      "intent.defaultBranch",
    );
    expectRejected(
      () => assertIntentFields({ ...intent, lastErrorCode: `Bad ${SENTINEL}` }),
      "intent.lastErrorCode",
    );
  });
});

describe("assertAdminLogTarget", () => {
  it("accepts ids, integers, booleans and enum tokens", () => {
    const target = { from: false, to: true, budget: 5000, mode: "on", n: null };
    expect(assertAdminLogTarget(target)).toEqual(target);
  });
  it("refuses free text, nested objects and non-integers", () => {
    expectRejected(
      () => assertAdminLogTarget({ note: `free text ${SENTINEL}` }),
      "target.note",
    );
    expectRejected(
      () => assertAdminLogTarget({ nested: { a: SENTINEL } }),
      "target.nested",
    );
    expectRejected(() => assertAdminLogTarget({ n: 1.5 }), "target.n");
  });
});
