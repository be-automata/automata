import { unlinkSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  reconcile,
  stubUpdater,
  type DraftOp,
  type ReconcileOptions,
  type Sidecar,
  type Updater,
} from "./claims";
import {
  findRejection,
  matchesRejection,
  rejectionOf as ledgerRejectionOf,
  type RejectedOp,
  type RejectionCandidate,
} from "./rejections";
import {
  BILLING_LINES,
  countingUpdater,
  diffOf,
  diffOfFile,
  edit,
  pageOf,
  SOURCE_SHA,
  useCorpus,
  writeBilling,
  emptyDiff,
  opFor,
  withClaim,
} from "./test-fixtures";

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
  evidenceFingerprint: FP,
};

describe("matchesRejection", () => {
  it.each<[string, RejectionCandidate, RejectedOp, boolean]>([
    ["same claim and evidence", CANDIDATE, REJECTED, true],
    [
      "same evidence surfacing as another op kind",
      CANDIDATE,
      { ...REJECTED, op: "update" },
      true,
    ],
    [
      "different claim",
      { ...CANDIDATE, claimId: "seat-price" },
      REJECTED,
      false,
    ],
    [
      "different evidence fingerprint",
      { ...CANDIDATE, evidenceFingerprint: OTHER_FP },
      REJECTED,
      false,
    ],
    [
      "candidate without an evidence fingerprint",
      { claimId: "trial-length" },
      REJECTED,
      false,
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
      findRejection(CANDIDATE, [
        { ...REJECTED, evidenceFingerprint: OTHER_FP },
      ]),
    ).toBeUndefined();
    expect(findRejection(CANDIDATE, [])).toBeUndefined();
  });
});

/** A later merge: a different source commit, so every op id differs from the first reconcile's. */
const LATER_SHA = "1b2c3d4e5f60718293a4b5c6d7e8f90123456789";
const FINGERPRINT = /^[0-9a-f]{16}$/;

const run = (
  root: string,
  sc: Sidecar,
  options: ReconcileOptions,
  llm: Updater = stubUpdater(),
) => reconcile(root, pageOf(root), sc, llm, options);

/** The rejection a decision ledger would record for this op. */
const rejectionOf = (o: DraftOp): RejectedOp => {
  const r = ledgerRejectionOf(o);
  if (!r) throw new Error(`${o.id} carries no evidence fingerprint`);
  return r;
};

const trialInCode = (days: number) =>
  BILLING_LINES.map((l) =>
    l.replace(/TRIAL_DAYS = \d+/, `TRIAL_DAYS = ${days}`),
  );
const trialInDocs = (root: string, from: number, to: number) =>
  edit(root, "docs/pricing.md", (s) =>
    s.replace(`${from}-day free trial`, `${to}-day free trial`),
  );
const unrelatedDocEdit = (root: string) =>
  edit(root, "docs/pricing.md", (s) =>
    s.replace("monthly or annual.", "monthly, annual, or via invoice."),
  );

