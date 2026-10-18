// Hardening cases from the refinement review: each one reproduces a way an approved or retargeted op,
// an updater answer or a diff edge case could re-ground a claim without a located, approved proposal.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AmbiguousEvidenceError,
  applyDraft,
  checkPage,
  InvalidEvidenceUriError,
  reconcile,
  resolve,
  retargetOp,
  stubUpdater,
  UnappliableOpError,
  type Updater,
  type UpdateRequest,
} from "./claims.ts";
import {
  BILLING_LINES as OLD,
  countingUpdater as counting,
  diffOf,
  duplicateTrial,
  edit,
  pageOf,
  SOURCE_SHA as SHA,
  useCorpus as corpus,
  writeBilling,
} from "./test-fixtures.ts";
/** An updater that answers every claim with a fixed statement and (optionally) fixed evidence. */
const answering = (statement: string, evidence?: string[]): Updater => ({
  calls: 0,
  rework: (items: UpdateRequest[]) =>
    items.map((i) => ({
      id: i.claim.id,
      statement,
      ...(evidence ? { evidence } : {}),
    })),
});

describe("doc sections", () => {
  it("a new same-slug section above the pinned one makes the claim ambiguous, never a model rewrite", () => {
    const { root, sc } = corpus();
    edit(root, "docs/pricing.md", (s) =>
      s.replace(
        "## Plans",
        "## Trial\nEnterprise trial is 30 days.\n\n## Plans",
      ),
    );
    const { llm, seen } = counting();
    const draft = reconcile(root, pageOf(root), sc, llm, { sourceRev: SHA });
    expect(
      checkPage(root, pageOf(root), sc).claims.find(
        (c) => c.id === "trial-length",
      )?.status,
    ).toBe("ambiguous");
    expect(
      draft.ops.filter((o) => o.claimId === "trial-length").map((o) => o.op),
    ).toEqual(["review"]);
    expect(seen).not.toContain("trial-length");
  });
});

describe("applyDraft never trusts the op kind", () => {
  it("a retargeted op is never auto, so a forced repin needs approval", () => {
    const { root, sc } = corpus();
    edit(root, "repo/billing.ts", duplicateTrial);
    const md = pageOf(root);
    const draft = reconcile(root, md, sc, stubUpdater(), { sourceRev: SHA });
    const ops = draft.ops.map((o) =>
      o.claimId === "trial-length" ? retargetOp(o, "repin", "forced") : o,
    );
    expect(ops.find((o) => o.claimId === "trial-length")?.auto).toBe(false);
    const out = applyDraft(root, md, sc, { ...draft, ops });
    expect(out.sc.claims.find((c) => c.id === "trial-length")).toEqual(
      sc.claims.find((c) => c.id === "trial-length"),
    );
  });

  it("the ambiguity guard covers approved repins", () => {
    const { root, sc } = corpus();
    edit(root, "repo/billing.ts", duplicateTrial);
    const md = pageOf(root);
    const draft = reconcile(root, md, sc, stubUpdater(), { sourceRev: SHA });
    const ops = draft.ops.map((o) =>
      o.claimId === "trial-length" ? retargetOp(o, "repin", "forced") : o,
    );
    expect(() =>
      applyDraft(
        root,
        md,
        sc,
        { ...draft, ops },
        ops.map((o) => o.id),
      ),
    ).toThrow(AmbiguousEvidenceError);
  });

  it("an approved update without a located proposal is refused, never re-grounded in place", () => {
    const { root, sc } = corpus();
    const now = [
      "export const TRIAL_DAYS = 14;",
      "// pricing moved to the billing service",
      ...OLD.slice(2),
    ];
    writeBilling(root, now);
    const md = pageOf(root);
    const draft = reconcile(root, md, sc, stubUpdater(), {
      sourceRev: SHA,
      diff: diffOf(now, "@@ -2 +2 @@"),
    });
    expect(draft.ops.find((o) => o.claimId === "seat-price")?.op).toBe(
      "review",
    );
    const ops = draft.ops.map((o) =>
      o.claimId === "seat-price" ? retargetOp(o, "update", "forced") : o,
    );
    expect(() =>
      applyDraft(
        root,
        md,
        sc,
        { ...draft, ops },
        ops.map((o) => o.id),
      ),
    ).toThrow(UnappliableOpError);
  });

  it("replacement text is literal ($& is not a pattern)", () => {
    const { root, sc } = corpus();
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const md = pageOf(root);
    const draft = reconcile(root, md, sc, answering("Fixed in $& 2.4.2."), {
      sourceRev: SHA,
    });
    const out = applyDraft(
      root,
      md,
      sc,
      draft,
      draft.ops.map((o) => o.id),
    );
    expect(out.md).toContain("Fixed in $& 2.4.2.");
  });
});

