// Hardening cases from the refinement review: each one reproduces a way an approved or retargeted op,
// an updater answer or a diff edge case could re-ground a claim without a located, approved proposal.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import {
  AmbiguousEvidenceError,
  applyDraft,
  checkPage,
  generateSidecar,
  HumanEditedPageError,
  InvalidEvidenceUriError,
  MAX_STATEMENT_CHARS,
  MAX_STATEMENT_LINES,
  reconcile,
  resolve,
  retargetOp,
  stubUpdater,
  UnappliableOpError,
  UngroundedClaimError,
  type Updater,
  type UpdateRequest,
} from "./claims";
import { InvalidOpKeyPartError } from "./op-key";
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
  findOp,
  withClaim,
  emptyDiff,
} from "./test-fixtures";

/** The sidecar's page version for `md` (sha256, 16 hex). */
const sha256 = (md: string) =>
  createHash("sha256").update(md).digest("hex").slice(0, 16);

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
  it("a new same-slug section above the pinned one makes the claim ambiguous, never a model rewrite", async () => {
    const { root, sc } = corpus();
    edit(root, "docs/pricing.md", (s) =>
      s.replace(
        "## Plans",
        "## Trial\nEnterprise trial is 30 days.\n\n## Plans",
      ),
    );
    const { llm, seen } = counting();
    const draft = await reconcile(root, pageOf(root), sc, llm, {
      sourceRev: SHA,
    });
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
  it("a retargeted op is never auto, so a forced repin needs approval", async () => {
    const { root, sc } = corpus();
    edit(root, "repo/billing.ts", duplicateTrial);
    const md = pageOf(root);
    const draft = await reconcile(root, md, sc, stubUpdater(), {
      sourceRev: SHA,
    });
    const ops = draft.ops.map((o) =>
      o.claimId === "trial-length" ? retargetOp(o, "repin", "forced") : o,
    );
    expect(ops.find((o) => o.claimId === "trial-length")?.auto).toBe(false);
    const out = applyDraft(root, md, sc, { ...draft, ops });
    expect(out.sc.claims.find((c) => c.id === "trial-length")).toEqual(
      sc.claims.find((c) => c.id === "trial-length"),
    );
  });

  it("the ambiguity guard covers approved repins", async () => {
    const { root, sc } = corpus();
    edit(root, "repo/billing.ts", duplicateTrial);
    const md = pageOf(root);
    const draft = await reconcile(root, md, sc, stubUpdater(), {
      sourceRev: SHA,
    });
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

  it("an approved update without a located proposal is refused, never re-grounded in place", async () => {
    const { root, sc } = corpus();
    const now = [
      "export const TRIAL_DAYS = 14;",
      "// pricing moved to the billing service",
      ...OLD.slice(2),
    ];
    writeBilling(root, now);
    const md = pageOf(root);
    const draft = await reconcile(root, md, sc, stubUpdater(), {
      sourceRev: SHA,
      diffs: [diffOf(now, "@@ -2 +2 @@")],
    });
    expect(findOp(draft.ops, "seat-price")?.op).toBe("review");
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

  it("replacement text is literal ($& is not a pattern)", async () => {
    const { root, sc } = corpus();
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const md = pageOf(root);
    const draft = await reconcile(
      root,
      md,
      sc,
      answering("Fixed in $& 2.4.2."),
      {
        sourceRev: SHA,
      },
    );
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
  it("a span pushed past end-of-file by the diff is re-anchored, not retracted", async () => {
    const { root, sc } = corpus();
    // Lines 1-3 collapse into one edited seat-price line: the old L2-L3 pin is now past EOF.
    const now = ["export const SEAT_PRICE_USD = 35;"];
    writeFileSync(join(root, "repo/billing.ts"), now.join("\n"));
    const { llm } = counting();
    const draft = await reconcile(root, pageOf(root), sc, llm, {
      sourceRev: SHA,
      diffs: [diffOf(now, "@@ -1,7 +1 @@")],
    });
    const op = findOp(draft.ops, "seat-price");
    expect(op?.op).not.toBe("retract");
    expect(op?.op === "update" || op?.op === "review").toBe(true);
  });

  it("a stale line pin on a file the diff does not cover becomes a review", async () => {
    const { root, sc } = corpus();
    edit(root, "repo/billing.ts", (s) =>
      s.replace("TRIAL_DAYS = 14", "TRIAL_DAYS = 30"),
    );
    edit(root, "docs/pricing.md", (s) =>
      s.replace("14-day free trial", "30-day free trial"),
    );
    const { llm, seen } = counting();
    const draft = await reconcile(root, pageOf(root), sc, llm, {
      sourceRev: SHA,
      diffs: [emptyDiff("other.ts")],
    });
    expect(findOp(draft.ops, "trial-length")).toMatchObject({
      op: "review",
    });
    expect(seen).not.toContain("trial-length");
  });

  it("a tie inside the hunk becomes a review", async () => {
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
    const draft = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SHA,
      diffs: [diffOf(now, "@@ -2,2 +2,3 @@")],
    });
    expect(findOp(draft.ops, "seat-price")).toMatchObject({
      op: "review",
    });
  });

  it("a narrowed span (part of it deleted) becomes a review", async () => {
    const { root, sc } = corpus();
    const now = [
      "export const TRIAL_DAYS = 14;",
      "export const SEAT_PRICE_USD = 29;",
      ...OLD.slice(3),
    ];
    writeBilling(root, now);
    const draft = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SHA,
      diffs: [diffOf(now, "@@ -3 +2,0 @@")],
    });
    expect(findOp(draft.ops, "seat-price")).toMatchObject({
      op: "review",
    });
  });

  it("a span the diff deleted (file still long enough) becomes a retract", async () => {
    const { root, sc } = corpus();
    const now = ["export const TRIAL_DAYS = 14;", ...OLD.slice(3)];
    writeBilling(root, now);
    const draft = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SHA,
      diffs: [diffOf(now, "@@ -2,2 +1,0 @@")],
    });
    expect(findOp(draft.ops, "seat-price")).toMatchObject({
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
  ])("a %s evidence override becomes a review", async (_name, evidence) => {
    const { root, sc } = corpus();
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const draft = await reconcile(
      root,
      pageOf(root),
      sc,
      answering("Fixed in 2.4.2.", evidence),
      { sourceRev: SHA },
    );
    expect(findOp(draft.ops, "sso-fixed-in")?.op).toBe("review");
  });

  it.each([
    ["an empty statement", { statement: "  " }],
    ["a non-string statement", { statement: 42 }],
    ["string evidence", { statement: "Fixed in 2.4.2.", evidence: "repo://x" }],
  ])("%s from the updater becomes a review", async (_name, answer) => {
    const { root, sc } = corpus();
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    // Model output is untyped at runtime: the cast stands in for a malformed JSON answer.
    const llm = {
      calls: 0,
      rework: (items: UpdateRequest[]) =>
        items.map((i) => ({ id: i.claim.id, ...answer })),
    } as unknown as Updater;
    const draft = await reconcile(root, pageOf(root), sc, llm, {
      sourceRev: SHA,
    });
    expect(findOp(draft.ops, "sso-fixed-in")?.op).toBe("review");
  });

  it("a rewrite over the store's statement cap becomes a review", async () => {
    const { root, sc } = corpus();
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const op = async (statement: string) =>
      findOp(
        (
          await reconcile(root, pageOf(root), sc, answering(statement), {
            sourceRev: SHA,
          })
        ).ops,
        "sso-fixed-in",
      )?.op;
    const fill = (n: number) => `Fixed in 2.4.2.${" x".repeat(n)}`.slice(0, n);
    expect(await op(fill(MAX_STATEMENT_CHARS))).toBe("update");
    expect(await op(fill(MAX_STATEMENT_CHARS + 1))).toBe("review");
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `Fixed in 2.4.2, line ${i}.`).join(
        "\n",
      );
    expect(await op(lines(MAX_STATEMENT_LINES))).toBe("update");
    expect(await op(lines(MAX_STATEMENT_LINES + 1))).toBe("review");
  });

  it("an evidence override wider than 200 lines becomes a review", async () => {
    const { root, sc } = corpus();
    const big = Array.from(
      { length: 250 },
      (_, i) => `export const K${i} = ${i};`,
    );
    writeFileSync(join(root, "repo/big.ts"), `${big.join("\n")}\n`);
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const at = async (n: number) =>
      (
        await reconcile(
          root,
          pageOf(root),
          sc,
          answering("Fixed in 2.4.2.", [`repo://big.ts#L1-L${n}`]),
          { sourceRev: SHA },
        )
      ).ops.find((o) => o.claimId === "sso-fixed-in")?.op;
    expect(await at(200)).toBe("update");
    expect(await at(201)).toBe("review");
  });

  it("an evidence override onto an ambiguous span becomes a review", async () => {
    const { root, sc } = corpus();
    edit(root, "repo/billing.ts", (s) => `${s}export const TRIAL_DAYS = 14;\n`);
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const draft = await reconcile(
      root,
      pageOf(root),
      sc,
      answering("Fixed in 2.4.2.", ["repo://billing.ts#L1-L1"]),
      {
        sourceRev: SHA,
      },
    );
    expect(findOp(draft.ops, "sso-fixed-in")?.op).toBe("review");
  });

  it("duplicate answers yield one op, and a skipped claim yields a review", async () => {
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
    const draft = await reconcile(root, pageOf(root), sc, llm, {
      sourceRev: SHA,
    });
    expect(
      draft.ops.filter((o) => o.claimId === "sso-fixed-in").map((o) => o.after),
    ).toEqual(["Fixed in 2.4.2."]);
    expect(findOp(draft.ops, "sso-workaround")?.op).toBe("review");
  });
});

describe("applyDraft never trusts the draft", () => {
  const ticketDraft = async () => {
    const { root, sc } = corpus();
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const md = pageOf(root);
    const draft = await reconcile(root, md, sc, stubUpdater(), {
      sourceRev: SHA,
    });
    return { root, sc, md, draft };
  };

  it("an update marked auto is still not applied without approval", async () => {
    const { root, sc, md, draft } = await ticketDraft();
    const ops = draft.ops.map((o) => ({ ...o, auto: true }));
    const out = applyDraft(root, md, sc, { ...draft, ops });
    expect(out.md).toBe(md);
    expect(out.sc.claims).toEqual(sc.claims);
  });

  it("a human edit after reconcile is detected from the page, not from mode", async () => {
    const { root, sc, md, draft } = await ticketDraft();
    expect(draft.mode).toBe("apply");
    const edited = `${md}\nA human added this line.\n`;
    expect(() =>
      applyDraft(
        root,
        edited,
        sc,
        draft,
        draft.ops.map((o) => o.id),
      ),
    ).toThrow(HumanEditedPageError);
  });

  it("an approved op whose id names another claim is refused", async () => {
    const { root, sc, md, draft } = await ticketDraft();
    const ops = draft.ops.map((o) => ({ ...o, claimId: "seat-price" }));
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

  it("an approved update whose evidence changed after reconcile is refused", async () => {
    const { root, sc, md, draft } = await ticketDraft();
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.2"', '"2.4.3"'));
    expect(() =>
      applyDraft(
        root,
        md,
        sc,
        draft,
        draft.ops.map((o) => o.id),
      ),
    ).toThrow(/changed since the proposal/);
  });

  it("an approved update with no fingerprints (hand-built) is refused", async () => {
    const { root, sc, md, draft } = await ticketDraft();
    const ops = draft.ops.map((o) => ({ ...o, newEvidenceHash: undefined }));
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

  it("a statement that occurs twice on the page is never rewritten", async () => {
    const { root, sc, draft } = await ticketDraft();
    const md = `${pageOf(root)}\nThe SSO loop was fixed in version 2.4.1.\n`;
    expect(() =>
      applyDraft(
        root,
        md,
        { ...sc, pageVersion: sha256(md) },
        { ...draft, mode: "apply" },
        draft.ops.map((o) => o.id),
      ),
    ).toThrow(/more than once/);
  });
});

describe("evidence URIs stay inside the corpus", () => {
  it.each([
    "repo://../tickets/SUP-12.json#L1-L1",
    "repo://a/../../x#L1-L1",
    "repo:///etc/hosts#L1-L1",
    "ticket://../wiki/billing-faq#/id",
    "doc://..%2F/../pricing#trial",
  ])("rejects %s", async (uri) => {
    const { root } = corpus();
    expect(() => resolve(root, uri)).toThrow(InvalidEvidenceUriError);
  });

  it("rejects a symlink that points outside its source", async () => {
    const { root } = corpus();
    const outside = mkdtempSync(join(tmpdir(), "knowledge-outside-"));
    onTestFinished(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "secret.env"), "TOKEN=x\n");
    symlinkSync(join(outside, "secret.env"), join(root, "repo/leak.ts"));
    expect(() => resolve(root, "repo://leak.ts#L1-L1")).toThrow(
      InvalidEvidenceUriError,
    );
  });

  it("an updater override outside the corpus becomes a review, not a read", async () => {
    const { root, sc } = corpus();
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const draft = await reconcile(
      root,
      pageOf(root),
      sc,
      answering("Fixed in 2.4.2.", ["repo://../../etc/hosts#L1-L1"]),
      { sourceRev: SHA },
    );
    expect(findOp(draft.ops, "sso-fixed-in")?.op).toBe("review");
  });
});

describe("ticket JSON pointers", () => {
  it("never resolve inherited properties", async () => {
    const { root } = corpus();
    expect(resolve(root, "ticket://SUP-12#/constructor")).toMatchObject({
      code: "gone",
    });
  });

  it("a ticket that is not valid JSON is missing evidence, not a crash", async () => {
    const { root } = corpus();
    writeFileSync(join(root, "tickets/SUP-12.json"), "{ not json");
    expect(resolve(root, "ticket://SUP-12#/resolution/fixedIn")).toMatchObject({
      code: "gone",
    });
  });

  it("decode ~1 and ~0", async () => {
    const { root } = corpus();
    writeFileSync(
      join(root, "tickets/SUP-13.json"),
      JSON.stringify({ "a/b": { "c~d": "escaped" } }),
    );
    expect(resolve(root, "ticket://SUP-13#/a~1b/c~0d")).toEqual({
      text: "escaped",
    });
  });
});

describe("third roborev pass", () => {
  it("an updater override naming a directory becomes a review, not a crash", async () => {
    const { root, sc } = corpus();
    mkdirSync(join(root, "repo/src"));
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const draft = await reconcile(
      root,
      pageOf(root),
      sc,
      answering("Fixed in 2.4.2.", ["repo://src#L1-L1"]),
      { sourceRev: SHA },
    );
    expect(findOp(draft.ops, "sso-fixed-in")?.op).toBe("review");
  });

  it("an approved retract is refused once its evidence is back", async () => {
    const { root, sc } = corpus();
    const ticket = join(root, "tickets/SUP-12.json");
    const original = readFileSync(ticket, "utf8");
    rmSync(ticket);
    const md = pageOf(root);
    const draft = await reconcile(root, md, sc, stubUpdater(), {
      sourceRev: SHA,
    });
    expect(findOp(draft.ops, "sso-fixed-in")?.op).toBe("retract");
    writeFileSync(ticket, original);
    expect(() =>
      applyDraft(
        root,
        md,
        sc,
        draft,
        draft.ops.map((o) => o.id),
      ),
    ).toThrow(/holds again/);
  });

  it.each([
    ["claim id", "p", "seat/price"],
    ["page", "billing faq", "seat-price"],
  ])(
    "a %s that cannot be keyed is refused at seed time",
    async (_n, page, id) => {
      const { root } = corpus();
      expect(() =>
        generateSidecar(root, page, "x", [
          { id, statement: "x", evidence: ["repo://billing.ts#L1-L1"] },
        ]),
      ).toThrow(InvalidOpKeyPartError);
    },
  );
});

describe("API follow-ups folded into #364", () => {
  it("an async updater (a real model client) is awaited", async () => {
    const { root, sc } = corpus();
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const llm: Updater = {
      calls: 0,
      async rework(items) {
        llm.calls++;
        await new Promise((r) => setTimeout(r, 1));
        return items.map((i) => ({
          id: i.claim.id,
          statement: "Fixed in 2.4.2.",
        }));
      },
    };
    const draft = await reconcile(root, pageOf(root), sc, llm, {
      sourceRev: SHA,
    });
    expect(draft.llmCalls).toBe(1);
    expect(findOp(draft.ops, "sso-fixed-in")).toMatchObject({
      op: "update",
      after: "Fixed in 2.4.2.",
    });
  });

  it("an update applies to a sentence a formatter re-wrapped", async () => {
    const { root, sc } = corpus();
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const wrapped = pageOf(root).replace(
      "The SSO loop was fixed in version 2.4.1.",
      "The SSO loop was fixed\nin  version 2.4.1.",
    );
    const page = { ...sc, pageVersion: sha256(wrapped) };
    const draft = await reconcile(root, wrapped, page, stubUpdater(), {
      sourceRev: SHA,
    });
    const op = findOp(draft.ops, "sso-fixed-in");
    expect(op?.op).toBe("update");
    const out = applyDraft(root, wrapped, page, draft, [op?.id ?? ""]);
    expect(out.md).toContain("The SSO loop was fixed in version 2.4.2.");
    expect(out.md).not.toContain("2.4.1.");
  });

  it("a re-wrapped second copy still counts as a duplicate", async () => {
    const { root, sc } = corpus();
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const md = `${pageOf(root)}\nThe SSO loop was\nfixed in version 2.4.1.\n`;
    const page = { ...sc, pageVersion: sha256(md) };
    const draft = await reconcile(root, md, page, stubUpdater(), {
      sourceRev: SHA,
    });
    expect(() =>
      applyDraft(
        root,
        md,
        page,
        draft,
        draft.ops.map((o) => o.id),
      ),
    ).toThrow(/more than once/);
  });
});

describe("claims without evidence", () => {
  it("are refused at seed time", async () => {
    const { root } = corpus();
    expect(() =>
      generateSidecar(root, "p", "x", [
        { id: "c", statement: "x", evidence: [] },
      ]),
    ).toThrow(UngroundedClaimError);
  });

  it("in a hand-built sidecar become a review, never a retract", async () => {
    const { root, sc } = corpus();
    const bare = withClaim(sc, "seat-price", (c) => ({ ...c, evidence: [] }));
    const draft = await reconcile(root, pageOf(root), bare, stubUpdater(), {
      sourceRev: SHA,
    });
    expect(findOp(draft.ops, "seat-price")?.op).toBe("review");
  });
});

describe("evidence URIs", () => {
  it("line anchors must satisfy 1 <= a <= b", async () => {
    const { root } = corpus();
    expect(() => resolve(root, "repo://billing.ts#L3-L2")).toThrow(
      InvalidEvidenceUriError,
    );
    expect(() => resolve(root, "repo://billing.ts#L0-L0")).toThrow(
      InvalidEvidenceUriError,
    );
  });
});