describe("rejection suppression (ENG-02 / O6)", () => {
  it("fingerprints every non-auto op deterministically and never an auto repin", async () => {
    const { root, sc } = useCorpus();
    edit(root, "repo/billing.ts", (s) => `// billing constants\n\n${s}`);
    trialInDocs(root, 14, 21);
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const a = await run(root, sc, { sourceRev: SOURCE_SHA });
    const b = await run(root, sc, { sourceRev: SOURCE_SHA });
    expect(a.ops.map((o) => o.op).sort()).toEqual([
      "conflict",
      "repin",
      "update",
    ]);
    for (const o of a.ops) {
      if (o.auto) {
        expect(o.evidenceFingerprint).toBeUndefined();
        expect(o.proposalFingerprint).toBeUndefined();
      } else expect(o.evidenceFingerprint).toMatch(FINGERPRINT);
    }
    expect(opFor(a.ops, "sso-fixed-in").proposalFingerprint).toMatch(
      FINGERPRINT,
    );
    const prints = (ops: DraftOp[]) =>
      ops.map((o) => [o.id, o.evidenceFingerprint, o.proposalFingerprint]);
    expect(prints(b.ops)).toEqual(prints(a.ops));
    expect(a.suppressed).toEqual([]);
  });

  it("an unrelated merge does not re-raise a rejected conflict; a line shift keeps it; changed evidence re-raises it", async () => {
    const { root, sc } = useCorpus();
    writeBilling(root, trialInCode(30));
    const first = await run(root, sc, { sourceRev: SOURCE_SHA });
    const c = opFor(first.ops, "trial-length", "conflict");
    expect(c.evidenceFingerprint).toMatch(FINGERPRINT);
    const rejected = [rejectionOf(c)];
    const covered = [
      {
        claimId: "trial-length",
        op: "conflict",
        rejectedOpId: c.id,
        evidenceFingerprint: c.evidenceFingerprint,
      },
    ];

    unrelatedDocEdit(root);
    const later = await run(root, sc, { sourceRev: LATER_SHA, rejected });
    expect(later.ops.filter((o) => o.claimId === "trial-length")).toEqual([]);
    expect(later.suppressed).toEqual(covered);

    // Same content, pushed one line down: the fingerprint hashes the located text, not line numbers.
    const shifted = ["// billing constants", ...trialInCode(30)];
    writeBilling(root, shifted);
    const moved = await run(root, sc, {
      sourceRev: LATER_SHA,
      rejected,
      diffs: [diffOf(shifted, "@@ -0,0 +1 @@")],
    });
    expect(moved.ops.filter((o) => o.claimId === "trial-length")).toEqual([]);
    expect(moved.suppressed).toEqual(covered);
    expect(opFor(moved.ops, "seat-price").op).toBe("repin");

    writeBilling(root, trialInCode(45));
    const changed = await run(root, sc, { sourceRev: LATER_SHA, rejected });
    const again = opFor(changed.ops, "trial-length", "conflict");
    expect(again.evidenceFingerprint).toMatch(FINGERPRINT);
    expect(again.evidenceFingerprint).not.toBe(c.evidenceFingerprint);
    expect(changed.suppressed).toEqual([]);
  });

  it("an owner-edited statement re-raises a rejected conflict", async () => {
    const { root, sc } = useCorpus();
    writeBilling(root, trialInCode(30));
    const c = opFor(
      (await run(root, sc, { sourceRev: SOURCE_SHA })).ops,
      "trial-length",
      "conflict",
    );
    const edited = withClaim(sc, "trial-length", (cl) => ({
      ...cl,
      statement: "Trials run for 14 days and need no card.",
    }));
    const later = await run(root, edited, {
      sourceRev: LATER_SHA,
      rejected: [rejectionOf(c)],
    });
    const again = opFor(later.ops, "trial-length", "conflict");
    expect(again.evidenceFingerprint).not.toBe(c.evidenceFingerprint);
    expect(later.suppressed).toEqual([]);
  });

  it("a rejected update is suppressed before the model is called; a new change raises it again", async () => {
    const { root, sc } = useCorpus();
    writeBilling(root, trialInCode(30));
    trialInDocs(root, 14, 30);
    const first = await run(
      root,
      sc,
      { sourceRev: SOURCE_SHA },
      countingUpdater().llm,
    );
    expect(first.llmCalls).toBe(1);
    const u = opFor(first.ops, "trial-length", "update");
    expect(u.proposalFingerprint).toMatch(FINGERPRINT);
    const rejected = [rejectionOf(u)];

    unrelatedDocEdit(root);
    const quiet = countingUpdater();
    const later = await run(
      root,
      sc,
      { sourceRev: LATER_SHA, rejected },
      quiet.llm,
    );
    expect(later.ops.filter((o) => o.claimId === "trial-length")).toEqual([]);
    expect(later.suppressed).toEqual([
      {
        claimId: "trial-length",
        op: "update",
        rejectedOpId: u.id,
        evidenceFingerprint: u.evidenceFingerprint,
      },
    ]);
    expect(later.llmCalls).toBe(0);
    expect(quiet.seen).toEqual([]);

    writeBilling(root, trialInCode(45));
    trialInDocs(root, 30, 45);
    const asked = countingUpdater();
    const changed = await run(
      root,
      sc,
      { sourceRev: LATER_SHA, rejected },
      asked.llm,
    );
    const again = opFor(changed.ops, "trial-length", "update");
    expect(changed.llmCalls).toBe(1);
    expect(asked.seen).toEqual(["trial-length"]);
    expect(again.proposalFingerprint).toMatch(FINGERPRINT);
    expect(again.proposalFingerprint).not.toBe(u.proposalFingerprint);
    expect(changed.suppressed).toEqual([]);
  });

  it("a rejected retract is suppressed for its claim only", async () => {
    const { root, sc } = useCorpus();
    unlinkSync(join(root, "tickets/SUP-12.json"));
    const first = await run(root, sc, { sourceRev: SOURCE_SHA });
    opFor(first.ops, "sso-workaround", "retract");
    const r = opFor(first.ops, "sso-fixed-in", "retract");
    const later = await run(root, sc, {
      sourceRev: LATER_SHA,
      rejected: [rejectionOf(r)],
    });
    expect(later.ops.map((o) => [o.claimId, o.op])).toEqual([
      ["sso-workaround", "retract"],
    ]);
    expect(later.suppressed).toEqual([
      {
        claimId: "sso-fixed-in",
        op: "retract",
        rejectedOpId: r.id,
        evidenceFingerprint: r.evidenceFingerprint,
      },
    ]);
  });

  it("a rejected review stays suppressed on the next merge", async () => {
    const { root, sc } = useCorpus();
    writeBilling(root, trialInCode(30));
    trialInDocs(root, 14, 30);
    const diff = emptyDiff("other.ts");
    const first = await run(root, sc, {
      sourceRev: SOURCE_SHA,
      diffs: [diff],
    });
    const review = opFor(first.ops, "trial-length", "review");
    expect(review.why).toContain("no diff for");
    const later = await run(root, sc, {
      sourceRev: LATER_SHA,
      diffs: [diff],
      rejected: [rejectionOf(review)],
    });
    expect(later.ops.filter((o) => o.claimId === "trial-length")).toEqual([]);
    expect(later.suppressed).toEqual([
      {
        claimId: "trial-length",
        op: "review",
        rejectedOpId: review.id,
        evidenceFingerprint: review.evidenceFingerprint,
      },
    ]);
  });

  it("never suppresses an auto repin", async () => {
    const { root, sc } = useCorpus();
    edit(root, "repo/billing.ts", (s) => `// billing constants\n\n${s}`);
    const draft = await run(root, sc, {
      sourceRev: LATER_SHA,
      rejected: [
        {
          opId: "x",
          claimId: "seat-price",
          op: "repin",
          evidenceFingerprint: "0000000000000000",
        },
      ],
    });
    expect(
      draft.ops.filter((o) => o.op === "repin").map((o) => o.claimId),
    ).toEqual(["trial-length", "seat-price"]);
    expect(draft.ops.every((o) => o.auto)).toBe(true);
    expect(draft.suppressed).toEqual([]);
  });

  it("a rejection for another claim suppresses nothing; one recorded under another op kind on the same evidence covers it", async () => {
    const { root, sc } = useCorpus();
    writeBilling(root, trialInCode(30));
    const c = opFor(
      (await run(root, sc, { sourceRev: SOURCE_SHA })).ops,
      "trial-length",
      "conflict",
    );
    const r = rejectionOf(c);
    const later = await run(root, sc, {
      sourceRev: LATER_SHA,
      rejected: [{ ...r, claimId: "seat-price" }],
    });
    expect(opFor(later.ops, "trial-length").op).toBe("conflict");
    expect(later.suppressed).toEqual([]);
    const asReview = await run(root, sc, {
      sourceRev: LATER_SHA,
      rejected: [{ ...r, op: "review" }],
    });
    expect(asReview.ops.filter((o) => o.claimId === "trial-length")).toEqual(
      [],
    );
    expect(asReview.suppressed.map((x) => x.op)).toEqual(["conflict"]);
  });

  it("without rejections, suppressed is empty", async () => {
    const { root, sc } = useCorpus();
    writeBilling(root, trialInCode(30));
    const draft = await run(root, sc, { sourceRev: SOURCE_SHA });
    expect(draft.suppressed).toEqual([]);
    expect(draft.ops).toHaveLength(1);
  });
});