describe("reconcile with a diff", () => {
  it("a span pushed past end-of-file by the diff is re-anchored, not retracted", () => {
    const { root, sc } = corpus();
    // Lines 1-3 collapse into one edited seat-price line: the old L2-L3 pin is now past EOF.
    const now = ["export const SEAT_PRICE_USD = 35;"];
    writeFileSync(join(root, "repo/billing.ts"), now.join("\n"));
    const { llm } = counting();
    const draft = reconcile(root, pageOf(root), sc, llm, {
      sourceRev: SHA,
      diff: diffOf(now, "@@ -1,7 +1 @@"),
    });
    const op = draft.ops.find((o) => o.claimId === "seat-price");
    expect(op?.op).not.toBe("retract");
    expect(op?.op === "update" || op?.op === "review").toBe(true);
  });

  it("a stale line pin on a file the diff does not cover becomes a review", () => {
    const { root, sc } = corpus();
    edit(root, "repo/billing.ts", (s) =>
      s.replace("TRIAL_DAYS = 14", "TRIAL_DAYS = 30"),
    );
    edit(root, "docs/pricing.md", (s) =>
      s.replace("14-day free trial", "30-day free trial"),
    );
    const { llm, seen } = counting();
    const draft = reconcile(root, pageOf(root), sc, llm, {
      sourceRev: SHA,
      diff: { path: "other.ts", hunks: [], oldText: "", newText: "" },
    });
    expect(draft.ops.find((o) => o.claimId === "trial-length")).toMatchObject({
      op: "review",
    });
    expect(seen).not.toContain("trial-length");
  });

  it("a tie inside the hunk becomes a review", () => {
    const { root, sc } = corpus();
    // The two-line span is rewritten into three lines whose two possible windows hold the same tokens.
    const seat = "export const SEAT_PRICE_USD = 35;";
    const now = [
      "export const TRIAL_DAYS = 14;",
      seat,
      "export const MAX_SEATS_FREE = 3;",
      seat,
      ...OLD.slice(3),
    ];
    writeBilling(root, now);
    const draft = reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SHA,
      diff: diffOf(now, "@@ -2,2 +2,3 @@"),
    });
    expect(draft.ops.find((o) => o.claimId === "seat-price")).toMatchObject({
      op: "review",
    });
  });

  it("a narrowed span (part of it deleted) becomes a review", () => {
    const { root, sc } = corpus();
    const now = [
      "export const TRIAL_DAYS = 14;",
      "export const SEAT_PRICE_USD = 29;",
      ...OLD.slice(3),
    ];
    writeBilling(root, now);
    const draft = reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SHA,
      diff: diffOf(now, "@@ -3 +2,0 @@"),
    });
    expect(draft.ops.find((o) => o.claimId === "seat-price")).toMatchObject({
      op: "review",
    });
  });

  it("a span the diff deleted (file still long enough) becomes a retract", () => {
    const { root, sc } = corpus();
    const now = ["export const TRIAL_DAYS = 14;", ...OLD.slice(3)];
    writeBilling(root, now);
    const draft = reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SHA,
      diff: diffOf(now, "@@ -2,2 +1,0 @@"),
    });
    expect(draft.ops.find((o) => o.claimId === "seat-price")).toMatchObject({
      op: "retract",
      why: "the merge deleted every span this fact was grounded on",
    });
  });
});

describe("updater answers are validated", () => {
  it.each([
    ["empty", []],
    ["unresolvable", ["repo://billing.ts#L99-L99"]],
    ["wrong arity", ["repo://billing.ts#L1-L1", "repo://billing.ts#L2-L2"]],
  ])("a %s evidence override becomes a review", (_name, evidence) => {
    const { root, sc } = corpus();
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const draft = reconcile(
      root,
      pageOf(root),
      sc,
      answering("Fixed in 2.4.2.", evidence),
      { sourceRev: SHA },
    );
    expect(draft.ops.find((o) => o.claimId === "sso-fixed-in")?.op).toBe(
      "review",
    );
  });

  it("an evidence override onto an ambiguous span becomes a review", () => {
    const { root, sc } = corpus();
    edit(root, "repo/billing.ts", (s) => `${s}export const TRIAL_DAYS = 14;\n`);
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const draft = reconcile(
      root,
      pageOf(root),
      sc,
      answering("Fixed in 2.4.2.", ["repo://billing.ts#L1-L1"]),
      {
        sourceRev: SHA,
      },
    );
    expect(draft.ops.find((o) => o.claimId === "sso-fixed-in")?.op).toBe(
      "review",
    );
  });

  it("duplicate answers yield one op, and a skipped claim yields a review", () => {
    const { root, sc } = corpus();
    edit(root, "tickets/SUP-12.json", (s) =>
      s
        .replace('"2.4.1"', '"2.4.2"')
        .replace("Clear the ag_session", "Delete the ag_session"),
    );
    const llm: Updater = {
      calls: 0,
      rework: () => [
        { id: "sso-fixed-in", statement: "Fixed in 2.4.2." },
        { id: "sso-fixed-in", statement: "Fixed in 2.4.3." },
      ],
    };
    const draft = reconcile(root, pageOf(root), sc, llm, { sourceRev: SHA });
    expect(
      draft.ops.filter((o) => o.claimId === "sso-fixed-in").map((o) => o.after),
    ).toEqual(["Fixed in 2.4.2."]);
    expect(draft.ops.find((o) => o.claimId === "sso-workaround")?.op).toBe(
      "review",
    );
  });
});

describe("evidence URIs", () => {
  it("line anchors must satisfy 1 <= a <= b", () => {
    const { root } = corpus();
    expect(() => resolve(root, "repo://billing.ts#L3-L2")).toThrow(
      InvalidEvidenceUriError,
    );
    expect(() => resolve(root, "repo://billing.ts#L0-L0")).toThrow(
      InvalidEvidenceUriError,
    );
  });
});
