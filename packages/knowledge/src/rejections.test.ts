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
  type RejectedOp,
  type RejectionCandidate,
} from "./rejections";
import {
  BILLING_LINES,
  countingUpdater,
  diffOf,
  edit,
  pageOf,
  SOURCE_SHA,
  useCorpus,
  writeBilling,
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

/** A later merge: a different source commit, so every op id differs from the first reconcile's. */
const LATER_SHA = "1b2c3d4e5f60718293a4b5c6d7e8f90123456789";
const FINGERPRINT = /^[0-9a-f]{16}$/;

const run = (
  root: string,
  sc: Sidecar,
  options: ReconcileOptions,
  llm: Updater = stubUpdater(),
) => reconcile(root, pageOf(root), sc, llm, options);

const opFor = (ops: DraftOp[], claimId: string, op?: DraftOp["op"]) => {
  const found = ops.find(
    (o) => o.claimId === claimId && (op === undefined || o.op === op),
  );
  if (!found) throw new Error(`no ${op ?? "op"} for ${claimId}`);
  return found;
};

/** The rejection a decision ledger would record for this op. */
const rejectionOf = (o: DraftOp): RejectedOp => {
  if (o.evidenceFingerprint === undefined)
    throw new Error(`${o.id} carries no evidence fingerprint`);
  return {
    opId: o.id,
    claimId: o.claimId,
    op: o.op,
    evidenceFingerprint: o.evidenceFingerprint,
    ...(o.proposalFingerprint === undefined
      ? {}
      : { proposalFingerprint: o.proposalFingerprint }),
  };
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
      diff: diffOf(shifted, "@@ -0,0 +1 @@"),
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
    const edited: Sidecar = {
      ...sc,
      claims: sc.claims.map((cl) =>
        cl.id === "trial-length"
          ? { ...cl, statement: "Trials run for 14 days and need no card." }
          : cl,
      ),
    };
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
    const diff = { path: "other.ts", hunks: [], oldText: "", newText: "" };
    const first = await run(root, sc, { sourceRev: SOURCE_SHA, diff });
    const review = opFor(first.ops, "trial-length", "review");
    expect(review.why).toContain("no diff for");
    const later = await run(root, sc, {
      sourceRev: LATER_SHA,
      diff,
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

  it("a rejection for another claim or another op kind suppresses nothing", async () => {
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
      rejected: [
        { ...r, claimId: "seat-price" },
        { ...r, op: "review" },
      ],
    });
    expect(opFor(later.ops, "trial-length").op).toBe("conflict");
    expect(later.suppressed).toEqual([]);
  });

  it("without rejections, suppressed is empty", async () => {
    const { root, sc } = useCorpus();
    writeBilling(root, trialInCode(30));
    const draft = await run(root, sc, { sourceRev: SOURCE_SHA });
    expect(draft.suppressed).toEqual([]);
    expect(draft.ops).toHaveLength(1);
  });
});