describe("rejections across merges whose diffs omit the rejected file (ENG-02 with diffs)", () => {
  /** A later merge that touches only a file nothing on the page pins. */
  const unrelatedDiffs = [
    diffOfFile("ratelimit.py", "LIMIT = 1\n", "LIMIT = 2\n", "@@ -1 +1 @@"),
  ];
  const inPlace = (lines: string[]) => [diffOf(lines, "@@ -1 +1 @@")];

  it("a rejected update stays suppressed when the next merge's diffs do not touch its file", async () => {
    const { root, sc } = useCorpus();
    writeBilling(root, trialInCode(30));
    trialInDocs(root, 14, 30);
    const first = await run(root, sc, {
      sourceRev: SOURCE_SHA,
      diffs: inPlace(trialInCode(30)),
    });
    const u = opFor(first.ops, "trial-length", "update");
    expect(u.locatedEvidence).toEqual(u.newEvidence);

    unrelatedDocEdit(root);
    const quiet = countingUpdater();
    const later = await run(
      root,
      sc,
      {
        sourceRev: LATER_SHA,
        diffs: unrelatedDiffs,
        rejected: [rejectionOf(u)],
      },
      quiet.llm,
    );
    expect(later.ops.filter((o) => o.claimId === "trial-length")).toEqual([]);
    expect(later.suppressed).toEqual([
      {
        claimId: "trial-length",
        op: "review",
        rejectedOpId: u.id,
        evidenceFingerprint: u.evidenceFingerprint,
      },
    ]);
    expect(quiet.seen).toEqual([]);
  });

  it("a rejected value conflict stays suppressed when the next merge's diffs do not touch its file", async () => {
    const { root, sc } = useCorpus();
    writeBilling(root, trialInCode(30));
    const first = await run(root, sc, {
      sourceRev: SOURCE_SHA,
      diffs: inPlace(trialInCode(30)),
    });
    const c = opFor(first.ops, "trial-length", "conflict");

    unrelatedDocEdit(root);
    const later = await run(root, sc, {
      sourceRev: LATER_SHA,
      diffs: unrelatedDiffs,
      rejected: [rejectionOf(c)],
    });
    expect(later.ops.filter((o) => o.claimId === "trial-length")).toEqual([]);
    expect(later.suppressed.map((x) => x.rejectedOpId)).toEqual([c.id]);
  });

  it("a rejection survives later merges after the rejected merge shifted the pin, with or without diffs", async () => {
    const { root, sc } = useCorpus();
    const shifted = ["// billing constants", ...trialInCode(30)];
    writeBilling(root, shifted);
    trialInDocs(root, 14, 30);
    const first = await run(root, sc, {
      sourceRev: SOURCE_SHA,
      diffs: [diffOf(shifted, "@@ -0,0 +1 @@\n@@ -1 +2 @@")],
    });
    const u = opFor(first.ops, "trial-length", "update");
    expect(u.locatedEvidence?.[0]).toBe("repo://billing.ts#L2-L2");
    const rejected = [rejectionOf(u)];

    unrelatedDocEdit(root);
    for (const diffs of [unrelatedDiffs, undefined]) {
      const later = await run(root, sc, {
        sourceRev: LATER_SHA,
        rejected,
        ...(diffs ? { diffs } : {}),
      });
      expect(later.ops.filter((o) => o.claimId === "trial-length")).toEqual([]);
      expect(later.suppressed.map((x) => x.rejectedOpId)).toEqual([u.id]);
    }

    // The located text itself changes: the owner has not seen this, so it is raised again.
    writeBilling(root, ["// billing constants", ...trialInCode(45)]);
    const changed = await run(root, sc, {
      sourceRev: LATER_SHA,
      rejected,
      diffs: unrelatedDiffs,
    });
    expect(opFor(changed.ops, "trial-length").op).toBe("review");
    expect(changed.suppressed).toEqual([]);
  });
});
