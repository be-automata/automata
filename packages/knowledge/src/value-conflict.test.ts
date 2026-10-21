// ENG-04 (E4): a claim pinned to several sources raises a conflict when the values its sources state
// disagree, also when every source changed in the same merge. Without the value check a both-changed
// claim is "stale" and the model rewrites it, hiding that code says 30 while the docs say 21.
import { describe, expect, it } from "vitest";

import {
  applyDraft,
  generateSidecar,
  reconcile,
  stubUpdater,
  type DraftOp,
} from "./claims";
import {
  countingUpdater,
  edit,
  PAGE,
  pageOf,
  SOURCE_SHA,
  useCorpus,
} from "./test-fixtures";

const opOf = (ops: DraftOp[], claimId: string) =>
  ops.find((o) => o.claimId === claimId);

/** Code and marketing both change the trial, to `code` and `docs` days respectively. */
function changeTrial(root: string, code: string, docs: string): void {
  edit(root, "repo/billing.ts", (s) =>
    s.replace("TRIAL_DAYS = 14;", `TRIAL_DAYS = ${code};`),
  );
  edit(root, "docs/pricing.md", (s) =>
    s.replace("14-day free trial", `${docs}-day free trial`),
  );
}

describe("value-aware conflicts (ENG-04 / E4)", () => {
  it("both sources changed to different values: a conflict with per-source values and zero model calls", async () => {
    const { root, sc } = useCorpus();
    changeTrial(root, "30", "21");
    const { llm, seen } = countingUpdater();
    const draft = await reconcile(root, pageOf(root), sc, llm, {
      sourceRev: SOURCE_SHA,
    });
    const op = opOf(draft.ops, "trial-length");
    expect(op).toMatchObject({
      op: "conflict",
      auto: false,
      sourceValues: [
        { uri: "repo://billing.ts#L1-L1", values: ["30"] },
        { uri: "doc://pricing#trial", values: ["21"] },
      ],
    });
    expect(op?.after).toBeUndefined();
    expect(op?.why).toContain("repo://billing.ts#L1-L1 says 30");
    expect(op?.why).toContain("doc://pricing#trial says 21");
    expect(draft.llmCalls).toBe(0);
    expect(seen).not.toContain("trial-length");
  });

  it("both sources changed to the same value: the batched model update, as before", async () => {
    const { root, sc } = useCorpus();
    changeTrial(root, "30", "30");
    const draft = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    expect(opOf(draft.ops, "trial-length")).toMatchObject({
      op: "update",
      after: "Trials last 30 days and need no card.",
    });
    expect(opOf(draft.ops, "trial-length")?.sourceValues).toBeUndefined();
    expect(draft.llmCalls).toBe(1);
  });

  it("one source changed, the other holds: the structural conflict is unchanged (no sourceValues)", async () => {
    const { root, sc } = useCorpus();
    edit(root, "repo/billing.ts", (s) =>
      s.replace("TRIAL_DAYS = 14;", "TRIAL_DAYS = 30;"),
    );
    const draft = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    const op = opOf(draft.ops, "trial-length");
    expect(op?.op).toBe("conflict");
    expect(op).not.toHaveProperty("sourceValues");
    expect(op?.why).toBe(
      "sources that agreed now disagree; the owner of the out-of-date one must decide",
    );
    expect(draft.llmCalls).toBe(0);
  });

  it("incidental tokens (ticket ids, identifier digits) do not create a conflict", async () => {
    const { root, sc } = useCorpus();
    changeTrial(root, "30; // see SUP-12 v2", "30");
    const draft = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    expect(opOf(draft.ops, "trial-length")?.op).toBe("update");
    expect(draft.llmCalls).toBe(1);
  });

  it("a superset agrees: {35, 4} and {4} are comparable, so the claim is updated, not conflicted", async () => {
    const { root } = useCorpus();
    const sc = generateSidecar(root, PAGE, pageOf(root), [
      {
        id: "seat-price",
        statement:
          "Each seat costs $29 per month; workspaces get 3 free seats.",
        evidence: ["repo://billing.ts#L2-L3", "repo://billing.ts#L3-L3"],
      },
    ]);
    edit(root, "repo/billing.ts", (s) =>
      s
        .replace("SEAT_PRICE_USD = 29;", "SEAT_PRICE_USD = 35;")
        .replace("MAX_SEATS_FREE = 3;", "MAX_SEATS_FREE = 4;"),
    );
    const draft = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    expect(opOf(draft.ops, "seat-price")?.op).toBe("update");
    expect(draft.llmCalls).toBe(1);
  });

  it("the extractor is injectable: one that finds no values sends the claim to the model", async () => {
    const { root, sc } = useCorpus();
    changeTrial(root, "30", "21");
    const draft = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
      extractValues: () => [],
    });
    expect(opOf(draft.ops, "trial-length")?.op).toBe("update");
    expect(draft.llmCalls).toBe(1);
  });

  it("an injected extractor replaces the default one", async () => {
    const { root, sc } = useCorpus();
    changeTrial(root, "30", "30");
    const draft = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
      extractValues: (text) => [text.includes("TRIAL_DAYS") ? "code" : "doc"],
    });
    expect(opOf(draft.ops, "trial-length")).toMatchObject({
      op: "conflict",
      sourceValues: [
        { uri: "repo://billing.ts#L1-L1", values: ["code"] },
        { uri: "doc://pricing#trial", values: ["doc"] },
      ],
    });
    expect(draft.llmCalls).toBe(0);
  });

  it("single-pin claims are never value-checked", async () => {
    const { root, sc } = useCorpus();
    edit(root, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"'));
    const draft = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    expect(opOf(draft.ops, "sso-fixed-in")?.op).toBe("update");
    expect(draft.llmCalls).toBe(1);
  });

  it("an approved value conflict leaves the page and the sidecar unchanged", async () => {
    const { root, sc } = useCorpus();
    changeTrial(root, "30", "21");
    const md = pageOf(root);
    const draft = await reconcile(root, md, sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    const op = opOf(draft.ops, "trial-length");
    expect(op?.op).toBe("conflict");
    const out = applyDraft(root, md, sc, draft, op ? [op.id] : []);
    expect(out.md).toBe(md);
    expect(out.sc).toEqual(sc);
  });
});
